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
    expect(page.body).toContain('updateProject');

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

  it('allows reading system version but requires admin session for project updates', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-api-system-test-'));
    const db = new RunwayDatabase(path.join(dir, 'test.sqlite'), { adminUsername: 'admin', adminPassword: 'admin', internalApiKey: 'secret' });
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

    const version = await app.inject({
      method: 'GET',
      url: '/api/system/version',
      headers: { authorization: 'Bearer secret' }
    });
    expect(version.statusCode).toBe(200);
    expect(JSON.parse(version.body)).toHaveProperty('branch');

    const apiKeyUpdate = await app.inject({
      method: 'POST',
      url: '/api/system/update',
      headers: { authorization: 'Bearer secret' }
    });
    expect(apiKeyUpdate.statusCode).toBe(403);

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

    const withoutClientId = await app.inject({
      method: 'POST',
      url: '/api/accounts/import',
      headers: { authorization: 'Bearer secret' },
      payload: {
        name: 'clientId 异常账号',
        authorization: 'Bearer no-client-jwt',
        cookieHeader: 'session=no-client',
        teamId: 3,
        client: { unexpected: true }
      }
    });
    expect(withoutClientId.statusCode).toBe(200);
    const withoutClientIdBody = JSON.parse(withoutClientId.body);
    expect(withoutClientIdBody.imported).toBe(1);
    expect(withoutClientIdBody.accounts[0]).toMatchObject({
      name: 'clientId 异常账号',
      ready: true,
      clientId: null
    });

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
    expect(db.listAccounts()).toHaveLength(4);

    await app.close();
  });

  it('imports accounts from the browser extension endpoint', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-api-extension-import-test-'));
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
      url: '/api/plugin/accounts/import',
      payload: { accounts: [] }
    });
    expect(unauthorized.statusCode).toBe(401);

    const imported = await app.inject({
      method: 'POST',
      url: '/api/plugin/accounts/import',
      headers: {
        authorization: 'Bearer secret',
        origin: 'chrome-extension://extension-id'
      },
      payload: {
        accounts: [{
          name: '插件账号',
          authorization: 'Bearer plugin-jwt',
          cookieHeader: 'session=plugin',
          teamId: 9,
          clientId: 'client-plugin',
          sourceApplicationVersion: 'source-plugin'
        }]
      }
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.headers['access-control-allow-origin']).toBe('*');
    const body = JSON.parse(imported.body);
    expect(body.imported).toBe(1);
    expect(body.accounts[0]).toMatchObject({
      name: '插件账号',
      hasJwt: true,
      hasCookie: true,
      teamId: 9,
      ready: true
    });

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
        prompt: 'a calm product video',
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

    const cancelled = await app.inject({
      method: 'POST',
      url: `/v1/videos/${body.id}/cancel`,
      headers: { authorization: 'Bearer secret' }
    });
    expect(cancelled.statusCode).toBe(200);
    expect(JSON.parse(cancelled.body)).toMatchObject({
      id: body.id,
      status: 'cancelled',
      error: { code: 'USER_CANCELLED' }
    });

    await app.close();
  });

  it('refreshes completed task signed video URLs on task detail reads', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-api-signed-url-test-'));
    const db = new RunwayDatabase(path.join(dir, 'test.sqlite'), { internalApiKey: 'secret' });
    const mediaServer = http.createServer((request, response) => {
      if (request.url === '/video-v1.mp4') {
        response.writeHead(200, { 'Content-Type': 'video/mp4' });
        response.end('VIDEO_V1');
        return;
      }
      if (request.url === '/video-content.mp4') {
        response.writeHead(200, { 'Content-Type': 'video/mp4' });
        response.end('VIDEO_CONTENT');
        return;
      }
      if (request.url === '/video-tasks.mp4') {
        response.writeHead(200, { 'Content-Type': 'video/mp4' });
        response.end('VIDEO_TASKS');
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise((resolve) => mediaServer.listen(0, '127.0.0.1', resolve));
    const mediaBaseUrl = `http://127.0.0.1:${mediaServer.address().port}`;
    const account = db.createAccount({
      name: '账号',
      jwt: 'jwt-old',
      cookieHeader: 'session=abc',
      teamId: 1
    });
    db.createTask({
      id: 'completed-task',
      accountId: account.id,
      runwayTaskId: 'runway-task',
      status: 'completed',
      rawStatus: 'SUCCEEDED',
      prompt: 'hello',
      model: 'seedance_2',
      duration: 5,
      resolution: '480p',
      aspectRatio: '16:9',
      generateAudio: true,
      exploreMode: true,
      progress: 100,
      videoUrl: 'https://signed.example/old',
      thumbnailUrl: 'https://signed.example/old-thumb',
      submittedAt: new Date().toISOString(),
      completedAt: new Date().toISOString()
    });
    const pollTask = vi.fn()
      .mockResolvedValueOnce({
        taskId: 'runway-task',
        status: 'completed',
        rawStatus: 'SUCCEEDED',
        progress: 100,
        videoUrl: `${mediaBaseUrl}/video-v1.mp4`,
        thumbnailUrl: `${mediaBaseUrl}/thumb-v1.jpg`,
        rawResponse: { task: { id: 'runway-task' } }
      })
      .mockResolvedValueOnce({
        taskId: 'runway-task',
        status: 'completed',
        rawStatus: 'SUCCEEDED',
        progress: 100,
        videoUrl: `${mediaBaseUrl}/video-content.mp4`,
        thumbnailUrl: `${mediaBaseUrl}/thumb-content.jpg`,
        rawResponse: { task: { id: 'runway-task' } }
      })
      .mockResolvedValueOnce({
        taskId: 'runway-task',
        status: 'completed',
        rawStatus: 'SUCCEEDED',
        progress: 100,
        videoUrl: `${mediaBaseUrl}/video-tasks.mp4`,
        thumbnailUrl: `${mediaBaseUrl}/thumb-tasks.jpg`,
        rawResponse: { task: { id: 'runway-task' } }
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
      runway: { pollTask },
      logger: false
    });

    const v1Detail = await app.inject({
      method: 'GET',
      url: '/v1/videos/completed-task',
      headers: { authorization: 'Bearer secret' }
    });
    expect(v1Detail.statusCode).toBe(200);
    const v1Body = JSON.parse(v1Detail.body);
    expect(v1Body.video_url).toContain('/v1/videos/completed-task/content?');
    expect(v1Body.thumbnail_url).toContain('/v1/videos/completed-task/thumbnail?');
    expect(v1Body.video_url).not.toContain(mediaBaseUrl);

    const contentUrl = new URL(v1Body.video_url);
    const content = await app.inject({
      method: 'GET',
      url: `${contentUrl.pathname}${contentUrl.search}`
    });
    expect(content.statusCode).toBe(200);
    expect(content.headers['content-type']).toContain('video/mp4');
    expect(content.body).toBe('VIDEO_CONTENT');

    const taskDetail = await app.inject({
      method: 'GET',
      url: '/tasks/completed-task',
      headers: { authorization: 'Bearer secret' }
    });
    expect(taskDetail.statusCode).toBe(200);
    const taskBody = JSON.parse(taskDetail.body);
    expect(taskBody.videoUrl).toContain('/v1/videos/completed-task/content?');
    expect(taskBody.thumbnailUrl).toContain('/v1/videos/completed-task/thumbnail?');
    expect(taskBody.videoUrl).not.toContain(mediaBaseUrl);
    expect(taskBody.rawResponse).toBeUndefined();
    expect(db.getTask('completed-task').videoUrl).toBe(`${mediaBaseUrl}/video-tasks.mp4`);
    expect(pollTask).toHaveBeenCalledTimes(3);
    expect(pollTask).toHaveBeenCalledWith('runway-task', expect.objectContaining({
      account: expect.objectContaining({ id: account.id }),
      operation: 'task_signed_url_refresh'
    }));

    await app.close();
    await new Promise((resolve) => mediaServer.close(resolve));
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
        prompt: 'use url reference',
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
      filename: 'IMG_1.png',
      mime_type: 'image/png',
      media_type: 'image',
      size: 8
    });

    await app.close();
    await new Promise((resolve) => mediaServer.close(resolve));
  });

  it('assigns ordered Runway-style aliases to unnamed image and video references', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-api-ordered-ref-test-'));
    const uploadDir = path.join(dir, 'uploads');
    const db = new RunwayDatabase(path.join(dir, 'test.sqlite'), { internalApiKey: 'secret' });
    const mediaServer = http.createServer((request, response) => {
      if (request.url === '/first.png' || request.url === '/second.png') {
        response.writeHead(200, { 'Content-Type': 'image/png' });
        response.end(Buffer.from('89504e470d0a1a0a', 'hex'));
        return;
      }
      if (request.url === '/motion.mp4') {
        response.writeHead(200, { 'Content-Type': 'video/mp4' });
        response.end(Buffer.from('00000018667479706d703432', 'hex'));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise((resolve) => mediaServer.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${mediaServer.address().port}`;
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
        prompt: 'Use @IMG_1 as subject, @IMG_2 as style, @VID_1 as motion',
        media_urls: [`${baseUrl}/first.png`, `${baseUrl}/motion.mp4`, `${baseUrl}/second.png`]
      }
    });
    expect(created.statusCode).toBe(202);
    const task = JSON.parse(created.body);
    const assets = JSON.parse((await app.inject({
      method: 'GET',
      url: `/v1/videos/${task.id}`,
      headers: { authorization: 'Bearer secret' }
    })).body).metadata.assets;
    expect(assets.map((asset) => asset.filename)).toEqual(['IMG_1.png', 'VID_1.mp4', 'IMG_2.png']);

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
        prompt: 'Use @主体 as the main subject',
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
