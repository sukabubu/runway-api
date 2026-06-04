import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { RUNWAY_ENDPOINTS, RUNWAY_HOST, findRunwayModel, mapRunwayStatus } from './config.js';
import { nodeFetchWithAgent } from '../proxy-manager.js';

const RETRY_BACKOFF_MS = [1000, 3000, 7000];
const RETRYABLE_STATUS = new Set([0, 408, 429, 500, 502, 503, 504]);

export class RunwayClient {
  constructor({ db, proxyManager = null, fetchImpl = fetch, nodeFetchWithAgentImpl = nodeFetchWithAgent }) {
    this.db = db;
    this.proxyManager = proxyManager;
    this.fetch = fetchImpl;
    this.nodeFetchWithAgent = nodeFetchWithAgentImpl;
  }

  async call(method, endpoint, body = null, opts = {}) {
    let account = opts.account || (opts.accountId ? this.db.getAccount(opts.accountId, { includeSecret: true }) : null);
    let creds = account ? accountToCredentials(account) : this.db.getCredentials();
    if (!creds?.jwt && creds?.cookie_header && account?.id) {
      account = await this.refreshAccountJwt(account);
      creds = accountToCredentials(account);
    }
    if (!creds?.jwt) {
      const err = new Error('Runway credentials are not ready. Add JWT or a valid Cookie first.');
      err.code = 'NO_RUNWAY_CREDENTIALS';
      err.statusCode = 409;
      throw err;
    }

    let url = `${RUNWAY_HOST}${endpoint}`;
    if (opts.query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(opts.query)) {
        if (value != null) params.append(key, String(value));
      }
      const query = params.toString();
      if (query) url += `?${query}`;
    }

    const headers = buildRunwayHeaders(creds);

    const operation = opts.operation || `runway:${endpoint.split('?')[0]}`;
    const runtime = this.db.getRuntimeConfig?.() || defaultRuntimeConfig();
    const effective = effectiveRuntime(runtime, account);
    if (opts.maxRetries != null) effective.maxRetries = Number(opts.maxRetries) || 0;
    const requestBody = body != null && method !== 'GET' ? JSON.stringify(body) : undefined;
    const retryBackoff = effective.retryBackoffMs.length ? effective.retryBackoffMs : RETRY_BACKOFF_MS;
    let lastErr = null;
    let lastProxyId = null;
    for (let attempt = 0; attempt <= effective.maxRetries; attempt++) {
      const startedAt = Date.now();
      let proxy = null;
      let response = null;
      try {
        proxy = this.resolveProxy(account, { preferRotate: account?.proxyStrategy === 'per_request' || attempt > 0 });
        if (runtime.forceProxy && !proxy) {
          const err = new Error('force proxy is enabled but no proxy is available');
          err.code = 'NO_PROXY_AVAILABLE';
          err.status = 409;
          throw err;
        }
        lastProxyId = proxy?.id || null;
        response = await this.fetchWithRuntime(url, {
          method,
          headers,
          body: requestBody,
          timeoutMs: effective.requestTimeoutMs,
          proxy
        });
        const text = await response.text();
        const parsed = parseResponseText(text);
        this.db.logRequest?.({
          accountId: account?.id,
          proxyId: proxy?.id,
          operation,
          status: response.ok ? 'success' : 'failed',
          statusCode: response.status,
          durationMs: Date.now() - startedAt,
          message: `${method} ${endpoint}`,
          requestBody: body,
          responseBody: parsed
        });
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            if (!opts.skipJwtRefresh && account?.cookieHeader) {
              try {
                const refreshedAccount = await this.refreshAccountJwt(account);
                return this.call(method, endpoint, body, { ...opts, account: refreshedAccount, skipJwtRefresh: true });
              } catch (refreshErr) {
                refreshErr.originalStatus = response.status;
              }
            }
            this.handleAuthFailed(account, `Runway ${method} ${endpoint} returned ${response.status}`);
          }
          const err = new Error(`Runway ${method} ${endpoint} returned ${response.status}`);
          err.code = response.status === 401 || response.status === 403 ? 'AUTH_FAILED' : 'RUNWAY_REQUEST_FAILED';
          err.status = response.status;
          err.body = parsed;
          throw err;
        }
        if (proxy?.id) this.db.recordProxyUse?.(proxy.id);
        return parsed;
      } catch (err) {
        lastErr = err;
        if (proxy?.id && isProxyTransportError(err)) this.handleProxyTransportFailure(account, proxy, err);
        if (err.code === 'AUTH_FAILED' || err.status === 401 || err.status === 403) throw err;
        this.db.logRequest?.({
          accountId: account?.id,
          proxyId: proxy?.id || lastProxyId,
          operation,
          status: 'failed',
          statusCode: err.status || err.statusCode || null,
          durationMs: Date.now() - startedAt,
          message: err.message,
          requestBody: body,
          responseBody: err.body || null
        });
        if (!isRetryableError(err, err.status || err.statusCode) || attempt >= effective.maxRetries) throw err;
        await delay(retryBackoff[Math.min(attempt, retryBackoff.length - 1)] || 1000);
      }
    }
    throw lastErr;
  }

  resolveProxy(account, { preferRotate = false } = {}) {
    if (!this.proxyManager) return null;
    const { proxy } = this.proxyManager.resolveForAccount(account, { preferRotate });
    return proxy || null;
  }

  async fetchWithRuntime(url, { method, headers, body, timeoutMs, proxy }) {
    const agent = proxy ? this.proxyManager.createAgent(proxy) : null;
    if (agent) return this.nodeFetchWithAgent(url, { method, headers, body, agent, timeoutMs });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetch(url, { method, headers, body, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  handleAuthFailed(account, message) {
    if (account?.id && this.db.markAccountAuthFailed) {
      this.db.markAccountAuthFailed(account.id, message);
    } else {
      this.db.invalidateCredentials();
    }
  }

  handleProxyTransportFailure(account, proxy, err) {
    if (!this.proxyManager?.handleProxyFailure) {
      this.db.recordProxyError?.(proxy.id, err.message);
      return;
    }
    const next = this.proxyManager.handleProxyFailure(account, proxy, err.message);
    if (account) account.proxyId = next?.id || null;
  }

  async refreshAccountJwt(account) {
    if (!account?.id || !account.cookieHeader) {
      const err = new Error('Cookie is required to refresh Runway JWT');
      err.code = 'NO_COOKIE';
      err.statusCode = 409;
      throw err;
    }
    const patch = await this.refreshJwtWithCookie(account);
    const next = this.db.upsertAccountCredentials(account.id, {
      ...patch,
      cookieHeader: patch.cookieHeader || account.cookieHeader,
      teamId: patch.teamId ?? account.teamId,
      assetGroupId: patch.assetGroupId ?? account.assetGroupId,
      clientId: patch.clientId ?? account.clientId,
      sourceApplicationVersion: patch.sourceApplicationVersion ?? account.sourceApplicationVersion
    });
    this.db.logRequest?.({
      accountId: account.id,
      operation: 'jwt_refresh',
      status: 'success',
      message: '已通过 Cookie 刷新 Runway JWT'
    });
    return next;
  }

  async refreshJwtWithCookie(account) {
    const runtime = this.db.getRuntimeConfig?.() || defaultRuntimeConfig();
    const effective = effectiveRuntime(runtime, account);
    const endpoints = [RUNWAY_ENDPOINTS.sessions, RUNWAY_ENDPOINTS.profile];
    let lastErr = null;
    for (const endpoint of endpoints) {
      const startedAt = Date.now();
      const proxy = this.resolveProxy(account, { preferRotate: account.proxyStrategy === 'per_request' });
      try {
        const headers = buildRunwayHeaders(accountToCredentials({ ...account, jwt: null }), { includeAuth: false });
        const response = await this.fetchWithRuntime(`${RUNWAY_HOST}${endpoint}`, {
          method: 'GET',
          headers,
          timeoutMs: effective.requestTimeoutMs,
          proxy
        });
        const text = await response.text();
        const parsed = parseResponseText(text);
        const setCookie = response.headers.get('set-cookie') || response.headers.get('Set-Cookie');
        this.db.logRequest?.({
          accountId: account.id,
          proxyId: proxy?.id,
          operation: `jwt_refresh:${endpoint}`,
          status: response.ok ? 'success' : 'failed',
          statusCode: response.status,
          durationMs: Date.now() - startedAt,
          message: `GET ${endpoint}`,
          responseBody: parsed
        });
        if (!response.ok) {
          const err = new Error(`Runway Cookie refresh ${endpoint} returned ${response.status}`);
          err.status = response.status;
          err.body = parsed;
          throw err;
        }
        const jwt = extractJwtFromRefreshResponse(response, parsed);
        const patch = extractCredentialPatchFromRefresh(parsed);
        if (setCookie) patch.cookieHeader = mergeCookieHeaders(account.cookieHeader, setCookie);
        if (jwt) patch.jwt = jwt;
        if (patch.jwt) return patch;
        lastErr = new Error(`Runway Cookie refresh ${endpoint} did not return JWT`);
        lastErr.code = 'JWT_NOT_RETURNED';
        lastErr.body = parsed;
      } catch (err) {
        lastErr = err;
        this.db.logRequest?.({
          accountId: account.id,
          proxyId: proxy?.id,
          operation: `jwt_refresh:${endpoint}`,
          status: 'failed',
          statusCode: err.status || err.statusCode || null,
          durationMs: Date.now() - startedAt,
          message: err.message,
          responseBody: err.body || null
        });
        if (err.status === 401 || err.status === 403) break;
      }
    }
    const err = new Error(lastErr?.message || 'Runway Cookie refresh failed');
    err.code = lastErr?.code || 'COOKIE_REFRESH_FAILED';
    err.status = lastErr?.status || lastErr?.statusCode || 401;
    err.body = lastErr?.body || null;
    throw err;
  }

  async uploadAsset(asset, opts = {}) {
    const account = opts.account || (opts.accountId ? this.db.getAccount(opts.accountId, { includeSecret: true }) : null);
    const file = fs.openAsBlob
      ? await fs.openAsBlob(asset.localPath, { type: asset.mimeType || 'application/octet-stream' })
      : new Blob([await fs.promises.readFile(asset.localPath)], { type: asset.mimeType || 'application/octet-stream' });
    const mediaType = getAssetMediaType(asset);
    if (!['image', 'video'].includes(mediaType)) {
      const err = new Error('only image and video uploads are supported');
      err.statusCode = 400;
      throw err;
    }
    if (file.size > 200 * 1024 * 1024) {
      const err = new Error(`${mediaType} is too large (${file.size} bytes), max is 200MB`);
      err.statusCode = 400;
      throw err;
    }

    const uploadOneSlot = async (filename) => {
      const slot = await this.call('POST', RUNWAY_ENDPOINTS.uploads, {
        filename,
        numberOfParts: 1,
        type: 'DATASET'
      }, opts);
      if (!slot?.uploadUrls?.[0]) {
        throw new Error(`Runway upload slot did not include uploadUrls: ${JSON.stringify(slot)}`);
      }
      const runtime = this.db.getRuntimeConfig?.() || defaultRuntimeConfig();
      const effective = effectiveRuntime(runtime, account);
      const { etag } = await putToPresignedUrl(this.fetch, slot.uploadUrls[0], file, slot.uploadHeaders || {}, {
        timeoutMs: computeUploadTimeoutMs(file.size, effective),
        retryBackoffMs: effective.retryBackoffMs,
        maxRetries: effective.maxRetries,
        proxyProvider: (preferRotate = false) => this.resolveProxy(opts.account || account, { preferRotate }),
        proxyManager: this.proxyManager,
        nodeFetchWithAgent: this.nodeFetchWithAgent,
        db: this.db,
        account: opts.account || account,
        accountId: (opts.account || account)?.id,
        operation: 's3:put'
      });
      await this.call('POST', RUNWAY_ENDPOINTS.uploadComplete(slot.id), {
        parts: [{ PartNumber: 1, ETag: etag || '' }]
      }, opts);
      return slot.id;
    };

    const uploadId = await uploadOneSlot(asset.filename);
    const previewUploadId = await uploadOneSlot(`preview_${asset.filename}`);
    const creds = account ? accountToCredentials(account) : this.db.getCredentials();
    const datasetReq = {
      fileCount: 1,
      name: asset.filename,
      uploadId,
      previewUploadIds: [previewUploadId],
      metadata: opts.metadata || {},
      type: { name: mediaType, type: mediaType, isDirectory: false }
    };
    if (creds?.team_id && Number(creds.team_id) > 0) datasetReq.asTeamId = Number(creds.team_id);

    const datasetResp = await this.call('POST', RUNWAY_ENDPOINTS.datasets, datasetReq, opts);
    const dataset = datasetResp?.dataset;
    if (!dataset?.id || !dataset?.url) {
      throw new Error(`Runway dataset response is incomplete: ${JSON.stringify(datasetResp)}`);
    }
    return {
      assetId: dataset.id,
      url: dataset.url,
      previewUrl: dataset.previewUrls?.[0] || null
    };
  }

  async submitTask(task, assets = [], opts = {}) {
    const model = findRunwayModel(task.model);
    const uploadedReferences = assets
      .filter((asset) => asset.runwayAssetId && asset.runwayUrl)
      .map((asset) => ({
        assetId: asset.runwayAssetId,
        url: asset.runwayUrl,
        previewUrl: asset.previewUrl || null,
        mediaType: getAssetMediaType(asset)
      }));
    const referenceImages = uploadedReferences
      .filter((asset) => asset.mediaType === 'image')
      .map(({ assetId, url, previewUrl }) => ({ assetId, url, previewUrl }));
    const referenceVideos = uploadedReferences
      .filter((asset) => asset.mediaType === 'video')
      .map(({ assetId, url, previewUrl }) => ({ assetId, url, previewUrl }));
    if (referenceImages.length > (model.maxReferenceImages || 0)) {
      const err = new Error(`too many reference images, max is ${model.maxReferenceImages || 0}`);
      err.statusCode = 400;
      throw err;
    }
    if (referenceVideos.length && !model.supportsReferenceVideos) {
      const err = new Error(`${model.label} does not support reference videos`);
      err.statusCode = 400;
      throw err;
    }
    if (referenceVideos.length > (model.maxReferenceVideos || 0)) {
      const err = new Error(`too many reference videos, max is ${model.maxReferenceVideos || 0}`);
      err.statusCode = 400;
      throw err;
    }
    if ((model.kind || 'video') === 'image') {
      return this.submitImageTask(task, { model, referenceImages, referenceVideos }, opts);
    }
    return this.submitVideoTask(task, { model, referenceImages, referenceVideos }, opts);
  }

  async submitVideoTask(task, { model, referenceImages, referenceVideos }, opts = {}) {
    const taskId = randomUUID();
    const options = {
      name: `${model.label} - ${task.prompt.slice(0, 30)}`,
      textPrompt: task.prompt,
      duration: task.duration,
      aspectRatio: task.aspectRatio,
      resolution: task.resolution,
      generateAudio: task.generateAudio !== false && model.supportsAudio,
      exploreMode: task.exploreMode !== false && model.supportsExploreMode,
      creationSource: 'tool-mode',
      taskId
    };
    if (referenceImages.length) options.referenceImages = referenceImages;
    if (referenceVideos.length) options.referenceVideos = referenceVideos;
    return this.submitRunwayTask({ taskType: model.taskType, options }, taskId, opts);
  }

  async submitImageTask(task, { model, referenceImages, referenceVideos }, opts = {}) {
    if (referenceVideos.length) {
      const err = new Error(`${model.label} does not support reference videos`);
      err.statusCode = 400;
      throw err;
    }
    const taskId = randomUUID();
    const options = {
      name: `${model.label} - ${task.prompt.slice(0, 30)}`,
      prompt: task.prompt,
      size: runwayImageSize(task.resolution || model.defaultResolution || '1K'),
      aspectRatio: task.aspectRatio || model.defaultAspectRatio || '1:1',
      quality: task.quality || model.defaultQuality || 'high',
      numImages: task.numImages || model.defaultNumImages || 1,
      exploreMode: task.exploreMode !== false && model.supportsExploreMode,
      creationSource: 'tool-mode'
    };
    if (referenceImages.length) {
      options.referenceImages = referenceImages.map((reference) => ({
        url: reference.url,
        ...(reference.assetId ? { assetId: reference.assetId } : {}),
        ...(reference.width ? { width: reference.width } : {}),
        ...(reference.height ? { height: reference.height } : {}),
        tag: 'reference'
      }));
    }
    return this.submitRunwayTask({ taskType: model.taskType, options }, taskId, opts);
  }

  async submitRunwayTask(payload, taskId, opts = {}) {
    const account = opts.account || (opts.accountId ? this.db.getAccount(opts.accountId, { includeSecret: true }) : null);
    const creds = account ? accountToCredentials(account) : this.db.getCredentials();
    if (creds?.asset_group_id) payload.options.assetGroupId = creds.asset_group_id;
    const body = { ...payload };
    if (creds?.team_id && Number(creds.team_id) > 0) body.asTeamId = Number(creds.team_id);

    const resp = await this.call('POST', RUNWAY_ENDPOINTS.tasks, body, opts);
    const node = resp?.task || resp;
    return {
      taskId: node?.id || taskId,
      rawStatus: node?.status || 'PENDING',
      status: mapRunwayStatus(node?.status || 'PENDING'),
      rawResponse: resp
    };
  }

  async canStartTask(task, opts = {}) {
    const model = findRunwayModel(task.model);
    const account = opts.account || (opts.accountId ? this.db.getAccount(opts.accountId, { includeSecret: true }) : null);
    const creds = account ? accountToCredentials(account) : this.db.getCredentials();
    const body = {
      feature: model.canStartFeature || model.estimateFeature || model.taskType,
      taskType: model.taskType
    };
    if (creds?.team_id && Number(creds.team_id) > 0) body.asTeamId = Number(creds.team_id);
    try {
      const resp = await this.call('POST', RUNWAY_ENDPOINTS.canStart, body, {
        ...opts,
        account,
        operation: 'runway:can_start',
        maxRetries: 0
      });
      return parseCanStartResponse(resp);
    } catch (err) {
      if (err.code === 'AUTH_FAILED') throw err;
      if (isCanStartUnavailable(err)) {
        this.db.logRequest?.({
          accountId: account?.id,
          operation: 'runway:can_start',
          status: 'skipped',
          statusCode: err.status || err.statusCode || null,
          message: `can_start unavailable: ${err.message}`,
          responseBody: err.body || null
        });
        return { ok: true, reason: 'can_start_unavailable', rawResponse: err.body || null, skipped: true };
      }
      if (isTooManyRunwayTasksError(err)) return { ok: false, reason: 'too_many_tasks', rawResponse: err.body || null };
      throw err;
    }
  }

  async pollTask(runwayTaskId, opts = {}) {
    const resp = await this.call('GET', RUNWAY_ENDPOINTS.task(runwayTaskId), null, opts);
    return parseRunwayTaskResponse(resp);
  }

  async cancelTask(runwayTaskId, opts = {}) {
    const attempts = [
      ['POST', RUNWAY_ENDPOINTS.taskCancel(runwayTaskId), {}],
      ['DELETE', RUNWAY_ENDPOINTS.task(runwayTaskId), null],
      ['PATCH', RUNWAY_ENDPOINTS.task(runwayTaskId), { status: 'CANCELED' }]
    ];
    let lastError;
    for (const [method, endpoint, body] of attempts) {
      try {
        const resp = await this.call(method, endpoint, body, {
          ...opts,
          operation: opts.operation || 'runway:cancel',
          maxRetries: 0
        });
        return {
          ok: true,
          rawResponse: resp
        };
      } catch (err) {
        lastError = err;
        if (err.code === 'AUTH_FAILED') throw err;
        if (![404, 405].includes(Number(err.status || err.statusCode))) throw err;
      }
    }
    throw lastError;
  }

  async getAccountCredits(account) {
    const featuresResp = await this.call('GET', RUNWAY_ENDPOINTS.profileFeatures, null, {
      account,
      operation: 'runway:credits_features'
    });
    const permitted = featuresResp?.features?.permitted || featuresResp?.permitted || {};
    const creditFields = collectCreditFields(featuresResp);
    return {
      queriedAt: new Date().toISOString(),
      planCredits: toNumberOrNull(permitted.numPlanCredits),
      planCreditsResetMonthly: typeof permitted.numPlanCreditsResetsMonthly === 'boolean'
        ? permitted.numPlanCreditsResetsMonthly
        : null,
      creditDiscountPercent: toNumberOrNull(permitted.creditDiscountPercent),
      remainingCredits: firstNumber(creditFields, [
        'remainingCredits',
        'creditsRemaining',
        'availableCredits',
        'creditBalance',
        'balanceCredits',
        'remaining'
      ]),
      usedCredits: firstNumber(creditFields, ['usedCredits', 'creditsUsed', 'usageCredits', 'used']),
      creditFields
    };
  }
}

function accountToCredentials(account) {
  return {
    jwt: account.jwt,
    cookie_header: account.cookieHeader,
    team_id: account.teamId,
    asset_group_id: account.assetGroupId,
    client_id: account.clientId,
    source_application_version: account.sourceApplicationVersion
  };
}

function runwayImageSize(resolution) {
  return {
    '1K': '1',
    '2K': '2',
    '4K': '4'
  }[String(resolution || '').toUpperCase()] || '1';
}

function buildRunwayHeaders(creds, { includeAuth = true } = {}) {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Runway-Source-Application': 'web'
  };
  if (includeAuth && creds.jwt) headers.Authorization = `Bearer ${creds.jwt}`;
  if (creds.client_id) headers['X-Runway-Client-Id'] = creds.client_id;
  if (creds.source_application_version) {
    headers['X-Runway-Source-Application-Version'] = creds.source_application_version;
  }
  if (creds.team_id && Number(creds.team_id) > 0) {
    headers['X-Runway-Workspace'] = String(creds.team_id);
  }
  if (creds.cookie_header) headers.Cookie = creds.cookie_header;
  return headers;
}

function getAssetMediaType(asset) {
  if (asset.mediaType) return String(asset.mediaType).toLowerCase();
  const mime = String(asset.mimeType || '').toLowerCase();
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  const ext = path.extname(asset.filename || asset.localPath || '').toLowerCase();
  if (['.mp4', '.mov', '.webm', '.m4v'].includes(ext)) return 'video';
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) return 'image';
  return 'unknown';
}

export function parseRunwayTaskResponse(resp) {
  const node = resp?.task || resp;
  if (!node?.id) {
    throw new Error(`Runway task response is missing task.id: ${JSON.stringify(resp).slice(0, 200)}`);
  }
  const artifacts = Array.isArray(node.artifacts) ? node.artifacts : [];
  const resultUrl = firstResultUrl(node, artifacts);
  const progressRatio = node.progressRatio != null ? Number(node.progressRatio) : null;
  return {
    taskId: node.id,
    status: mapRunwayStatus(node.status),
    rawStatus: node.status,
    progress: progressRatio != null && !Number.isNaN(progressRatio) ? Math.round(progressRatio * 100) : null,
    videoUrl: resultUrl,
    thumbnailUrl: artifacts[0]?.previewUrls?.[0] || node.sharedAsset?.previewUrls?.[0] || node.image?.previewUrls?.[0] || null,
    error: extractTaskError(node),
    rawResponse: resp
  };
}

export function isTooManyRunwayTasksError(err) {
  const body = err?.body;
  const message = [
    err?.message,
    typeof body === 'string' ? body : null,
    body?.error,
    body?.message
  ].filter(Boolean).join(' ');
  return Number(err?.status || err?.statusCode) === 429 && /too many tasks are running or pending/i.test(message);
}

function parseCanStartResponse(resp) {
  if (resp == null) return { ok: true, reason: null, rawResponse: resp };
  const value = resp.canStart ?? resp.can_start ?? resp.ok ?? resp.allowed ?? resp.available;
  if (typeof value === 'boolean') {
    return {
      ok: value,
      reason: value ? null : extractCanStartReason(resp),
      rawResponse: resp
    };
  }
  const reason = extractCanStartReason(resp);
  if (/too many tasks are running or pending/i.test(reason || '')) {
    return { ok: false, reason, rawResponse: resp };
  }
  return { ok: true, reason: 'unknown_can_start_response', rawResponse: resp };
}

function extractCanStartReason(resp) {
  return resp?.reason || resp?.message || resp?.error || resp?.statusReason || resp?.failureReason || null;
}

function isCanStartUnavailable(err) {
  const status = Number(err?.status || err?.statusCode);
  return [404, 405, 501].includes(status);
}

function firstResultUrl(node, artifacts = []) {
  return artifacts[0]?.url ||
    node.sharedAsset?.url ||
    node.image?.url ||
    node.output?.url ||
    node.result?.url ||
    node.asset?.url ||
    null;
}

function extractTaskError(node) {
  if (!(node.error || node.failure || node.failureReason || node.errorReason || node.failureCode || node.errorCode || node.errorMessage || node.statusReason || node.moderation)) {
    return null;
  }
  return {
    reason: node.failureReason || node.errorReason || node.statusReason || node.failure || null,
    code: node.failureCode || node.errorCode || node.error?.code || null,
    category: node.errorCategory || node.error?.category || node.moderation?.category || null,
    message: node.errorMessage || node.message || (typeof node.error === 'string' ? node.error : null),
    raw: {
      error: node.error || null,
      failure: node.failure || null,
      failureReason: node.failureReason || null,
      errorReason: node.errorReason || null,
      failureCode: node.failureCode || null,
      errorCode: node.errorCode || null,
      errorMessage: node.errorMessage || null,
      statusReason: node.statusReason || null,
      moderation: node.moderation || null
    }
  };
}

async function putToPresignedUrl(fetchImpl, signedUrl, blob, extraHeaders = {}, opts = {}) {
  const timeoutMs = opts.timeoutMs || computeUploadTimeoutMs(blob.size);
  const backoff = opts.retryBackoffMs?.length ? opts.retryBackoffMs : RETRY_BACKOFF_MS;
  const maxRetries = opts.maxRetries ?? backoff.length;
  const headers = withContentLength(extraHeaders, blob.size);
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const proxy = attempt > 0 ? resolveUploadRetryProxy(opts, attempt > 1) : null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
      const agent = proxy && opts.proxyManager ? opts.proxyManager.createAgent(proxy) : null;
      const agentFetch = opts.nodeFetchWithAgent || nodeFetchWithAgent;
      const response = agent
        ? await agentFetch(signedUrl, {
            method: 'PUT',
            headers,
            body: blob,
            agent,
            timeoutMs
          })
        : await fetchImpl(signedUrl, {
            method: 'PUT',
            headers,
            body: blob,
            signal: controller.signal,
            duplex: 'half'
          });
      let text = '';
      if (!response.ok) {
        text = await response.text().catch(() => '');
        const err = new Error(`S3 upload failed ${response.status}: ${text}`);
        err.status = response.status;
        err.body = text;
        throw err;
      }
      opts.db?.logRequest?.({
        accountId: opts.accountId,
        proxyId: proxy?.id,
        operation: opts.operation || 's3:put',
        status: 'success',
        statusCode: response.status,
        durationMs: Date.now() - startedAt,
        message: 'PUT presigned upload'
      });
      const etag = response.headers.get('etag') || response.headers.get('ETag');
      return { etag: etag ? etag.replace(/^"|"$/g, '') : null };
    } catch (err) {
      lastErr = err;
      const retryable = isRetryableError(err, err?.status);
      opts.db?.logRequest?.({
        accountId: opts.accountId,
        proxyId: proxy?.id,
        operation: opts.operation || 's3:put',
        status: 'failed',
        statusCode: err.status || null,
        durationMs: Date.now() - startedAt,
        message: err.message,
        responseBody: err.body || null
      });
      if (proxy?.id && isProxyTransportError(err)) handleUploadProxyFailure(opts, proxy, err);
      const isLast = attempt === maxRetries;
      if (!retryable || isLast) throw err;
      await delay(backoff[Math.min(attempt, backoff.length - 1)] || 1000);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function resolveUploadRetryProxy(opts, preferRotate = false) {
  if (opts.proxyProvider) return opts.proxyProvider(preferRotate) || null;
  return opts.proxy || null;
}

function handleUploadProxyFailure(opts, proxy, err) {
  if (opts.proxyManager?.handleProxyFailure) {
    opts.proxyManager.handleProxyFailure(opts.account || null, proxy, err.message);
  } else {
    opts.db?.recordProxyError?.(proxy.id, err.message);
  }
}

function withContentLength(headers = {}, size = null) {
  const next = { ...headers };
  const hasLength = Object.keys(next).some((key) => key.toLowerCase() === 'content-length');
  if (!hasLength && Number.isFinite(Number(size))) next['Content-Length'] = String(size);
  return next;
}

function isRetryableError(err, status) {
  if (err?.name === 'AbortError') return true;
  if (status != null) {
    if (RETRYABLE_STATUS.has(status)) return true;
    return status === 400 && /RequestTimeout/i.test(err?.body || '');
  }
  return true;
}

function isProxyTransportError(err) {
  if (!err || err.status || err.statusCode) return false;
  return /AbortError|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang up|network|fetch failed|timeout/i.test(err.message || '');
}

function computeUploadTimeoutMs(byteSize, runtime = {}) {
  const sizeMb = byteSize / (1024 * 1024);
  const min = runtime.uploadTimeoutMinMs || runtime.uploadTimeoutMs || 30000;
  const max = runtime.uploadTimeoutMaxMs || runtime.uploadTimeoutMs || 120000;
  return Math.min(Math.max(min, Math.round(sizeMb * 8000)), max);
}

function parseResponseText(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

function collectCreditFields(value, prefix = '', result = {}) {
  if (!value || typeof value !== 'object') return result;
  for (const [key, child] of Object.entries(value)) {
    const pathKey = prefix ? `${prefix}.${key}` : key;
    if (/credit|balance|quota|usage/i.test(key) && ['string', 'number', 'boolean'].includes(typeof child)) {
      result[pathKey] = child;
    }
    if (child && typeof child === 'object') collectCreditFields(child, pathKey, result);
  }
  return result;
}

function firstNumber(fields, names) {
  const entries = Object.entries(fields || {});
  for (const name of names) {
    const found = entries.find(([key]) => key.split('.').pop() === name);
    const value = toNumberOrNull(found?.[1]);
    if (value != null) return value;
  }
  return null;
}

function toNumberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractJwtFromRefreshResponse(response, body) {
  const auth = response.headers.get('authorization') || response.headers.get('Authorization');
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return findJwtLikeValue(body);
}

function findJwtLikeValue(value) {
  if (!value || typeof value !== 'object') return null;
  const preferredKeys = new Set(['jwt', 'token', 'accessToken', 'access_token', 'authToken', 'authorization']);
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string') {
      const raw = child.replace(/^Bearer\s+/i, '').trim();
      if ((preferredKeys.has(key) || /jwt|token|authorization/i.test(key)) && looksLikeJwt(raw)) return raw;
    }
  }
  for (const child of Object.values(value)) {
    const found = findJwtLikeValue(child);
    if (found) return found;
  }
  return null;
}

function extractCredentialPatchFromRefresh(body) {
  const patch = {};
  const session = body?.session || body?.userSession || body;
  const assetGroupId = body?.assetGroup?.id || session?.assetGroupId || body?.assetGroupId;
  if (assetGroupId) patch.assetGroupId = String(assetGroupId);
  const teamId = Number(session?.teamId || session?.workspaceId || body?.teamId || body?.asTeamId);
  if (Number.isFinite(teamId) && teamId > 0) patch.teamId = teamId;
  const clientId = session?.clientId || body?.clientId;
  if (clientId) patch.clientId = String(clientId);
  const sourceApplicationVersion = session?.sourceApplicationVersion || body?.sourceApplicationVersion;
  if (sourceApplicationVersion) patch.sourceApplicationVersion = String(sourceApplicationVersion);
  return patch;
}

function looksLikeJwt(value) {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(String(value || ''));
}

function mergeCookieHeaders(existing, setCookieHeader) {
  const jar = new Map();
  for (const item of String(existing || '').split(';')) {
    const [name, ...rest] = item.trim().split('=');
    if (name && rest.length) jar.set(name, rest.join('='));
  }
  for (const cookie of splitSetCookie(setCookieHeader)) {
    const [pair] = cookie.split(';');
    const [name, ...rest] = pair.trim().split('=');
    if (name && rest.length) jar.set(name, rest.join('='));
  }
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

function splitSetCookie(value) {
  if (Array.isArray(value)) return value;
  return String(value || '').split(/,(?=\s*[^;,]+=)/g).filter(Boolean);
}

function defaultRuntimeConfig() {
  return {
    requestTimeoutMs: 120000,
    uploadTimeoutMinMs: 30000,
    uploadTimeoutMaxMs: 120000,
    taskTimeoutMs: 1500000,
    maxRetries: 3,
    retryBackoffMs: RETRY_BACKOFF_MS,
    forceProxy: false
  };
}

function effectiveRuntime(runtime = defaultRuntimeConfig(), account = null) {
  return {
    requestTimeoutMs: account?.requestTimeoutMs || runtime.requestTimeoutMs || runtime.request_timeout_ms || 120000,
    uploadTimeoutMinMs: runtime.uploadTimeoutMinMs || runtime.upload_timeout_min_ms || 30000,
    uploadTimeoutMaxMs: account?.uploadTimeoutMs || runtime.uploadTimeoutMaxMs || runtime.upload_timeout_max_ms || 120000,
    taskTimeoutMs: account?.taskTimeoutMs || runtime.taskTimeoutMs || runtime.task_timeout_ms || 1500000,
    maxRetries: account?.maxRetries ?? runtime.maxRetries ?? runtime.max_retries ?? 3,
    retryBackoffMs: parseBackoff(runtime.retryBackoffMs || runtime.retry_backoff_ms),
    forceProxy: Boolean(runtime.forceProxy ?? runtime.force_proxy)
  };
}

function parseBackoff(value) {
  if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite);
  if (typeof value !== 'string') return RETRY_BACKOFF_MS;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : RETRY_BACKOFF_MS;
  } catch {
    return RETRY_BACKOFF_MS;
  }
}
