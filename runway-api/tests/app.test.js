import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { RunwayDatabase } from '../src/db.js';

describe('app frontend and auth', () => {
  it('serves the Chinese admin console, exposes models, and protects task routes', async () => {
    const app = await buildApp({
      config: { internalApiKey: 'secret', uploadDir: '/tmp/runway-api-test-uploads' },
      db: {
        getAdminConfig: () => ({ username: 'admin', password: 'admin', api_key: 'secret' }),
        getSession: () => null,
        getCredentialStatus: () => ({ ready: false }),
        getAccountSummary: () => ({ total: 0, active: 0, ready: 0, inflight: 0, pendingTasks: 0 }),
        listTasks: () => [],
        close: () => {}
      },
      browser: {
        status: () => ({ started: false, pages: 0, headless: true }),
        close: async () => {}
      },
      worker: {
        start: () => {},
        stop: async () => {}
      },
      logger: false
    });

    const page = await app.inject({ method: 'GET', url: '/' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('Runway API 管理后台');
    expect(page.body).toContain('taskForm');

    const publicModels = await app.inject({ method: 'GET', url: '/models' });
    expect(publicModels.statusCode).toBe(200);
    expect(JSON.parse(publicModels.body).models.length).toBeGreaterThan(0);

    const v1Models = await app.inject({ method: 'GET', url: '/v1/models' });
    expect(v1Models.statusCode).toBe(200);
    expect(JSON.parse(v1Models.body)).toMatchObject({
      object: 'list',
      data: expect.arrayContaining([
        expect.objectContaining({ id: 'seedance_2', object: 'model', owned_by: 'runway' })
      ])
    });

    const unauthorized = await app.inject({ method: 'GET', url: '/tasks' });
    expect(unauthorized.statusCode).toBe(401);

    const authorized = await app.inject({ method: 'GET', url: '/tasks', headers: { authorization: 'Bearer secret' } });
    expect(authorized.statusCode).toBe(200);
    expect(JSON.parse(authorized.body).tasks).toEqual([]);

    await app.close();
  });
});

describe('account admin API', () => {
  it('returns account secrets for detail editing and caches Runway credits', async () => {
    const account = {
      id: 'account-1',
      name: '账号一',
      jwt: 'jwt-secret',
      cookieHeader: 'session=abc',
      hasJwt: true,
      hasCookie: true,
      teamId: 1,
      assetGroupId: 'asset',
      isActive: true,
      maxConcurrent: 2,
      generationLimit: 80,
      generationUsed: 0,
      proxyStrategy: 'fixed'
    };
    const updateAccountCredits = vi.fn((id, credits) => ({ ...account, runwayCredits: credits, runwayCreditsCheckedAt: credits.queriedAt }));
    const app = await buildApp({
      config: { internalApiKey: 'secret', uploadDir: '/tmp/runway-api-test-uploads' },
      db: {
        getAdminConfig: () => ({ username: 'admin', password: 'admin', api_key: 'secret' }),
        getSession: () => null,
        getAccount: (id) => (id === account.id ? account : null),
        getAccountSummary: () => ({ total: 1, active: 1, ready: 1, inflight: 0, pendingTasks: 0 }),
        getRuntimeConfig: () => ({ queueLeaseTimeoutMs: 120000 }),
        getQueueSummary: () => ({ pending: 0, leased: 0, stale: 0, failed: 0 }),
        getProxySummary: () => ({ total: 0, active: 0 }),
        listAccounts: () => [account],
        listTasks: () => [],
        updateAccountCredits,
        close: () => {}
      },
      browser: {
        status: () => ({ started: false, pages: 0, headless: true }),
        close: async () => {}
      },
      worker: {
        start: () => {},
        stop: async () => {}
      },
      runway: {
        getAccountCredits: vi.fn(async () => ({ queriedAt: '2026-05-19T00:00:00.000Z', remainingCredits: 12, usedCredits: 3 }))
      },
      logger: false
    });

    const detail = await app.inject({ method: 'GET', url: '/api/accounts/account-1', headers: { authorization: 'Bearer secret' } });
    expect(detail.statusCode).toBe(200);
    expect(JSON.parse(detail.body).account).toMatchObject({ jwt: 'jwt-secret', cookieHeader: 'session=abc' });

    const credits = await app.inject({ method: 'GET', url: '/api/accounts/account-1/runway-credits', headers: { authorization: 'Bearer secret' } });
    expect(credits.statusCode).toBe(200);
    expect(JSON.parse(credits.body).credits).toMatchObject({ remainingCredits: 12, usedCredits: 3 });
    expect(updateAccountCredits).toHaveBeenCalledWith('account-1', expect.objectContaining({ remainingCredits: 12 }));

    await app.close();
  });

  it('imports exported, single-object, duplicate-id, and partially invalid account files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-api-app-test-'));
    const db = new RunwayDatabase(path.join(dir, 'test.sqlite'), { adminUsername: 'admin', adminPassword: 'admin', internalApiKey: 'secret' });
    const existing = db.createAccount({
      id: 'same-id',
      name: '已有账号',
      jwt: 'old',
      teamId: 1,
      assetGroupId: 'old-asset'
    });
    const app = await buildApp({
      config: { internalApiKey: 'secret', uploadDir: path.join(dir, 'uploads') },
      db,
      browser: {
        status: () => ({ started: false, pages: 0, headless: true }),
        close: async () => {}
      },
      worker: {
        start: () => {},
        stop: async () => {}
      },
      logger: false
    });

    const single = await app.inject({
      method: 'POST',
      url: '/api/accounts/import',
      headers: { authorization: 'Bearer secret' },
      payload: {
        id: existing.id,
        name: '导入账号',
        authorization: 'Authorization: Bearer new-jwt',
        cookie: 'Cookie: session=abc',
        team_id: 2,
        asset_group_id: 'asset-2',
        client_id: 'client-2',
        sourceVersion: 'web-version',
        isActive: false
      }
    });
    expect(single.statusCode).toBe(200);
    const singleBody = JSON.parse(single.body);
    expect(singleBody.imported).toBe(1);
    expect(singleBody.accounts[0]).toMatchObject({
      name: '导入账号',
      hasJwt: true,
      hasCookie: true,
      teamId: 2,
      assetGroupId: 'asset-2',
      clientId: 'client-2',
      sourceApplicationVersion: 'web-version',
      isActive: false
    });
    expect(singleBody.accounts[0].id).not.toBe(existing.id);

    const mixed = await app.inject({
      method: 'POST',
      url: '/api/accounts/import',
      headers: { authorization: 'Bearer secret' },
      payload: {
        accounts: [
          {
            accountName: '嵌套凭证',
            credentials: {
              jwt: 'nested-jwt',
              cookieHeader: 'a=b',
              teamId: 3,
              assetGroupId: 'asset-3'
            }
          },
          'not-an-account'
        ]
      }
    });
    expect(mixed.statusCode).toBe(200);
    const mixedBody = JSON.parse(mixed.body);
    expect(mixedBody.imported).toBe(1);
    expect(mixedBody.skipped).toBe(1);
    expect(mixedBody.errors[0].message).toContain('不是有效对象');
    expect(db.listAccounts()).toHaveLength(3);

    await app.close();
  });
});

describe('OpenAI compatible video API', () => {
  it('creates and reads video jobs through /v1/videos routes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-api-v1-test-'));
    const db = new RunwayDatabase(path.join(dir, 'test.sqlite'), { internalApiKey: 'secret' });
    const app = await buildApp({
      config: { internalApiKey: 'secret', uploadDir: path.join(dir, 'uploads') },
      db,
      browser: {
        status: () => ({ started: false, pages: 0, headless: true }),
        close: async () => {}
      },
      worker: {
        start: () => {},
        stop: async () => {}
      },
      logger: false
    });

    const unauthorized = await app.inject({
      method: 'POST',
      url: '/v1/videos',
      payload: { model: 'seedance_2', prompt: 'hello' }
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(JSON.parse(unauthorized.body)).toMatchObject({
      error: { code: 'unauthorized', type: 'invalid_request_error' }
    });

    const created = await app.inject({
      method: 'POST',
      url: '/v1/videos',
      headers: { authorization: 'Bearer secret' },
      payload: {
        model: 'seedance_2',
        input: 'a calm product video',
        duration: 5,
        resolution: '480p',
        aspectRatio: '16:9'
      }
    });
    expect(created.statusCode).toBe(202);
    const body = JSON.parse(created.body);
    expect(body).toMatchObject({
      object: 'video',
      model: 'seedance_2',
      status: 'queued',
      metadata: {
        prompt: 'a calm product video',
        duration: 5,
        resolution: '480p',
        aspect_ratio: '16:9'
      }
    });

    const detail = await app.inject({
      method: 'GET',
      url: `/v1/videos/${body.id}`,
      headers: { authorization: 'Bearer secret' }
    });
    expect(detail.statusCode).toBe(200);
    expect(JSON.parse(detail.body)).toMatchObject({ id: body.id, object: 'video' });

    const list = await app.inject({
      method: 'GET',
      url: '/v1/videos',
      headers: { authorization: 'Bearer secret' }
    });
    expect(list.statusCode).toBe(200);
    expect(JSON.parse(list.body)).toMatchObject({
      object: 'list',
      data: [expect.objectContaining({ id: body.id, object: 'video' })]
    });

    const events = await app.inject({
      method: 'GET',
      url: `/v1/videos/${body.id}/events`,
      headers: { authorization: 'Bearer secret' }
    });
    expect(events.statusCode).toBe(200);
    expect(JSON.parse(events.body)).toMatchObject({
      object: 'list',
      data: [expect.objectContaining({ type: 'queued' })]
    });

    const alias = await app.inject({
      method: 'GET',
      url: `/v1/videos/generations/${body.id}`,
      headers: { authorization: 'Bearer secret' }
    });
    expect(alias.statusCode).toBe(200);
    expect(JSON.parse(alias.body)).toMatchObject({ id: body.id, object: 'video.generation' });

    await app.close();
  });

  it('downloads reference media URLs before queueing /v1/videos jobs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-api-url-test-'));
    const uploadDir = path.join(dir, 'uploads');
    const db = new RunwayDatabase(path.join(dir, 'test.sqlite'), { internalApiKey: 'secret' });
    const mediaServer = http.createServer((request, response) => {
      if (request.url === '/reference.png') {
        response.writeHead(200, { 'Content-Type': 'image/png' });
        response.end(Buffer.from('89504e470d0a1a0a', 'hex'));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise((resolve) => mediaServer.listen(0, '127.0.0.1', resolve));
    const mediaUrl = `http://127.0.0.1:${mediaServer.address().port}/reference.png`;
    const app = await buildApp({
      config: { internalApiKey: 'secret', uploadDir },
      db,
      browser: {
        status: () => ({ started: false, pages: 0, headless: true }),
        close: async () => {}
      },
      worker: {
        start: () => {},
        stop: async () => {}
      },
      logger: false
    });

    const created = await app.inject({
      method: 'POST',
      url: '/v1/videos',
      headers: { authorization: 'Bearer secret' },
      payload: {
        model: 'seedance_2',
        input: 'use url reference',
        media_urls: [mediaUrl]
      }
    });
    expect(created.statusCode).toBe(202);
    const task = JSON.parse(created.body);
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/videos/${task.id}`,
      headers: { authorization: 'Bearer secret' }
    });
    const assets = JSON.parse(detail.body).metadata.assets;
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      filename: 'reference.png',
      mime_type: 'image/png',
      media_type: 'image',
      size: 8
    });

    await app.close();
    await new Promise((resolve) => mediaServer.close(resolve));
  });

  it('accepts named references for @ prompt usage', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-api-at-ref-test-'));
    const uploadDir = path.join(dir, 'uploads');
    const db = new RunwayDatabase(path.join(dir, 'test.sqlite'), { internalApiKey: 'secret' });
    const mediaServer = http.createServer((request, response) => {
      if (request.url === '/cat.png') {
        response.writeHead(200, { 'Content-Type': 'image/png' });
        response.end(Buffer.from('89504e470d0a1a0a', 'hex'));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise((resolve) => mediaServer.listen(0, '127.0.0.1', resolve));
    const mediaUrl = `http://127.0.0.1:${mediaServer.address().port}/cat.png`;
    const app = await buildApp({
      config: { internalApiKey: 'secret', uploadDir },
      db,
      browser: {
        status: () => ({ started: false, pages: 0, headless: true }),
        close: async () => {}
      },
      worker: {
        start: () => {},
        stop: async () => {}
      },
      logger: false
    });

    const created = await app.inject({
      method: 'POST',
      url: '/v1/videos',
      headers: { authorization: 'Bearer secret' },
      payload: {
        model: 'seedance_2',
        input: 'Use @主体 as the main subject',
        references: [{ name: '主体', url: mediaUrl }]
      }
    });
    expect(created.statusCode).toBe(202);
    const task = JSON.parse(created.body);
    const assets = JSON.parse((await app.inject({
      method: 'GET',
      url: `/v1/videos/${task.id}`,
      headers: { authorization: 'Bearer secret' }
    })).body).metadata.assets;
    expect(assets[0]).toMatchObject({
      filename: '主体.png',
      mime_type: 'image/png',
      media_type: 'image'
    });

    await app.close();
    await new Promise((resolve) => mediaServer.close(resolve));
  });
});
