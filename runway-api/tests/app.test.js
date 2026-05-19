import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';

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
});
