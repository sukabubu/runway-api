import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { RUNWAY_MODELS, normalizeTaskInput } from './runway/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');

export async function buildApp({ config, db, browser, worker, proxyManager = null, runway = null, logger }) {
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
    if (pathname.startsWith('/api/') || pathname.startsWith('/auth/') || pathname.startsWith('/admin/') || (pathname.startsWith('/v1/') && pathname !== '/v1/models')) {
      if (hasAdminSession(request) || hasApiKey(request)) return;
      return reply.code(401).send(pathname.startsWith('/v1/') ? toV1Error('unauthorized', '未登录或 API Key 不正确。') : { error: 'unauthorized' });
    }
    if (pathname.startsWith('/tasks')) {
      if (hasApiKey(request) || hasAdminSession(request)) return;
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

  app.get('/api/accounts', async () => ({
    accounts: db.listAccounts(),
    summary: db.getAccountSummary()
  }));

  app.post('/api/accounts/login-browser', async (request) => {
    const body = request.body || {};
    const account = db.createAccount({
      name: body.name || `网页登录 ${new Date().toLocaleString('zh-CN')}`,
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
      offset: request.query.offset
    })
  }));

  app.get('/v1/videos/generations', async (request) => ({
    object: 'list',
    data: db.listTasks({
      status: request.query.status,
      limit: request.query.limit,
      offset: request.query.offset
    }).map(toV1VideoGeneration)
  }));

  app.get('/v1/videos', async (request) => ({
    object: 'list',
    data: db.listTasks({
      status: request.query.status,
      limit: request.query.limit,
      offset: request.query.offset
    }).map((task) => toV1Video(task))
  }));

  app.get('/tasks/:id', async (request, reply) => {
    const task = db.getTask(request.params.id);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    return task;
  });

  app.get('/v1/videos/generations/:id', async (request, reply) => {
    const task = db.getTask(request.params.id);
    if (!task) return reply.code(404).send(toV1Error('task_not_found', '任务不存在。'));
    return toV1VideoGeneration(task);
  });

  app.get('/v1/videos/:id', async (request, reply) => {
    const task = db.getTask(request.params.id);
    if (!task) return reply.code(404).send(toV1Error('task_not_found', '任务不存在。'));
    return toV1Video(task);
  });

  app.get('/tasks/:id/events', async (request, reply) => {
    const task = db.getTask(request.params.id);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    return { events: db.getTaskEvents(request.params.id) };
  });

  app.get('/v1/videos/:id/events', async (request, reply) => {
    const task = db.getTask(request.params.id);
    if (!task) return reply.code(404).send(toV1Error('task_not_found', '任务不存在。'));
    return { object: 'list', data: db.getTaskEvents(request.params.id) };
  });

  app.post('/tasks', async (request, reply) => {
    const { fields, files } = await readMultipartTask(request, config.uploadDir);
    const task = createPendingTask({ db, fields, files });
    return reply.code(202).send({
      id: task.id,
      runwayTaskId: null,
      status: 'pending',
      accountId: task.accountId
    });
  });

  app.post('/v1/videos/generations', async (request, reply) => {
    const { fields, files } = await readTaskRequest(request, config.uploadDir);
    const task = createPendingTask({ db, fields, files });
    return reply.code(202).send(toV1VideoGeneration(task));
  });

  app.post('/v1/videos', async (request, reply) => {
    const { fields, files } = await readTaskRequest(request, config.uploadDir);
    const task = createPendingTask({ db, fields, files });
    return reply.code(202).send(toV1Video(task));
  });

  app.post('/tasks/:id/retry', async (request, reply) => {
    const original = db.getTask(request.params.id);
    if (!original) return reply.code(404).send({ error: 'task not found' });
    if (original.status !== 'failed') {
      return reply.code(409).send({ error: 'only failed tasks can be retried' });
    }
    const retry = createRetryTask({ db, original });
    return reply.code(202).send({ id: retry.id, runwayTaskId: null, status: retry.status, accountId: retry.accountId });
  });

  app.post('/tasks/:id/cancel', async (request, reply) => {
    const task = await cancelTask({ db, runway, id: request.params.id });
    if (!task) return reply.code(404).send({ error: 'task not found' });
    return task;
  });

  app.post('/v1/videos/generations/:id/retry', async (request, reply) => {
    const original = db.getTask(request.params.id);
    if (!original) return reply.code(404).send(toV1Error('task_not_found', '任务不存在。'));
    if (original.status !== 'failed') {
      return reply.code(409).send(toV1Error('invalid_state', '只有失败任务可以重试。'));
    }
    return reply.code(202).send(toV1VideoGeneration(createRetryTask({ db, original })));
  });

  app.post('/v1/videos/generations/:id/cancel', async (request, reply) => {
    const task = await cancelTask({ db, runway, id: request.params.id });
    if (!task) return reply.code(404).send(toV1Error('task_not_found', '任务不存在。'));
    return toV1VideoGeneration(task);
  });

  app.post('/v1/videos/:id/retry', async (request, reply) => {
    const original = db.getTask(request.params.id);
    if (!original) return reply.code(404).send(toV1Error('task_not_found', '任务不存在。'));
    if (original.status !== 'failed') {
      return reply.code(409).send(toV1Error('invalid_state', '只有失败任务可以重试。'));
    }
    return reply.code(202).send(toV1Video(createRetryTask({ db, original })));
  });

  app.post('/v1/videos/:id/cancel', async (request, reply) => {
    const task = await cancelTask({ db, runway, id: request.params.id });
    if (!task) return reply.code(404).send(toV1Error('task_not_found', '任务不存在。'));
    return toV1Video(task);
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

  function hasApiKey(request) {
    const auth = request.headers.authorization || '';
    const configured = db.getAdminConfig().api_key || config.internalApiKey;
    return auth === `Bearer ${configured}` || auth === `Bearer ${config.internalApiKey}`;
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

function createPendingTask({ db, fields, files }) {
  const taskConfig = normalizeTaskInput(fields);
  const accountId = fields.accountId && fields.accountId !== 'auto' ? String(fields.accountId) : null;
  if (accountId && !db.getAccount(accountId)) {
    const err = new Error('account not found');
    err.statusCode = 404;
    throw err;
  }
  const task = db.createTask({
    id: randomUUID(),
    status: 'pending',
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
    accountId: original.accountId,
    status: 'pending',
    prompt: original.prompt,
    model: original.model,
    duration: original.duration,
    resolution: original.resolution,
    aspectRatio: original.aspectRatio,
    generateAudio: original.generateAudio,
    exploreMode: original.exploreMode
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

function normalizeAccountPatch(body) {
  const patch = {
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
    id: model.id,
    object: 'model',
    created: 0,
    owned_by: 'runway',
    name: model.label,
    taskType: model.taskType,
    durations: model.durations,
    resolutions: model.resolutions,
    aspectRatios: model.aspectRatios,
    supportsAudio: model.supportsAudio,
    supportsExploreMode: model.supportsExploreMode,
    supportsReferenceImages: model.supportsReferenceImages,
    supportsReferenceVideos: model.supportsReferenceVideos,
    maxReferenceImages: model.maxReferenceImages,
    maxReferenceVideos: model.maxReferenceVideos
  };
}

function toV1VideoGeneration(task) {
  return toV1Video(task, 'video.generation');
}

function toV1Video(task, object = 'video') {
  return {
    id: task.id,
    object,
    created: toUnixSeconds(task.createdAt),
    model: task.model,
    status: toV1TaskStatus(task.status),
    runway_task_id: task.runwayTaskId,
    account_id: task.accountId,
    account_name: task.accountName,
    progress: task.progress,
    video_url: task.videoUrl,
    thumbnail_url: task.thumbnailUrl,
    error: ['failed', 'cancelled'].includes(task.status)
      ? {
          message: task.errorSummary || task.errorCode || (task.status === 'cancelled' ? '任务已取消' : '任务失败'),
          code: task.errorCode,
          category: task.errorCategory,
          detail: task.errorDetail || task.error
        }
      : null,
    metadata: {
      raw_status: task.rawStatus,
      prompt: task.prompt,
      duration: task.duration,
      resolution: task.resolution,
      aspect_ratio: task.aspectRatio,
      generate_audio: task.generateAudio,
      explore_mode: task.exploreMode,
      parent_task_id: task.parentTaskId,
      assets: (task.assets || []).map((asset) => ({
        id: asset.id,
        filename: asset.filename,
        mime_type: asset.mimeType,
        media_type: asset.mediaType,
        size: asset.size,
        runway_asset_id: asset.runwayAssetId,
        runway_url: asset.runwayUrl,
        preview_url: asset.previewUrl
      })),
      created_at: task.createdAt,
      updated_at: task.updatedAt,
      submitted_at: task.submittedAt,
      completed_at: task.completedAt
    }
  };
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
  return {
    ...item,
    id: item.id && !duplicateId ? item.id : randomUUID(),
    name: item.name || item.accountName || item.displayName || (duplicateId ? `${duplicateId.name}（导入）` : '导入账号'),
    remark: item.remark ?? item.note ?? item.description ?? null,
    jwt: normalizeBearerToken(pickFirst(item, credentials, ['authorization', 'auth', 'jwt', 'bearer', 'accessToken', 'access_token', 'token'])),
    cookieHeader: normalizeCookieHeader(pickFirst(item, credentials, ['cookieHeader', 'cookie_header', 'cookie', 'cookies'])),
    teamId: pickFirst(item, credentials, ['teamId', 'team_id', 'team']),
    assetGroupId: pickFirst(item, credentials, ['assetGroupId', 'asset_group_id', 'assetGroup']),
    clientId: pickFirst(item, credentials, ['clientId', 'client_id', 'client']),
    sourceApplicationVersion: pickFirst(item, credentials, [
      'sourceApplicationVersion',
      'source_application_version',
      'sourceVersion',
      'source_version',
      'runwaySourceVersion'
    ]),
    isActive: pickFirst(item, credentials, ['isActive', 'is_active', 'enabled', 'active']) ?? 1,
    maxConcurrent: pickFirst(item, credentials, ['maxConcurrent', 'max_concurrent', 'concurrency']),
    proxyId: pickFirst(item, credentials, ['proxyId', 'proxy_id']) || null,
    proxyStrategy: pickFirst(item, credentials, ['proxyStrategy', 'proxy_strategy']),
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
