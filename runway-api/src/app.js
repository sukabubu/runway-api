import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { RUNWAY_MODELS, normalizeTaskInput } from './runway/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const publicDir = path.resolve(__dirname, '../public');
const execFileAsync = promisify(execFile);

export async function buildApp({ config, db, browser, worker, proxyManager = null, runway = null, systemUpdater = updateFromRemote, logger }) {
  const app = Fastify({ logger });
  await app.register(multipart, {
    limits: {
      files: 15,
      fileSize: 200 * 1024 * 1024,
      fields: 40
    }
  });

  app.addHook('preHandler', async (request, reply) => {
    const pathname = request.url.split('?')[0];
    if (pathname.startsWith('/api/')) setExtensionCorsHeaders(reply);
    if (request.method === 'OPTIONS' && pathname.startsWith('/api/')) {
      return reply.code(204).send();
    }
    if (isPublicRoute(pathname)) return;
    if (pathname.startsWith('/api/') || pathname.startsWith('/auth/') || pathname.startsWith('/admin/')) {
      const auth = getRequestAuth(request);
      if (hasAdminSession(request) || auth?.type === 'admin') {
        request.auth = { type: 'admin', poolId: null };
        return;
      }
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (pathname.startsWith('/v1/') && pathname !== '/v1/models') {
      if (isVideoContentRoute(pathname) && hasValidVideoAccessToken(request, pathname)) return;
      const auth = getRequestAuth(request);
      if (hasAdminSession(request)) {
        request.auth = { type: 'admin', poolId: null };
        return;
      }
      if (auth) {
        request.auth = auth;
        return;
      }
      return reply.code(401).send(pathname.startsWith('/v1/') ? toV1Error('unauthorized', '未登录或 API Key 不正确。') : { error: 'unauthorized' });
    }
    if (pathname.startsWith('/tasks')) {
      const auth = getRequestAuth(request);
      if (auth || hasAdminSession(request)) {
        request.auth = auth || { type: 'admin', poolId: null };
        return;
      }
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.get('/', async (request, reply) => servePublic(reply, 'index.html', 'text/html; charset=utf-8'));
  app.get('/app.js', async (request, reply) => servePublic(reply, 'app.js', 'text/javascript; charset=utf-8'));
  app.get('/styles.css', async (request, reply) => servePublic(reply, 'styles.css', 'text/css; charset=utf-8'));
  app.options('/api/*', async (request, reply) => reply.code(204).send());

  app.get('/health', async () => ({
    ok: true,
    database: true,
    browser: browser.status(),
    accounts: db.getAccountSummary(),
    queue: db.getQueueSummary({ leaseMs: db.getRuntimeConfig().queueLeaseTimeoutMs }),
    proxies: db.getProxySummary(),
    recentAuthFailures: db.getRecentAuthFailedAccounts?.() || []
  }));

  app.get('/models', async () => ({ models: RUNWAY_MODELS }));
  app.get('/v1/models', async () => ({
    object: 'list',
    data: RUNWAY_MODELS.map(toV1Model)
  }));

  app.post('/admin/login', async (request, reply) => {
    const cfg = db.getAdminConfig();
    const { username, password } = request.body || {};
    if (username !== cfg.username || password !== cfg.password) {
      return reply.code(401).send({ error: 'invalid_credentials', message: '用户名或密码不正确' });
    }
    const session = db.createSession();
    reply.header('Set-Cookie', serializeCookie('runway_admin_session', session.id, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 24 * 60 * 60
    }));
    return { ok: true, username: cfg.username };
  });

  app.post('/admin/logout', async (request, reply) => {
    const sessionId = getCookie(request.headers.cookie, 'runway_admin_session');
    if (sessionId) db.deleteSession(sessionId);
    reply.header('Set-Cookie', serializeCookie('runway_admin_session', '', {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 0
    }));
    return { ok: true };
  });

  app.get('/admin/me', async (request) => {
    const session = getAdminSession(request);
    const cfg = db.getAdminConfig();
    return {
      authenticated: Boolean(session),
      username: session ? cfg.username : null,
      apiKeyConfigured: Boolean(cfg.api_key)
    };
  });

  app.get('/api/config', async () => {
    const cfg = db.getAdminConfig();
    return { username: cfg.username, apiKey: cfg.api_key };
  });

  app.put('/api/config', async (request) => {
    const updated = db.updateAdminConfig(request.body || {});
    return { username: updated.username, apiKey: updated.api_key };
  });

  app.get('/api/system/version', async () => getGitVersion());

  app.post('/api/system/update', async (request, reply) => {
    if (!hasAdminSession(request)) return reply.code(403).send({ error: 'admin_session_required', message: '项目更新只允许后台登录会话操作。' });
    return systemUpdater({ config });
  });

  app.get('/api/accounts', async () => ({
    accounts: db.listAccounts(),
    summary: db.getAccountSummary()
  }));

  app.get('/api/account-pools', async () => ({
    pools: db.listAccountPools({ includeSecret: true })
  }));

  app.post('/api/account-pools', async (request) => ({
    pool: db.createAccountPool(request.body || {})
  }));

  app.put('/api/account-pools/:id', async (request, reply) => {
    const pool = db.updateAccountPool(request.params.id, request.body || {});
    if (!pool) return reply.code(404).send({ error: 'pool not found' });
    return { pool };
  });

  app.delete('/api/account-pools/:id', async (request, reply) => {
    const deleted = db.deleteAccountPool(request.params.id);
    if (!deleted) return reply.code(404).send({ error: 'pool not found' });
    return { ok: true };
  });

  app.post('/api/accounts/login-browser', async (request) => {
    const body = request.body || {};
    const account = db.createAccount({
      name: body.name || `网页登录 ${new Date().toLocaleString('zh-CN')}`,
      poolId: body.poolId,
      remark: body.remark || '等待网页登录抓取凭证',
      maxConcurrent: body.maxConcurrent || config.defaultAccountConcurrency,
      proxyId: body.proxyId,
      proxyStrategy: body.proxyStrategy,
      generationLimit: body.generationLimit,
      isActive: 1
    });
    const opened = await browser.openRunway(account.id);
    db.logRequest({ accountId: account.id, operation: 'browser_login', status: 'opened', message: opened.url });
    return { account: hideSecret(account), opened };
  });

  app.post('/api/accounts/:id/open-login', async (request) => {
    const account = db.getAccount(request.params.id);
    if (!account) {
      const err = new Error('account not found');
      err.statusCode = 404;
      throw err;
    }
    const opened = await browser.openRunway(request.params.id);
    db.logRequest({ accountId: request.params.id, operation: 'browser_login', status: 'opened', message: opened.url });
    return opened;
  });

  app.post('/api/accounts/manual', async (request) => {
    const body = request.body || {};
    const jwt = normalizeBearerToken(body.authorization || body.jwt);
    const account = db.createAccount({
      name: body.name || '手动账号',
      poolId: body.poolId,
      remark: body.remark || null,
      jwt,
      cookieHeader: normalizeCookieHeader(body.cookieHeader || body.cookie),
      teamId: body.teamId,
      assetGroupId: body.assetGroupId,
      clientId: body.clientId,
      sourceApplicationVersion: body.sourceVersion || body.sourceApplicationVersion,
      maxConcurrent: body.maxConcurrent || config.defaultAccountConcurrency,
      proxyId: body.proxyId || null,
      proxyStrategy: body.proxyStrategy,
      generationLimit: body.generationLimit,
      requestTimeoutMs: body.requestTimeoutMs,
      uploadTimeoutMs: body.uploadTimeoutMs,
      taskTimeoutMs: body.taskTimeoutMs,
      maxRetries: body.maxRetries,
      isActive: body.isActive === false ? 0 : 1
    });
    db.logRequest({ accountId: account.id, operation: 'manual_account', status: 'saved', message: '手动保存账号凭证' });
    return { account: hideSecret(account) };
  });

  app.put('/api/accounts/:id', async (request, reply) => {
    const account = db.updateAccount(request.params.id, normalizeAccountPatch(request.body || {}));
    if (!account) return reply.code(404).send({ error: 'account not found' });
    return { account: hideSecret(account) };
  });

  app.post('/api/accounts/:id/enable', async (request, reply) => {
    const account = db.setAccountActive(request.params.id, true);
    if (!account) return reply.code(404).send({ error: 'account not found' });
    return { account: hideSecret(account) };
  });

  app.post('/api/accounts/:id/disable', async (request, reply) => {
    const account = db.setAccountActive(request.params.id, false);
    if (!account) return reply.code(404).send({ error: 'account not found' });
    return { account: hideSecret(account) };
  });

  app.delete('/api/accounts/:id', async (request, reply) => {
    const deleted = db.deleteAccount(request.params.id);
    if (!deleted) return reply.code(404).send({ error: 'account not found' });
    return { ok: true };
  });

  app.post('/api/accounts/:id/reset-generation-usage', async (request, reply) => {
    const account = db.resetAccountGenerationUsage(request.params.id);
    if (!account) return reply.code(404).send({ error: 'account not found' });
    db.logRequest({ accountId: account.id, operation: 'quota_reset', status: 'success', message: '已重置生成额度' });
    return { account: hideSecret(account) };
  });

  app.get('/api/accounts/:id/runway-credits', async (request, reply) => {
    if (!runway?.getAccountCredits) return reply.code(501).send({ error: 'runway client unavailable' });
    const account = db.getAccount(request.params.id, { includeSecret: true });
    if (!account) return reply.code(404).send({ error: 'account not found' });
    if (!(account.jwt || account.cookieHeader)) return reply.code(409).send({ error: 'account credentials not ready', message: '账号凭证未就绪，请先网页登录或手动粘贴 Cookie/Authorization' });
    const credits = await runway.getAccountCredits(account);
    db.updateAccountCredits?.(account.id, credits);
    return { account: hideSecret(db.getAccount(account.id)), credits };
  });

  app.post('/api/accounts/:id/refresh-jwt', async (request, reply) => {
    if (!runway?.refreshAccountJwt) return reply.code(501).send({ error: 'runway client unavailable' });
    const account = db.getAccount(request.params.id, { includeSecret: true });
    if (!account) return reply.code(404).send({ error: 'account not found' });
    if (!account.cookieHeader) return reply.code(409).send({ error: 'cookie not found', message: '账号没有 Cookie，无法自动刷新 JWT' });
    const refreshed = await runway.refreshAccountJwt(account);
    return { account: hideSecret(refreshed) };
  });

  app.post('/api/accounts/import', async (request) => {
    const input = extractImportItems(request.body, 'accounts', 'account');
    return importAccounts({ db, input, operation: 'account_import' });
  });

  app.post('/api/plugin/accounts/import', async (request) => {
    const input = extractImportItems(request.body, 'accounts', 'account');
    return importAccounts({ db, input, operation: 'plugin_account_import' });
  });

  app.get('/api/accounts/export', async () => ({
    accounts: db.listAccounts({ includeSecret: true }).map((account) => ({
      id: account.id,
      name: account.name,
      remark: account.remark,
      jwt: account.jwt,
      cookieHeader: account.cookieHeader,
      teamId: account.teamId,
      assetGroupId: account.assetGroupId,
      clientId: account.clientId,
      sourceApplicationVersion: account.sourceApplicationVersion,
      isActive: account.isActive,
      maxConcurrent: account.maxConcurrent,
      proxyId: account.proxyId,
      proxyStrategy: account.proxyStrategy,
      generationLimit: account.generationLimit,
      generationUsed: account.generationUsed,
      requestTimeoutMs: account.requestTimeoutMs,
      uploadTimeoutMs: account.uploadTimeoutMs,
      taskTimeoutMs: account.taskTimeoutMs,
      maxRetries: account.maxRetries,
      poolId: account.poolId,
      runwayCredits: account.runwayCredits,
      runwayCreditsCheckedAt: account.runwayCreditsCheckedAt
    }))
  }));

  app.get('/api/accounts/:id', async (request, reply) => {
    const account = db.getAccount(request.params.id, { includeSecret: true });
    if (!account) return reply.code(404).send({ error: 'account not found' });
    return { account };
  });

  app.get('/api/proxies', async () => ({ proxies: db.listProxies(), summary: db.getProxySummary() }));

  app.post('/api/proxies', async (request) => ({ proxy: db.createProxy(request.body || {}) }));

  app.put('/api/proxies/:id', async (request, reply) => {
    const proxy = db.updateProxy(request.params.id, request.body || {});
    if (!proxy) return reply.code(404).send({ error: 'proxy not found' });
    return { proxy };
  });

  app.post('/api/proxies/:id/enable', async (request, reply) => {
    const proxy = db.setProxyActive(request.params.id, true);
    if (!proxy) return reply.code(404).send({ error: 'proxy not found' });
    return { proxy };
  });

  app.post('/api/proxies/:id/disable', async (request, reply) => {
    const proxy = db.setProxyActive(request.params.id, false);
    if (!proxy) return reply.code(404).send({ error: 'proxy not found' });
    return { proxy };
  });

  app.delete('/api/proxies/:id', async (request, reply) => {
    const deleted = db.deleteProxy(request.params.id);
    if (!deleted) return reply.code(404).send({ error: 'proxy not found' });
    return { ok: true };
  });

  app.post('/api/proxies/:id/test', async (request, reply) => {
    const proxy = db.getProxy(request.params.id);
    if (!proxy) return reply.code(404).send({ error: 'proxy not found' });
    if (!proxyManager) return reply.code(501).send({ error: 'proxy manager unavailable' });
    try {
      const result = await proxyManager.testProxy(proxy);
      db.recordProxyUse(proxy.id);
      db.logRequest({ proxyId: proxy.id, operation: 'proxy_test', status: result.ok ? 'success' : 'failed', statusCode: result.statusCode, durationMs: result.durationMs, responseBody: result.body });
      return result;
    } catch (err) {
      db.recordProxyError(proxy.id, err.message);
      db.logRequest({ proxyId: proxy.id, operation: 'proxy_test', status: 'failed', message: err.message });
      return reply.code(502).send({ error: 'proxy_test_failed', message: err.message });
    }
  });

  app.post('/api/proxies/import', async (request) => {
    const input = extractImportItems(request.body, 'proxies', 'proxy');
    if (!input) {
      const err = new Error('proxies array or proxy object is required');
      err.statusCode = 400;
      throw err;
    }
    const proxies = [];
    const errors = [];
    for (const [index, item] of input.entries()) {
      try {
        proxies.push(db.createProxy(normalizeImportedProxy(item, index, db)));
      } catch (err) {
        errors.push({
          index,
          name: item && typeof item === 'object' ? item.name || item.id || item.url || null : String(item || ''),
          message: err.message || '导入失败'
        });
      }
    }
    return { proxies, imported: proxies.length, skipped: errors.length, errors };
  });

  app.get('/api/proxies/export', async () => ({ proxies: db.listProxies() }));

  app.get('/api/runtime-config', async () => db.getRuntimeConfig());

  app.put('/api/runtime-config', async (request) => db.updateRuntimeConfig(request.body || {}));

  app.get('/api/logs', async (request) => ({
    logs: db.listRequestLogs({ limit: request.query.limit })
  }));

  app.get('/api/logs/:id', async (request, reply) => {
    const log = db.getRequestLog(request.params.id);
    if (!log) return reply.code(404).send({ error: 'log not found' });
    return { log };
  });

  app.delete('/api/logs', async () => {
    db.clearRequestLogs();
    return { ok: true };
  });

  app.get('/auth/open-runway', async () => browser.openRunway());

  app.get('/auth/status', async () => ({
    accounts: db.getAccountSummary()
  }));

  app.get('/tasks', async (request) => ({
    tasks: db.listTasks({
      status: request.query.status,
      limit: request.query.limit,
      offset: request.query.offset,
      poolId: visiblePoolId(request)
    }).map((task) => presentTaskForResponse(task, request, config))
  }));

  app.get('/v1/videos/generations', async (request) => ({
    object: 'list',
    data: db.listTasks({
      status: request.query.status,
      limit: request.query.limit,
      offset: request.query.offset,
      poolId: visiblePoolId(request)
    }).map((task) => toV1VideoGeneration(task, { request, config }))
  }));

  app.get('/v1/videos', async (request) => ({
    object: 'list',
    data: db.listTasks({
      status: request.query.status,
      limit: request.query.limit,
      offset: request.query.offset,
      poolId: visiblePoolId(request)
    }).filter((task) => task.kind !== 'image').map((task) => toV1Video(task, { request, config }))
  }));

  app.get('/v1/images', async (request) => ({
    object: 'list',
    data: db.listTasks({
      status: request.query.status,
      limit: request.query.limit,
      offset: request.query.offset,
      poolId: visiblePoolId(request)
    }).filter((task) => task.kind === 'image').map((task) => toV1Image(task, { request, config }))
  }));

  app.get('/tasks/:id', async (request, reply) => {
    const task = await getFreshTaskForRead({ db, runway, id: request.params.id });
    if (!task) return reply.code(404).send({ error: 'task not found' });
    if (!canAccessTask(request, task)) return reply.code(404).send({ error: 'task not found' });
    return presentTaskForResponse(task, request, config);
  });

  app.get('/v1/videos/generations/:id', async (request, reply) => {
    const task = await getFreshTaskForRead({ db, runway, id: request.params.id });
    if (!task) return reply.code(404).send(toV1Error('task_not_found', '任务不存在。'));
    if (!canAccessTask(request, task)) return reply.code(404).send(toV1Error('task_not_found', '任务不存在。'));
    return toV1VideoGeneration(task, { request, config });
  });

  app.get('/v1/videos/generations/:id/content', async (request, reply) => streamTaskMedia({ db, runway, request, reply, kind: 'content' }));
  app.get('/v1/videos/generations/:id/thumbnail', async (request, reply) => streamTaskMedia({ db, runway, request, reply, kind: 'thumbnail' }));
  app.get('/v1/videos/:id/content', async (request, reply) => streamTaskMedia({ db, runway, request, reply, kind: 'content' }));
  app.get('/v1/videos/:id/thumbnail', async (request, reply) => streamTaskMedia({ db, runway, request, reply, kind: 'thumbnail' }));
  app.get('/v1/images/:id/content', async (request, reply) => streamTaskMedia({ db, runway, request, reply, kind: 'image' }));

  app.get('/v1/videos/:id', async (request, reply) => {
    const task = await getFreshTaskForRead({ db, runway, id: request.params.id });
    if (!task) return reply.code(404).send(toV1Error('task_not_found', '任务不存在。'));
    if (!canAccessTask(request, task)) return reply.code(404).send(toV1Error('task_not_found', '任务不存在。'));
    return toV1Video(task, { request, config });
  });

  app.get('/v1/images/:id', async (request, reply) => {
    const task = await getFreshTaskForRead({ db, runway, id: request.params.id });
    if (!task) return reply.code(404).send(toV1Error('task_not_found', '任务不存在。'));
    return toV1Image(task, { request, config });
  });

  app.get('/tasks/:id/events', async (request, reply) => {
    const task = db.getTask(request.params.id);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    if (!canAccessTask(request, task)) return reply.code(404).send({ error: 'task not found' });
    return { events: db.getTaskEvents(request.params.id) };
  });

  app.get('/v1/videos/:id/events', async (request, reply) => {
    const task = db.getTask(request.params.id);
    if (!task) return reply.code(404).send(toV1Error('task_not_found', '任务不存在。'));
    if (!canAccessTask(request, task)) return reply.code(404).send(toV1Error('task_not_found', '任务不存在。'));
    return { object: 'list', data: db.getTaskEvents(request.params.id) };
  });

  app.post('/tasks', async (request, reply) => {
    const { fields, files } = await readMultipartTask(request, config.uploadDir);
    const task = createPendingTask({ db, fields, files, auth: request.auth });
    return reply.code(202).send({
      id: task.id,
      runwayTaskId: null,
      status: 'pending',
      accountId: task.accountId
    });
  });

  app.post('/v1/videos/generations', async (request, reply) => {
    const { fields, files } = await readTaskRequest(request, config.uploadDir);
    const task = createPendingTask({ db, fields, files, auth: request.auth });
    return reply.code(202).send(toV1VideoGeneration(task, { request, config }));
  });

  app.post('/v1/videos', async (request, reply) => {
    const { fields, files } = await readTaskRequest(request, config.uploadDir);
    const task = createPendingTask({ db, fields, files, auth: request.auth });
    return reply.code(202).send(toV1Video(task, { request, config }));
  });

  app.post('/v1/images/generations', async (request, reply) => {
    const { fields, files } = await readTaskRequest(request, config.uploadDir);
    if (files.length || hasReferenceInputs(fields)) {
      return reply.code(400).send(toV1Error('invalid_request_error', 'Use /v1/images/edits for image references.'));
    }
    const task = createPendingTask({ db, fields: { ...fields, model: fields.model || 'gpt-image-2' }, files });
    return reply.code(202).send(toV1Image(task, { request, config }));
  });

  app.post('/v1/images/edits', async (request, reply) => {
    const { fields, files } = await readTaskRequest(request, config.uploadDir);
    const task = createPendingTask({ db, fields: { ...fields, model: fields.model || 'gpt-image-2' }, files });
    return reply.code(202).send(toV1Image(task, { request, config }));
  });

  app.post('/tasks/:id/retry', async (request, reply) => {
    const original = db.getTask(request.params.id);
    if (!original) return reply.code(404).send({ error: 'task not found' });
    if (!canAccessTask(request, original)) return reply.code(404).send({ error: 'task not found' });
    if (original.status !== 'failed') {
      return reply.code(409).send({ error: 'only failed tasks can be retried' });
    }
    const retry = createRetryTask({ db, original });
    return reply.code(202).send({ id: retry.id, runwayTaskId: null, status: retry.status, accountId: retry.accountId });
  });

  app.post('/tasks/:id/cancel', async (request, reply) => {
    const current = db.getTask(request.params.id);
    if (!current) return reply.code(404).send({ error: 'task not found' });
    if (!canAccessTask(request, current)) return reply.code(404).send({ error: 'task not found' });
    const task = await cancelTask({ db, runway, id: request.params.id });
    if (!task) return reply.code(404).send({ error: 'task not found' });
    return task;
  });

  app.post('/v1/videos/generations/:id/retry', async (request, reply) => {
    const original = db.getTask(request.params.id);
    if (!original) return reply.code(404).send(toV1Error('task_not_found', '任务不存在。'));
    if (!canAccessTask(request, original)) return reply.code(404).send(toV1Error('task_not_found', '任务不存在。'));
    if (original.status !== 'failed') {
      return reply.code(409).send(toV1Error('invalid_state', '只有失败任务可以重试。'));
    }
    return reply.code(202).send(toV1VideoGeneration(createRetryTask({ db, original }), { request, config }));
  });

  app.post('/v1/videos/generations/:id/cancel', async (request, reply) => {
    const current = db.getTask(request.params.id);
    if (!current) return reply.code(404).send(toV1Error('task_not_found', '任务不存在。'));
    if (!canAccessTask(request, current)) return reply.code(404).send(toV1Error('task_not_found', '任务不存在。'));
    const task = await cancelTask({ db, runway, id: request.params.id });
    if (!task) return reply.code(404).send(toV1Error('task_not_found', '任务不存在。'));
    return toV1VideoGeneration(task, { request, config });
  });

  app.post('/v1/videos/:id/retry', async (request, reply) => {
    const original = db.getTask(request.params.id);
    if (!original) return reply.code(404).send(toV1Error('task_not_found', '任务不存在。'));
    if (!canAccessTask(request, original)) return reply.code(404).send(toV1Error('task_not_found', '任务不存在。'));
    if (original.status !== 'failed') {
      return reply.code(409).send(toV1Error('invalid_state', '只有失败任务可以重试。'));
    }
    return reply.code(202).send(toV1Video(createRetryTask({ db, original }), { request, config }));
  });

  app.post('/v1/videos/:id/cancel', async (request, reply) => {
    const current = db.getTask(request.params.id);
    if (!current) return reply.code(404).send(toV1Error('task_not_found', '任务不存在。'));
    if (!canAccessTask(request, current)) return reply.code(404).send(toV1Error('task_not_found', '任务不存在。'));
    const task = await cancelTask({ db, runway, id: request.params.id });
    if (!task) return reply.code(404).send(toV1Error('task_not_found', '任务不存在。'));
    return toV1Video(task, { request, config });
  });

  app.post('/v1/images/:id/retry', async (request, reply) => {
    const original = db.getTask(request.params.id);
    if (!original) return reply.code(404).send(toV1Error('task_not_found', '任务不存在。'));
    if (original.status !== 'failed') {
      return reply.code(409).send(toV1Error('invalid_state', '只有失败任务可以重试。'));
    }
    return reply.code(202).send(toV1Image(createRetryTask({ db, original }), { request, config }));
  });

  app.post('/v1/images/:id/cancel', async (request, reply) => {
    const task = await cancelTask({ db, runway, id: request.params.id });
    if (!task) return reply.code(404).send(toV1Error('task_not_found', '任务不存在。'));
    return toV1Image(task, { request, config });
  });

  app.setErrorHandler((err, request, reply) => {
    request.log.error({ err }, 'request failed');
    const status = err.statusCode || err.status || 500;
    if (request.url.split('?')[0].startsWith('/v1/')) {
      return reply.code(status).send(toV1Error(err.code || 'request_failed', err.message));
    }
    reply.code(status).send({
      error: err.code || 'request_failed',
      message: err.message
    });
  });

  worker.start();
  app.addHook('onClose', async () => {
    await worker.stop();
    await browser.close();
    db.close();
  });

  function getAdminSession(request) {
    return db.getSession(getCookie(request.headers.cookie, 'runway_admin_session'));
  }

  function hasAdminSession(request) {
    return Boolean(getAdminSession(request));
  }

  function getRequestAuth(request) {
    const auth = request.headers.authorization || '';
    const configured = db.getAdminConfig().api_key || config.internalApiKey;
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (!token) return null;
    if (token === configured || token === config.internalApiKey) return { type: 'admin', poolId: null };
    const pool = db.getAccountPoolByApiKey?.(token);
    if (pool?.isActive) return { type: 'pool', poolId: pool.id, pool };
    return null;
  }

  function hasValidVideoAccessToken(request, pathname) {
    return verifyVideoAccessTokenForPath(pathname, request.query || {}, config);
  }

  return app;
}

async function readMultipartTask(request, uploadDir) {
  fs.mkdirSync(uploadDir, { recursive: true });
  const fields = {};
  const files = [];
  for await (const part of request.parts()) {
    if (part.type === 'field') {
      if (fields[part.fieldname] == null) fields[part.fieldname] = part.value;
      else if (Array.isArray(fields[part.fieldname])) fields[part.fieldname].push(part.value);
      else fields[part.fieldname] = [fields[part.fieldname], part.value];
      continue;
    }
    const id = randomUUID();
    const safeName = sanitizeFilename(part.filename || `${id}.bin`);
    const localPath = path.join(uploadDir, `${id}-${safeName}`);
    await fs.promises.writeFile(localPath, part.file);
    const stat = await fs.promises.stat(localPath);
    const mediaType = classifyUpload(part.mimetype, safeName);
    if (!mediaType) {
      await fs.promises.unlink(localPath).catch(() => {});
      const err = new Error('only image and video uploads are supported');
      err.statusCode = 400;
      throw err;
    }
    files.push({
      id,
      localPath,
      filename: safeName,
      mimeType: part.mimetype,
      mediaType,
      size: stat.size
    });
  }
  files.push(...await downloadReferenceUrls(extractReferenceUrls(fields), uploadDir));
  return { fields, files: applyOrderedReferenceAliases(files) };
}

async function readTaskRequest(request, uploadDir) {
  if (typeof request.isMultipart === 'function' && request.isMultipart()) {
    return readMultipartTask(request, uploadDir);
  }
  const body = request.body && typeof request.body === 'object' ? request.body : {};
  const fields = {
    ...body,
    prompt: body.prompt ?? body.input,
    accountId: body.accountId ?? body.account_id
  };
  const files = applyOrderedReferenceAliases(await downloadReferenceUrls(extractReferenceUrls(body), uploadDir));
  return { fields, files };
}

function extractReferenceUrls(input = {}) {
  return [
    ...normalizeReferenceObjects(input.references),
    ...normalizeReferenceObjects(input.referenceAssets ?? input.reference_assets),
    ...normalizeUrlList(input.mediaUrls ?? input.media_urls),
    ...normalizeUrlList(input.referenceUrls ?? input.reference_urls),
    ...normalizeUrlList(input.referenceUrl ?? input.reference_url),
    ...normalizeUrlList(input.imageUrls ?? input.image_urls),
    ...normalizeUrlList(input.videoUrls ?? input.video_urls)
  ];
}

function hasReferenceInputs(input = {}) {
  return extractReferenceUrls(input).length > 0 || ['media', 'media[]', 'image', 'image[]'].some((key) => input[key] != null);
}

function normalizeReferenceObjects(value) {
  if (!value) return [];
  const references = typeof value === 'string' ? parseReferenceJson(value) : value;
  if (!Array.isArray(references)) return [];
  return references
    .map((item) => {
      if (typeof item === 'string') return item;
      const url = item?.url || item?.uri || item?.src;
      if (!url) return null;
      return {
        url,
        name: item.name || item.label || item.id || null
      };
    })
    .filter(Boolean);
}

function parseReferenceJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return normalizeUrlList(value);
  }
}

function normalizeUrlList(value) {
  if (value == null || value === '') return [];
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((item) => String(item || '').split(/[\n,]/))
    .map((item) => item.trim())
    .filter(Boolean);
}

async function downloadReferenceUrls(urls, uploadDir) {
  if (!urls.length) return [];
  fs.mkdirSync(uploadDir, { recursive: true });
  const files = [];
  for (const url of urls) {
    files.push(await downloadReferenceUrl(url, uploadDir));
  }
  return files;
}

async function downloadReferenceUrl(url, uploadDir) {
  const reference = typeof url === 'object' ? url : { url };
  const parsed = parseReferenceUrl(reference.url);
  const id = randomUUID();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  let response;
  try {
    response = await fetch(parsed.href, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'runway-api/0.1' }
    });
  } catch (err) {
    const error = new Error(`reference url download failed: ${err.message}`);
    error.statusCode = 400;
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const err = new Error(`reference url returned ${response.status}`);
    err.statusCode = 400;
    throw err;
  }
  const contentLength = Number(response.headers.get('content-length') || 0);
  const maxBytes = 200 * 1024 * 1024;
  if (contentLength > maxBytes) {
    const err = new Error(`reference url is too large (${contentLength} bytes), max is 200MB`);
    err.statusCode = 400;
    throw err;
  }
  const mimeType = normalizeMimeType(response.headers.get('content-type')) || inferMimeTypeFromUrl(parsed) || 'application/octet-stream';
  const filename = filenameFromUrlOrHeaders(parsed, response.headers, mimeType, id, reference.name);
  const mediaType = classifyUpload(mimeType, filename);
  if (!mediaType) {
    const err = new Error('only image and video reference urls are supported');
    err.statusCode = 400;
    throw err;
  }
  const localPath = path.join(uploadDir, `${id}-${sanitizeFilename(filename)}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    const err = new Error(`reference url is too large (${buffer.byteLength} bytes), max is 200MB`);
    err.statusCode = 400;
    throw err;
  }
  await fs.promises.writeFile(localPath, buffer);
  return {
    id,
    localPath,
    filename: sanitizeFilename(filename),
    mimeType,
    mediaType,
    size: buffer.byteLength,
    explicitReferenceName: Boolean(reference.name)
  };
}

function applyOrderedReferenceAliases(files) {
  let imageIndex = 1;
  let videoIndex = 1;
  return files.map((file) => {
    if (file.explicitReferenceName) return file;
    if (file.mediaType === 'image') {
      return { ...file, filename: `IMG_${imageIndex++}${referenceExtension(file)}` };
    }
    if (file.mediaType === 'video') {
      return { ...file, filename: `VID_${videoIndex++}${referenceExtension(file)}` };
    }
    return file;
  });
}

function referenceExtension(file) {
  const mimeExtension = extensionForMimeType(file.mimeType);
  if (mimeExtension && mimeExtension !== '.bin') return mimeExtension;
  return path.extname(file.filename || '') || '.bin';
}

function parseReferenceUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    const err = new Error('invalid reference url');
    err.statusCode = 400;
    throw err;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    const err = new Error('reference url must use http or https');
    err.statusCode = 400;
    throw err;
  }
  return parsed;
}

function normalizeMimeType(value) {
  const raw = String(value || '').split(';')[0].trim().toLowerCase();
  return raw || null;
}

function inferMimeTypeFromUrl(url) {
  const ext = path.extname(url.pathname || '').toLowerCase();
  return {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.m4v': 'video/mp4'
  }[ext] || null;
}

function filenameFromUrlOrHeaders(url, headers, mimeType, fallbackId, preferredName = null) {
  const disposition = headers.get('content-disposition') || '';
  const match = disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
  const fromHeader = match ? decodeURIComponent(match[1].replace(/^"|"$/g, '')) : null;
  const fromUrl = path.basename(decodeURIComponent(url.pathname || ''));
  const base = preferredName || fromHeader || fromUrl || `reference-${fallbackId}${extensionForMimeType(mimeType)}`;
  return sanitizeFilename(base.includes('.') ? base : `${base}${extensionForMimeType(mimeType)}`);
}

function extensionForMimeType(mimeType) {
  return {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm'
  }[mimeType] || '.bin';
}

function createPendingTask({ db, fields, files, auth = null }) {
  const taskConfig = normalizeTaskInput(fields);
  if (taskConfig.kind === 'image' && files.some((file) => file.mediaType === 'video')) {
    const err = new Error('image generation only supports image references');
    err.statusCode = 400;
    throw err;
  }
  const accountId = fields.accountId && fields.accountId !== 'auto' ? String(fields.accountId) : null;
  const account = accountId ? db.getAccount(accountId) : null;
  const requestedPoolId = normalizeOptionalId(fields.poolId ?? fields.pool_id);
  const poolId = auth?.type === 'pool'
    ? auth.poolId
    : (requestedPoolId ?? normalizeOptionalId(account?.poolId));
  if (accountId && !account) {
    const err = new Error('account not found');
    err.statusCode = 404;
    throw err;
  }
  if (account && normalizeOptionalId(account.poolId) !== poolId) {
    const err = new Error('account not found in requested pool');
    err.statusCode = 404;
    throw err;
  }
  const task = db.createTask({
    id: randomUUID(),
    status: 'pending',
    poolId,
    accountId,
    ...taskConfig
  });
  for (const file of files) {
    db.addAsset({ ...file, taskId: task.id, accountId });
  }
  return task;
}

function createRetryTask({ db, original }) {
  const retry = db.createTask({
    id: randomUUID(),
    parentTaskId: original.id,
    poolId: original.poolId,
    accountId: original.accountId,
    status: 'pending',
    prompt: original.prompt,
    model: original.model,
    duration: original.duration,
    resolution: original.resolution,
    aspectRatio: original.aspectRatio,
    generateAudio: original.generateAudio,
    exploreMode: original.exploreMode,
    kind: original.kind,
    quality: original.quality,
    background: original.background,
    numImages: original.numImages
  });
  for (const asset of original.assets) {
    db.addAsset({
      id: randomUUID(),
      taskId: retry.id,
      accountId: original.accountId,
      localPath: asset.localPath,
      filename: asset.filename,
      mimeType: asset.mimeType,
      mediaType: asset.mediaType,
      size: asset.size,
      runwayAssetId: asset.runwayAssetId,
      runwayUrl: asset.runwayUrl,
      previewUrl: asset.previewUrl
    });
  }
  return retry;
}

async function getGitVersion() {
  const [branch, commit] = await Promise.all([
    runGit(['rev-parse', '--abbrev-ref', 'HEAD']).catch((err) => ({ stdout: null, stderr: err.message })),
    runGit(['rev-parse', '--short', 'HEAD']).catch((err) => ({ stdout: null, stderr: err.message }))
  ]);
  return {
    branch: branch.stdout?.trim() || null,
    commit: commit.stdout?.trim() || null
  };
}

async function updateFromRemote({ config }) {
  const before = await getGitVersion();
  const pull = await runGit(['pull', '--ff-only']);
  const install = await runNpmInstall();
  const after = await getGitVersion();
  const updated = before.commit && after.commit ? before.commit !== after.commit : pull.stdout.trim() !== 'Already up to date.';
  const restart = planRestart(config, updated);
  if (restart.scheduled) scheduleRestart(restart);
  return {
    ok: true,
    updated,
    before,
    after,
    restart,
    stdout: [
      '$ git pull --ff-only',
      pull.stdout.trim(),
      pull.stderr.trim(),
      '',
      '$ npm install',
      install.stdout.trim(),
      install.stderr.trim()
    ].filter(Boolean).join('\n'),
    stderr: ''
  };
}

async function runGit(args) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: repoRoot,
      timeout: 120000,
      maxBuffer: 1024 * 1024
    });
    return { stdout, stderr };
  } catch (err) {
    const error = new Error(err.stderr || err.stdout || err.message || 'git command failed');
    error.statusCode = 500;
    error.code = 'GIT_UPDATE_FAILED';
    error.stdout = err.stdout || '';
    error.stderr = err.stderr || '';
    throw error;
  }
}

async function runNpmInstall() {
  try {
    const { stdout, stderr } = await execFileAsync('npm', ['install'], {
      cwd: repoRoot,
      timeout: 180000,
      maxBuffer: 2 * 1024 * 1024
    });
    return { stdout, stderr };
  } catch (err) {
    const error = new Error(err.stderr || err.stdout || err.message || 'npm install failed');
    error.statusCode = 500;
    error.code = 'NPM_INSTALL_FAILED';
    error.stdout = err.stdout || '';
    error.stderr = err.stderr || '';
    throw error;
  }
}

function planRestart(config, updated) {
  if (!updated) return { scheduled: false, method: 'none', message: '代码无变化，无需重启' };
  if (!config.autoRestartOnUpdate) return { scheduled: false, method: 'manual', message: '已更新，但自动重启已关闭' };
  if (config.restartCommand) {
    return {
      scheduled: true,
      method: 'command',
      command: config.restartCommand,
      delayMs: 1200,
      message: '已安排执行自定义重启命令'
    };
  }
  if (process.env.pm_id || process.env.PM2_HOME) {
    const target = process.env.pm_id || config.pm2ProcessName || 'runway-api';
    return {
      scheduled: true,
      method: 'pm2',
      command: `pm2 restart ${target}`,
      args: ['restart', target],
      delayMs: 1200,
      message: `已安排 PM2 重启：${target}`
    };
  }
  return {
    scheduled: false,
    method: 'manual',
    message: '已更新，但当前进程不是 PM2 托管，也没有配置 RESTART_COMMAND，需要手动重启'
  };
}

function scheduleRestart(restart) {
  setTimeout(() => {
    const child = restart.method === 'pm2'
      ? spawn('pm2', restart.args, { cwd: repoRoot, detached: true, stdio: 'ignore' })
      : spawn('sh', ['-lc', restart.command], { cwd: repoRoot, detached: true, stdio: 'ignore' });
    child.unref();
  }, restart.delayMs || 1200).unref();
}

function importAccounts({ db, input, operation = 'account_import' }) {
  if (!input) {
    const err = new Error('accounts array or account object is required');
    err.statusCode = 400;
    throw err;
  }
  const imported = [];
  const errors = [];
  for (const [index, item] of input.entries()) {
    try {
      const account = db.createAccount(normalizeImportedAccount(item, index, db));
      imported.push(hideSecret(account));
      db.logRequest({ accountId: account.id, operation, status: 'success', message: '导入账号成功' });
    } catch (err) {
      errors.push({
        index,
        name: item && typeof item === 'object' ? item.name || item.accountName || item.id || null : null,
        message: err.message || '导入失败'
      });
    }
  }
  return { accounts: imported, imported: imported.length, skipped: errors.length, errors };
}

async function cancelTask({ db, runway, id }) {
  const task = db.getTask(id);
  if (!task) return null;
  if (['completed', 'failed', 'cancelled'].includes(task.status)) return task;

  let runwayResponse = null;
  let runwayError = null;
  if (task.runwayTaskId && task.accountId && runway?.cancelTask) {
    const account = db.getAccount(task.accountId, { includeSecret: true });
    if (account?.jwt || account?.cookieHeader) {
      try {
        runwayResponse = await runway.cancelTask(task.runwayTaskId, { account });
        db.logRequest?.({
          accountId: account.id,
          operation: 'cancel',
          status: 'success',
          message: `cancelled ${task.runwayTaskId}`
        });
      } catch (err) {
        runwayError = {
          code: err.code || 'RUNWAY_CANCEL_FAILED',
          message: err.message,
          status: err.status || err.statusCode || null,
          body: err.body || null
        };
        db.logRequest?.({
          accountId: account.id,
          operation: 'cancel',
          status: 'failed',
          statusCode: runwayError.status,
          message: err.message
        });
      }
    }
  }

  return db.cancelTask(id, {
    reason: runwayError ? '本地已取消；Runway 取消请求失败，请到 Runway 后台确认任务状态' : '用户取消任务',
    runwayResponse,
    runwayError
  });
}

function visiblePoolId(request) {
  return request.auth?.type === 'pool' ? request.auth.poolId : undefined;
}

function canAccessTask(request, task) {
  if (!request.auth || request.auth.type === 'admin') return true;
  return normalizeOptionalId(task.poolId) === normalizeOptionalId(request.auth.poolId);
}

async function getFreshTaskForRead({ db, runway, id }) {
  const task = db.getTask(id);
  if (!task || !shouldRefreshSignedUrls(task, runway)) return task;
  const account = db.getAccount(task.accountId, { includeSecret: true });
  if (!(account?.jwt || account?.cookieHeader)) return task;

  try {
    const update = await runway.pollTask(task.runwayTaskId, {
      account,
      operation: 'task_signed_url_refresh'
    });
    const patch = {
      rawStatus: update.rawStatus ?? task.rawStatus,
      progress: update.progress ?? task.progress,
      rawResponse: update.rawResponse ?? task.rawResponse
    };
    if (update.videoUrl) patch.videoUrl = update.videoUrl;
    if (update.thumbnailUrl) patch.thumbnailUrl = update.thumbnailUrl;
    if (update.status && update.status !== task.status) patch.status = update.status;
    if (update.error) patch.error = update.error;
    return db.updateTask(task.id, patch) || task;
  } catch (err) {
    db.logRequest?.({
      accountId: task.accountId,
      operation: 'task_signed_url_refresh',
      status: 'failed',
      statusCode: err.status || err.statusCode || null,
      message: err.message
    });
    return {
      ...task,
      signedUrlRefreshError: {
        message: err.message,
        code: err.code || null,
        status: err.status || err.statusCode || null
      }
    };
  }
}

function shouldRefreshSignedUrls(task, runway) {
  return Boolean(
    runway?.pollTask &&
    task?.status === 'completed' &&
    task.runwayTaskId &&
    task.accountId
  );
}

async function streamTaskMedia({ db, runway, request, reply, kind }) {
  const task = await getFreshTaskForRead({ db, runway, id: request.params.id });
  if (!task) return reply.code(404).send(toV1Error('task_not_found', '任务不存在。'));
  if (!canAccessTask(request, task)) return reply.code(404).send(toV1Error('task_not_found', '任务不存在。'));
  if (task.status !== 'completed') return reply.code(409).send(toV1Error('task_not_completed', '任务还没有完成。'));

  const sourceUrl = kind === 'thumbnail' ? task.thumbnailUrl : task.videoUrl;
  if (!sourceUrl) {
    return reply.code(404).send(toV1Error('media_not_found', kind === 'thumbnail' ? '缩略图链接不存在。' : '视频链接不存在。'));
  }

  const headers = {};
  if (request.headers.range) headers.Range = request.headers.range;
  const response = await fetch(sourceUrl, { headers });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return reply.code(502).send(toV1Error('media_proxy_failed', `视频代理请求失败：HTTP ${response.status}${text ? ` ${text.slice(0, 200)}` : ''}`));
  }

  for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    const value = response.headers.get(header);
    if (value) reply.header(header, value);
  }
  reply.header('Cache-Control', 'private, no-store');
  reply.header('X-Content-Type-Options', 'nosniff');
  return reply.code(response.status).send(Readable.fromWeb(response.body));
}

function presentTaskForResponse(task, request, config) {
  const presented = {
    ...task,
    videoUrl: proxiedMediaUrl(task, 'content', request, config),
    thumbnailUrl: proxiedMediaUrl(task, 'thumbnail', request, config),
    assets: (task.assets || []).map(safeAssetForResponse)
  };
  delete presented.rawResponse;
  return presented;
}

function normalizeAccountPatch(body) {
  const patch = {
    poolId: body.poolId,
    name: body.name,
    remark: body.remark,
    teamId: body.teamId,
    assetGroupId: body.assetGroupId,
    clientId: body.clientId,
    sourceApplicationVersion: body.sourceVersion || body.sourceApplicationVersion,
    isActive: body.isActive,
    maxConcurrent: body.maxConcurrent,
    proxyId: body.proxyId,
    proxyStrategy: body.proxyStrategy,
    generationLimit: body.generationLimit,
    generationUsed: body.generationUsed,
    requestTimeoutMs: body.requestTimeoutMs,
    uploadTimeoutMs: body.uploadTimeoutMs,
    taskTimeoutMs: body.taskTimeoutMs,
    maxRetries: body.maxRetries
  };
  if (body.authorization || body.jwt) patch.jwt = normalizeBearerToken(body.authorization || body.jwt);
  if (body.cookieHeader || body.cookie) patch.cookieHeader = normalizeCookieHeader(body.cookieHeader || body.cookie);
  return patch;
}

function toV1Model(model) {
  return {
    id: model.publicId || model.id,
    object: 'model',
    created: 0,
    owned_by: 'video-api',
    name: model.label,
    taskType: model.kind || 'video',
    internalId: model.id,
    runwayTaskType: model.taskType,
    durations: model.durations,
    resolutions: model.resolutions,
    aspectRatios: model.aspectRatios,
    qualities: model.qualities,
    defaultAspectRatio: model.defaultAspectRatio,
    defaultResolution: model.defaultResolution,
    defaultQuality: model.defaultQuality,
    defaultNumImages: model.defaultNumImages,
    allowedNumImages: model.allowedNumImages,
    supportsAudio: model.supportsAudio,
    supportsExploreMode: model.supportsExploreMode,
    supportsReferenceImages: model.supportsReferenceImages,
    supportsReferenceVideos: model.supportsReferenceVideos,
    maxReferenceImages: model.maxReferenceImages,
    maxReferenceVideos: model.maxReferenceVideos
  };
}

function toV1VideoGeneration(task, options = {}) {
  return toV1Video(task, 'video.generation', options);
}

function toV1Image(task, options = {}) {
  const imageUrl = proxiedMediaUrl(task, 'image', options.request, options.config);
  return {
    id: task.id,
    object: 'image.generation',
    created: toUnixSeconds(task.createdAt),
    created_at: toUnixSeconds(task.createdAt),
    model: task.model,
    prompt: task.prompt,
    status: toV1TaskStatus(task.status),
    progress: task.progress,
    data: task.status === 'completed' && imageUrl ? [{ url: imageUrl }] : [],
    error: ['failed', 'cancelled'].includes(task.status)
      ? {
          message: publicErrorMessage(task),
          code: publicErrorCode(task),
          type: 'image_generation_error',
          param: null,
          reason: publicErrorReason(task)
        }
      : null,
    metadata: {
      prompt: task.prompt,
      aspect_ratio: task.aspectRatio,
      resolution: task.resolution,
      quality: task.quality,
      background: task.background,
      n: task.numImages,
      created_at: task.createdAt,
      updated_at: task.updatedAt,
      submitted_at: task.submittedAt,
      completed_at: task.completedAt
    }
  };
}

function toV1Video(task, object = 'video', options = {}) {
  if (object && typeof object === 'object') {
    options = object;
    object = 'video';
  }
  return {
    id: task.id,
    object,
    created: toUnixSeconds(task.createdAt),
    created_at: toUnixSeconds(task.createdAt),
    model: task.model,
    prompt: task.prompt,
    seconds: task.duration != null ? String(task.duration) : null,
    size: resolutionToOpenAiSize(task.resolution, task.aspectRatio),
    status: toV1TaskStatus(task.status),
    progress: task.progress,
    video_url: proxiedMediaUrl(task, 'content', options.request, options.config),
    thumbnail_url: proxiedMediaUrl(task, 'thumbnail', options.request, options.config),
    error: ['failed', 'cancelled'].includes(task.status)
      ? {
          message: publicErrorMessage(task),
          code: publicErrorCode(task),
          type: 'video_generation_error',
          param: null,
          reason: publicErrorReason(task)
        }
      : null,
    metadata: {
      prompt: task.prompt,
      duration: task.duration,
      resolution: task.resolution,
      aspect_ratio: task.aspectRatio,
      generate_audio: task.generateAudio,
      explore_mode: task.exploreMode,
      created_at: task.createdAt,
      updated_at: task.updatedAt,
      submitted_at: task.submittedAt,
      completed_at: task.completedAt
    }
  };
}

function resolutionToOpenAiSize(resolution, aspectRatio) {
  if (!resolution || !aspectRatio) return null;
  const base = {
    '480p': 480,
    '720p': 720,
    '1080p': 1080
  }[String(resolution).toLowerCase()];
  const ratio = String(aspectRatio).split(':').map((part) => Number(part));
  if (!base || ratio.length !== 2 || !ratio[0] || !ratio[1]) return `${resolution} ${aspectRatio}`;
  if (ratio[0] >= ratio[1]) {
    return `${roundToEven((base * ratio[0]) / ratio[1])}x${base}`;
  }
  return `${base}x${roundToEven((base * ratio[1]) / ratio[0])}`;
}

function roundToEven(value) {
  return Math.max(2, Math.round(value / 2) * 2);
}

function safeAssetForResponse(asset) {
  const { runwayUrl, previewUrl, ...safe } = asset;
  return safe;
}

function publicErrorCode(task) {
  if (task.status === 'cancelled') return 'cancelled';
  const summary = `${task.errorSummary || ''} ${task.errorCode || ''} ${task.errorCategory || ''}`;
  if (/审核|SAFETY|SEXUALLY_EXPLICIT|moderation/i.test(summary)) return 'content_policy_violation';
  if (/超时|timeout/i.test(summary)) return 'timeout';
  if (/凭证|AUTH|401|403|credential/i.test(summary)) return 'authentication_failed';
  return 'generation_failed';
}

function publicErrorMessage(task) {
  return publicErrorReason(task);
}

function publicErrorReason(task) {
  if (task.status === 'cancelled') return '任务已取消。';
  const reason = firstNonEmpty(
    task.errorReason,
    task.errorMessage,
    task.error?.reason,
    task.error?.message,
    task.errorSummary,
    task.errorCode
  );
  const cleaned = sanitizePublicErrorText(reason);
  return cleaned || task.errorSummary || '任务失败。';
}

function sanitizePublicErrorText(value) {
  let text = String(value || '').trim();
  if (!text) return null;
  text = text
    .replace(/Runway/gi, '上游服务')
    .replace(/JWT|Bearer|Authorization|Cookie/gi, '凭证')
    .replace(/https?:\/\/\S+/gi, '[链接已隐藏]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[邮箱已隐藏]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[凭证已隐藏]')
    .replace(/\b\d{6,}\b/g, '[编号已隐藏]')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > 1000) text = `${text.slice(0, 1000)}...`;
  return text || null;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

function toV1TaskStatus(status) {
  return {
    pending: 'queued',
    submitting: 'in_progress',
    queuing: 'queued',
    generating: 'in_progress',
    completed: 'completed',
    failed: 'failed',
    cancelled: 'cancelled'
  }[status] || status || 'unknown';
}

function toUnixSeconds(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? Math.floor(time / 1000) : 0;
}

function proxiedMediaUrl(task, kind, request, config = {}) {
  const hasSource = kind === 'thumbnail' ? task.thumbnailUrl : task.videoUrl;
  if (!hasSource || !request) return hasSource || null;
  const expires = Math.floor(Date.now() / 1000) + (Number(config.videoProxyTokenTtlSeconds) || 3600);
  const token = signVideoAccessToken(task.id, kind === 'image' ? 'content' : kind, expires, config);
  const baseUrl = publicBaseUrl(request, config);
  const suffix = kind === 'thumbnail' ? 'thumbnail' : 'content';
  const route = kind === 'image' ? 'images' : 'videos';
  return `${baseUrl}/v1/${route}/${encodeURIComponent(task.id)}/${suffix}?expires=${expires}&token=${encodeURIComponent(token)}`;
}

function publicBaseUrl(request, config = {}) {
  if (config.publicBaseUrl) return String(config.publicBaseUrl).replace(/\/+$/, '');
  const proto = String(request.headers['x-forwarded-proto'] || request.protocol || 'http').split(',')[0].trim();
  const host = String(request.headers['x-forwarded-host'] || request.headers.host || `127.0.0.1:${config.port || 8787}`).split(',')[0].trim();
  return `${proto}://${host}`;
}

function signVideoAccessToken(taskId, kind, expires, config = {}, db = null) {
  return createHmac('sha256', videoAccessSecret(config, db))
    .update(videoAccessPayload(taskId, kind, expires))
    .digest('base64url');
}

function verifyVideoAccessTokenForPath(pathname, query = {}, config = {}, db = null) {
  const match = String(pathname).match(/^\/v1\/(?:videos(?:\/generations)?|images)\/([^/]+)\/(content|thumbnail)$/);
  if (!match) return false;
  const taskId = decodeURIComponent(match[1]);
  const kind = match[2] === 'thumbnail' ? 'thumbnail' : 'content';
  const expires = Number(query.expires);
  const token = String(query.token || '');
  if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000) || !token) return false;
  const expected = signVideoAccessToken(taskId, kind, expires, config, db);
  return safeEqual(token, expected);
}

function videoAccessPayload(taskId, kind, expires) {
  return `${taskId}:${kind}:${expires}`;
}

function videoAccessSecret(config = {}, db = null) {
  return db?.getAdminConfig?.().api_key || config.internalApiKey || 'change-me';
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function toV1Error(code, message) {
  return {
    error: {
      message,
      type: 'invalid_request_error',
      code
    }
  };
}

function setExtensionCorsHeaders(reply) {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
}

function extractImportItems(body, pluralKey, singularKey) {
  const value = parseImportBody(body);
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value[pluralKey])) return value[pluralKey];
  if (Array.isArray(value.data?.[pluralKey])) return value.data[pluralKey];
  if (value[singularKey] && typeof value[singularKey] === 'object') return [value[singularKey]];
  if (singularKey === 'account' && looksLikeAccount(value)) return [value];
  if (singularKey === 'proxy' && looksLikeProxy(value)) return [value];
  return null;
}

function parseImportBody(body) {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function normalizeImportedAccount(item, index, db) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    const err = new Error(`第 ${index + 1} 条账号不是有效对象`);
    err.statusCode = 400;
    throw err;
  }
  const credentials = item.credentials && typeof item.credentials === 'object' ? item.credentials : {};
  const duplicateId = item.id && db.getAccount(item.id);
  const runwayCredits = item.runwayCredits ?? item.runway_credits ?? item.credits ?? null;
  const jwt = normalizeBearerToken(pickFirst(item, credentials, ['authorization', 'auth', 'jwt', 'bearer', 'accessToken', 'access_token', 'token']));
  const importedEmail = normalizeOptionalImportString(pickFirst(item, credentials, ['email', 'emailAddress', 'email_address', 'userEmail', 'user_email']));
  const jwtEmail = emailFromJwt(jwt);
  const importedDisplayName = normalizeOptionalImportString(pickFirst(item, credentials, [
    'accountName',
    'account_name',
    'displayName',
    'display_name',
    'username',
    'userName',
    'fullName',
    'full_name'
  ]));
  const resolvedName = item.name || importedDisplayName || importedEmail || jwtEmail || (duplicateId ? `${duplicateId.name}（导入）` : '导入账号');
  return {
    ...item,
    id: item.id && !duplicateId ? item.id : randomUUID(),
    name: resolvedName,
    remark: item.remark ?? item.note ?? item.description ?? null,
    jwt,
    cookieHeader: normalizeCookieHeader(pickFirst(item, credentials, ['cookieHeader', 'cookie_header', 'cookie', 'cookies'])),
    teamId: pickFirst(item, credentials, ['teamId', 'team_id', 'team']),
    assetGroupId: pickFirst(item, credentials, ['assetGroupId', 'asset_group_id', 'assetGroup']),
    clientId: normalizeOptionalImportString(pickFirst(item, credentials, [
      'clientId',
      'client_id',
      'clientID',
      'xRunwayClientId',
      'x_runway_client_id',
      'x-runway-client-id'
    ])),
    sourceApplicationVersion: normalizeOptionalImportString(pickFirst(item, credentials, [
      'sourceApplicationVersion',
      'source_application_version',
      'sourceVersion',
      'source_version',
      'runwaySourceVersion',
      'xRunwaySourceApplicationVersion',
      'x_runway_source_application_version',
      'x-runway-source-application-version'
    ])),
    isActive: pickFirst(item, credentials, ['isActive', 'is_active', 'enabled', 'active']) ?? 1,
    maxConcurrent: pickFirst(item, credentials, ['maxConcurrent', 'max_concurrent', 'concurrency']),
    proxyId: pickFirst(item, credentials, ['proxyId', 'proxy_id']) || null,
    proxyStrategy: pickFirst(item, credentials, ['proxyStrategy', 'proxy_strategy']),
    poolId: pickFirst(item, credentials, ['poolId', 'pool_id', 'accountPoolId', 'account_pool_id']) || null,
    generationLimit: pickFirst(item, credentials, ['generationLimit', 'generation_limit', 'limit']),
    generationUsed: pickFirst(item, credentials, ['generationUsed', 'generation_used', 'used']),
    requestTimeoutMs: pickFirst(item, credentials, ['requestTimeoutMs', 'request_timeout_ms']),
    uploadTimeoutMs: pickFirst(item, credentials, ['uploadTimeoutMs', 'upload_timeout_ms']),
    taskTimeoutMs: pickFirst(item, credentials, ['taskTimeoutMs', 'task_timeout_ms']),
    maxRetries: pickFirst(item, credentials, ['maxRetries', 'max_retries']),
    runwayCreditsJson: runwayCredits
      ? (typeof runwayCredits === 'string' ? runwayCredits : JSON.stringify(runwayCredits))
      : item.runwayCreditsJson ?? item.runway_credits_json ?? null,
    runwayCreditsCheckedAt: item.runwayCreditsCheckedAt ?? item.runway_credits_checked_at ?? null
  };
}

function emailFromJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return normalizeOptionalImportString(payload.email);
  } catch {
    return null;
  }
}

function normalizeImportedProxy(item, index, db) {
  if (typeof item === 'string') {
    return { url: item };
  }
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    const err = new Error(`第 ${index + 1} 条代理不是有效对象`);
    err.statusCode = 400;
    throw err;
  }
  return {
    ...item,
    id: item.id && !db.getProxy(item.id) ? item.id : randomUUID(),
    url: item.url || item.proxy || item.value || item.address,
    name: item.name || item.label
  };
}

function pickFirst(primary, secondary, keys) {
  for (const key of keys) {
    if (primary[key] !== undefined && primary[key] !== '') return primary[key];
    if (secondary[key] !== undefined && secondary[key] !== '') return secondary[key];
  }
  return undefined;
}

function looksLikeAccount(value) {
  return [
    'jwt',
    'authorization',
    'cookie',
    'cookieHeader',
    'teamId',
    'team_id',
    'assetGroupId',
    'asset_group_id',
    'clientId',
    'credentials'
  ].some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function looksLikeProxy(value) {
  return ['url', 'proxy', 'value', 'address'].some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function hideSecret(account) {
  const { jwt, cookieHeader, ...safe } = account;
  return safe;
}

function normalizeBearerToken(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return raw.replace(/^Authorization:\s*/i, '').replace(/^Bearer\s+/i, '').trim();
}

function normalizeCookieHeader(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return raw.replace(/^Cookie:\s*/i, '').trim();
}

function normalizeOptionalId(value) {
  if (value == null || value === '' || value === 'default' || value === 'none') return null;
  return String(value).trim() || null;
}

function normalizeOptionalImportString(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const text = String(value).trim();
    if (!text || text === '[object Object]') return null;
    return text;
  }
  return null;
}

function sanitizeFilename(filename) {
  const base = path.basename(filename);
  return base.replace(/[^\p{L}\p{N}._-]/gu, '_') || 'upload.bin';
}

function classifyUpload(mimeType, filename) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return null;
  const ext = path.extname(filename || '').toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) return 'image';
  if (['.mp4', '.mov', '.webm', '.m4v'].includes(ext)) return 'video';
  return null;
}

function isPublicRoute(pathname) {
  return pathname === '/health' || pathname === '/models' || pathname === '/v1/models' || pathname === '/admin/login' || pathname === '/admin/me' || isPublicAsset(pathname);
}

function isVideoContentRoute(pathname) {
  return /^\/v1\/(?:videos(?:\/generations)?|images)\/[^/]+\/(?:content|thumbnail)$/.test(String(pathname));
}

function isPublicAsset(pathname) {
  return pathname === '/' || pathname === '/app.js' || pathname === '/styles.css';
}

async function servePublic(reply, filename, contentType) {
  const filePath = path.join(publicDir, filename);
  const body = await fs.promises.readFile(filePath);
  return reply.type(contentType).send(body);
}

function getCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  for (const item of String(cookieHeader).split(';')) {
    const [key, ...rest] = item.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge != null) parts.push(`Max-Age=${options.maxAge}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  return parts.join('; ');
}
