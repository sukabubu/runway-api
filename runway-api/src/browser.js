import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  extractCredentialsFromRequest,
  extractCredentialsFromResponse,
  isUsableCredentialPatch
} from './runway/credentials.js';

export class RunwayBrowser {
  constructor({ config, db, proxyManager = null, logger }) {
    this.config = config;
    this.db = db;
    this.proxyManager = proxyManager;
    this.logger = logger;
    this.contexts = new Map();
    this.pages = new Map();
    this.started = false;
  }

  async start() {
    if (this.started) return;
    fs.mkdirSync(this.config.browserProfilesDir || this.config.browserProfileDir, { recursive: true });
    this.started = true;
  }

  async openRunway(accountId = null) {
    await this.start();
    const account = accountId
      ? this.db.getAccount(accountId, { includeSecret: true })
      : this.db.createAccount({
          name: `网页登录 ${new Date().toLocaleString('zh-CN')}`,
          remark: '等待网页登录抓取凭证'
        });
    if (!account) {
      const err = new Error('account not found');
      err.statusCode = 404;
      throw err;
    }
    const context = await this.ensureContext(account.id);
    let page = this.pages.get(account.id);
    page = page && !page.isClosed() ? page : await context.newPage();
    this.pages.set(account.id, page);
    await page.goto('https://app.runwayml.com/video-tools/teams/guest/ai-tools/generate?mode=apps', {
      waitUntil: 'domcontentloaded'
    });
    await page.bringToFront();
    return { opened: true, accountId: account.id, url: page.url() };
  }

  async ensureContext(accountId) {
    if (this.contexts.has(accountId)) return this.contexts.get(accountId);
    const account = this.db.getAccount(accountId, { includeSecret: true });
    const proxy = this.proxyManager?.resolveForAccount(account)?.proxy || null;
    const baseDir = this.config.browserProfilesDir || path.join(this.config.dataDir || 'data', 'browser-profiles');
    const profileDir = path.join(baseDir, String(accountId));
    fs.mkdirSync(profileDir, { recursive: true });
    const launchOptions = {
      headless: this.config.browserHeadless,
      viewport: { width: 1440, height: 980 }
    };
    if (proxy?.url) launchOptions.proxy = toPlaywrightProxy(proxy.url);
    const context = await chromium.launchPersistentContext(profileDir, launchOptions);
    context.on('page', (page) => this.attachPage(page, accountId));
    for (const page of context.pages()) this.attachPage(page, accountId);
    this.contexts.set(accountId, context);
    this.pages.set(accountId, context.pages()[0] || await context.newPage());
    return context;
  }

  attachPage(page, accountId) {
    if (page.__runwayApiAttached) return;
    page.__runwayApiAttached = true;
    page.on('request', async (request) => {
      const url = request.url();
      if (!url.includes('api.runwayml.com')) return;
      const headers = await request.allHeaders().catch(() => request.headers());
      const patch = extractCredentialsFromRequest({
        url,
        method: request.method(),
        headers,
        postData: request.postData()
      });
      if (isUsableCredentialPatch(patch)) this.db.upsertAccountCredentials(accountId, patch);
    });
    page.on('response', async (response) => {
      const url = response.url();
      if (!url.includes('api.runwayml.com')) return;
      const contentType = response.headers()['content-type'] || '';
      if (!contentType.includes('application/json')) return;
      try {
        const patch = extractCredentialsFromResponse({ url, text: await response.text() });
        const cookieHeader = await this.cookieHeaderForAccount(accountId);
        if (cookieHeader) patch.cookieHeader = cookieHeader;
        if (isUsableCredentialPatch(patch)) this.db.upsertAccountCredentials(accountId, patch);
      } catch (err) {
        this.logger.debug?.({ err }, 'failed to inspect Runway response');
      }
    });
  }

  async cookieHeaderForAccount(accountId) {
    const context = this.contexts.get(accountId);
    if (!context) return null;
    const cookies = await context.cookies(['https://app.runwayml.com/', 'https://api.runwayml.com/']).catch(() => []);
    if (!cookies.length) return null;
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  }

  status() {
    const pages = [...this.contexts.values()].reduce((count, context) => count + context.pages().length, 0);
    return {
      started: this.started,
      contexts: this.contexts.size,
      pages,
      headless: this.config.browserHeadless
    };
  }

  async close() {
    for (const context of this.contexts.values()) await context.close();
    this.contexts.clear();
    this.pages.clear();
    this.started = false;
  }
}

function toPlaywrightProxy(proxyUrl) {
  const parsed = new URL(proxyUrl);
  const protocol = parsed.protocol === 'socks5h:' ? 'socks5:' : parsed.protocol;
  const proxy = {
    server: `${protocol}//${parsed.hostname}:${parsed.port}`
  };
  if (parsed.username) proxy.username = decodeURIComponent(parsed.username);
  if (parsed.password) proxy.password = decodeURIComponent(parsed.password);
  return proxy;
}
