import { ProxyAgent } from 'proxy-agent';

export class ProxyManager {
  constructor({ db }) {
    this.db = db;
  }

  resolveForAccount(account, { preferRotate = false } = {}) {
    const strategy = normalizeProxyStrategy(account?.proxyStrategy || this.db.getRuntimeConfig().proxyStrategyDefault);
    let proxy = null;
    if (preferRotate || strategy === 'per_request') {
      proxy = this.pickNextProxy(account?.proxyId, account);
    } else if (strategy === 'fixed' || strategy === 'on_failure') {
      proxy = account?.proxyId ? this.db.getProxy(account.proxyId) : null;
      if (!proxy?.isActive || this.isProxyAssignedToOtherAccount(proxy.id, account)) {
        proxy = this.pickNextProxy(account?.proxyId, account);
      }
    }
    if (!proxy?.isActive) proxy = null;
    this.bindResolvedProxy(account, proxy);
    return { proxy, strategy };
  }

  rotateForAccount(account, failedProxyId = null) {
    const next = this.pickNextProxy(failedProxyId, account);
    if (account?.id) this.db.updateAccount(account.id, { proxyId: next?.id || null });
    if (account) account.proxyId = next?.id || null;
    return next;
  }

  handleProxyFailure(account, proxy, message = 'proxy failed') {
    if (!proxy?.id) return null;
    this.db.recordProxyError?.(proxy.id, message);
    this.db.setProxyActive?.(proxy.id, false);
    return this.rotateForAccount(account, proxy.id);
  }

  pickNextProxy(skipId = null, account = null) {
    const proxies = this.db.listActiveProxies();
    return proxies.find((proxy) => (
      proxy.id !== skipId &&
      !this.isProxyAssignedToOtherAccount(proxy.id, account)
    )) || null;
  }

  bindResolvedProxy(account, proxy) {
    if (!account?.id) return;
    const nextProxyId = proxy?.id || null;
    if ((account.proxyId || null) === nextProxyId) return;
    this.db.updateAccount(account.id, { proxyId: nextProxyId });
    account.proxyId = nextProxyId;
  }

  isProxyAssignedToOtherAccount(proxyId, account = null) {
    if (!proxyId || !this.db.listAccounts) return false;
    return this.db.listAccounts().some((row) => (
      row.id !== account?.id &&
      row.isActive !== false &&
      row.proxyId === proxyId
    ));
  }

  createAgent(proxy) {
    if (!proxy?.url) return null;
    return new ProxyAgent({ getProxyForUrl: () => proxy.url });
  }

  async testProxy(proxy, { timeoutMs = 15000 } = {}) {
    const agent = this.createAgent(proxy);
    const startedAt = Date.now();
    const response = await nodeFetchWithAgent('https://api.runwayml.com/v1/sessions', {
      method: 'GET',
      agent,
      timeoutMs
    });
    return {
      ok: response.status < 500,
      statusCode: response.status,
      durationMs: Date.now() - startedAt,
      body: (await response.text()).slice(0, 500)
    };
  }
}

export function normalizeProxyUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('proxy url is required');
  const st5 = /^st5\s+/i.test(raw);
  const cleaned = raw.replace(/^st5\s+/i, '');
  let url = cleaned;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    const parts = url.split(':');
    if (parts.length === 2) {
      url = `${st5 ? 'socks5' : 'http'}://${parts[0]}:${parts[1]}`;
    } else if (parts.length === 4) {
      const [host, port, user, pass] = parts;
      url = `${st5 ? 'socks5' : 'http'}://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
    } else {
      throw new Error('invalid proxy format');
    }
  }
  const parsed = new URL(url);
  const protocol = parsed.protocol.replace(':', '').toLowerCase();
  if (!['http', 'https', 'socks5', 'socks5h'].includes(protocol)) throw new Error('unsupported proxy protocol');
  if (!parsed.hostname || !parsed.port) throw new Error('proxy host and port are required');
  return { url: parsed.toString(), protocol };
}

export async function nodeFetchWithAgent(url, { method = 'GET', headers = {}, body, agent, timeoutMs = 120000 } = {}) {
  const { request } = await import(url.startsWith('https:') ? 'node:https' : 'node:http');
  const target = new URL(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const buffer = body == null
      ? null
      : body instanceof Blob
        ? Buffer.from(await body.arrayBuffer())
        : Buffer.isBuffer(body)
          ? body
          : Buffer.from(String(body));
    const requestHeaders = { ...headers };
    if (buffer && !hasHeader(requestHeaders, 'content-length')) {
      requestHeaders['Content-Length'] = String(buffer.length);
    }
    return await new Promise((resolve, reject) => {
      const req = request(target, {
        method,
        headers: requestHeaders,
        agent,
        signal: controller.signal
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const payload = Buffer.concat(chunks);
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode || 0,
            headers: {
              get(name) {
                return res.headers[String(name).toLowerCase()] || null;
              }
            },
            text: async () => payload.toString('utf8')
          });
        });
      });
      req.on('error', reject);
      if (buffer) req.write(buffer);
      req.end();
    });
  } finally {
    clearTimeout(timer);
  }
}

function hasHeader(headers, name) {
  const needle = name.toLowerCase();
  return Object.keys(headers || {}).some((key) => key.toLowerCase() === needle);
}

function normalizeProxyStrategy(value) {
  const strategy = String(value || 'fixed').trim();
  return ['fixed', 'per_request', 'on_failure'].includes(strategy) ? strategy : 'fixed';
}
