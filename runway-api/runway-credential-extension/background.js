const RUNWAY_API_FILTER = { urls: ['https://api.runwayml.com/*'] };
const RUNWAY_COOKIE_URLS = ['https://app.runwayml.com/', 'https://api.runwayml.com/'];
const STATE_KEY = 'runwayCredentialState';
const IMPORT_TIMEOUT_MS = 15000;

chrome.webRequest.onBeforeSendHeaders.addListener(
  async (details) => {
    const headers = Object.fromEntries(
      (details.requestHeaders || []).map((header) => [header.name.toLowerCase(), header.value || ''])
    );
    const authorization = headers.authorization || '';
    const cookieHeader = headers.cookie || await getCookieHeader();
    const patch = {
      authorization,
      jwt: normalizeBearerToken(authorization),
      cookieHeader,
      clientId: headers['x-runway-client-id'] || null,
      sourceApplicationVersion: headers['x-runway-source-application-version'] || null,
      capturedFromUrl: details.url,
      capturedAt: new Date().toISOString()
    };
    await mergeState(compact(patch));
  },
  RUNWAY_API_FILTER,
  ['requestHeaders', 'extraHeaders']
);

chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    const patch = extractIdsFromRequest(details.url, details.requestBody);
    if (Object.keys(patch).length) await mergeState({ ...patch, capturedAt: new Date().toISOString() });
  },
  RUNWAY_API_FILTER,
  ['requestBody']
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch((err) => {
    sendResponse({ ok: false, error: err.message || String(err) });
  });
  return true;
});

async function handleMessage(message = {}) {
  if (message.type === 'get-state') {
    await refreshCookieState();
    const { [STATE_KEY]: state = {} } = await chrome.storage.local.get(STATE_KEY);
    return { ok: true, state: buildAccountExport(state) };
  }
  if (message.type === 'clear-state') {
    await chrome.storage.local.remove(STATE_KEY);
    return { ok: true };
  }
  if (message.type === 'save-settings') {
    await chrome.storage.local.set({
      runwayApiSettings: {
        serverUrl: normalizeServerUrl(message.serverUrl),
        apiKey: String(message.apiKey || '').trim()
      }
    });
    return { ok: true };
  }
  if (message.type === 'get-settings') {
    const { runwayApiSettings = {} } = await chrome.storage.local.get('runwayApiSettings');
    return { ok: true, settings: runwayApiSettings };
  }
  if (message.type === 'import') {
    const { runwayApiSettings = {} } = await chrome.storage.local.get('runwayApiSettings');
    const serverUrl = normalizeServerUrl(message.serverUrl || runwayApiSettings.serverUrl);
    const apiKey = String(message.apiKey || runwayApiSettings.apiKey || '').trim();
    if (!serverUrl) throw new Error('请填写 runway-api 服务器地址');
    if (!apiKey) throw new Error('请填写 INTERNAL_API_KEY');
    await refreshCookieState();
    const { [STATE_KEY]: state = {} } = await chrome.storage.local.get(STATE_KEY);
    const account = buildAccountExport(state);
    validateAccount(account);
    const response = await fetchWithTimeout(`${serverUrl}/api/plugin/accounts/import`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ accounts: [account] })
    }, IMPORT_TIMEOUT_MS).catch((err) => {
      throw new Error(describeFetchFailure(serverUrl, err));
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || body.error || `导入失败：HTTP ${response.status}`);
    await chrome.storage.local.set({ runwayApiSettings: { serverUrl, apiKey } });
    return { ok: true, result: body };
  }
  return { ok: false, error: 'unknown message type' };
}

async function refreshCookieState() {
  const cookieHeader = await getCookieHeader();
  if (cookieHeader) await mergeState({ cookieHeader, capturedAt: new Date().toISOString() });
}

async function mergeState(patch) {
  const { [STATE_KEY]: current = {} } = await chrome.storage.local.get(STATE_KEY);
  await chrome.storage.local.set({ [STATE_KEY]: compact({ ...current, ...patch }) });
}

async function getCookieHeader() {
  const seen = new Set();
  const parts = [];
  for (const url of RUNWAY_COOKIE_URLS) {
    const cookies = await chrome.cookies.getAll({ url });
    for (const cookie of cookies) {
      const key = cookie.name;
      if (seen.has(key)) continue;
      seen.add(key);
      parts.push(`${cookie.name}=${cookie.value}`);
    }
  }
  return parts.join('; ');
}

function extractIdsFromRequest(url, requestBody) {
  const patch = {};
  for (const source of [url, decodeRequestBody(requestBody)]) {
    if (!source) continue;
    const teamId = matchValue(source, [
      /(?:asTeamId|teamId|team_id)["']?\s*[:=]\s*["']?(\d+)/i,
      /\/teams\/([^/?#]+)/i
    ]);
    const assetGroupId = matchValue(source, [
      /(?:assetGroupId|asset_group_id)["']?\s*[:=]\s*["']?([a-z0-9-]+)/i,
      /assetGroupId=([a-z0-9-]+)/i
    ]);
    if (teamId && !Number.isNaN(Number(teamId))) patch.teamId = Number(teamId);
    if (assetGroupId) patch.assetGroupId = assetGroupId;
  }
  return patch;
}

function decodeRequestBody(requestBody) {
  const raw = requestBody?.raw?.[0]?.bytes;
  if (!raw) return '';
  try {
    return new TextDecoder().decode(raw);
  } catch {
    return '';
  }
}

function matchValue(text, patterns) {
  for (const pattern of patterns) {
    const match = String(text).match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

function buildAccountExport(state = {}) {
  const teamId = state.teamId ? Number(state.teamId) : null;
  return compact({
    name: state.name || `Runway 插件导入 ${new Date().toLocaleString('zh-CN')}`,
    remark: '由 Chrome 插件从 Runway Web 请求抓取',
    authorization: state.authorization || (state.jwt ? `Bearer ${state.jwt}` : null),
    jwt: state.jwt || normalizeBearerToken(state.authorization),
    cookieHeader: state.cookieHeader,
    teamId: Number.isFinite(teamId) ? teamId : null,
    assetGroupId: state.assetGroupId,
    clientId: state.clientId,
    sourceApplicationVersion: state.sourceApplicationVersion,
    maxConcurrent: 2,
    generationLimit: 80,
    isActive: true,
    capturedAt: state.capturedAt,
    capturedFromUrl: state.capturedFromUrl
  });
}

function validateAccount(account) {
  if (!(account.jwt || account.authorization || account.cookieHeader)) throw new Error('还没有抓到 Authorization/JWT 或 Cookie，请刷新 Runway 页面或生成页');
  if (!account.teamId) throw new Error('还没有抓到 teamId，请打开 Runway 生成页或发起一次页面请求');
}

function normalizeBearerToken(value) {
  return String(value || '').trim().replace(/^Authorization:\s*/i, '').replace(/^Bearer\s+/i, '').trim() || null;
}

function normalizeServerUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

async function fetchWithTimeout(url, options = {}, timeoutMs = IMPORT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function describeFetchFailure(serverUrl, err) {
  const url = String(serverUrl || '').trim();
  if (err?.name === 'AbortError') {
    return `连接 runway-api 超时：${url}。请确认服务器已启动，地址可访问。`;
  }
  if (!/^https?:\/\//i.test(url)) {
    return `服务器地址必须以 http:// 或 https:// 开头：${url || '空'}`;
  }
  if (/^http:\/\/(?!127\.0\.0\.1(?::|\/|$)|localhost(?::|\/|$))/i.test(url)) {
    return `无法连接 ${url}。如果这是远程服务器，建议使用 HTTPS；Chrome 可能会拦截不安全的 HTTP 请求。原始错误：${err?.message || err}`;
  }
  return `无法连接 runway-api：${url}。请确认地址、端口、HTTPS 证书、反向代理和 INTERNAL_API_KEY。更新插件后需要在 chrome://extensions 里点击“重新加载”。原始错误：${err?.message || err}`;
}

function compact(value) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([, item]) => item !== undefined && item !== null && item !== '')
  );
}
