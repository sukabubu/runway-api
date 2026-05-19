import fs from 'node:fs';
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
        sourceVersion: 'web-version'
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
      sourceApplicationVersion: 'web-version'
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
