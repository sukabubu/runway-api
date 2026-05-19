import { describe, expect, it } from 'vitest';
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
