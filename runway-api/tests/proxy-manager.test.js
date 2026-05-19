import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunwayDatabase } from '../src/db.js';
import { ProxyManager, normalizeProxyUrl } from '../src/proxy-manager.js';

describe('ProxyManager', () => {
  it('normalizes Flow2API-compatible proxy formats', () => {
    expect(normalizeProxyUrl('host.test:9000').url).toBe('http://host.test:9000/');
    expect(normalizeProxyUrl('host.test:9000:user:pass').url).toBe('http://user:pass@host.test:9000/');
    expect(normalizeProxyUrl('st5 host.test:9000:user:pass').url).toBe('socks5://user:pass@host.test:9000');
  });

  it('rotates proxy when requested', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-api-test-'));
    const db = new RunwayDatabase(path.join(dir, 'test.sqlite'));
    const first = db.createProxy({ name: 'p1', url: 'one.test:8000' });
    const second = db.createProxy({ name: 'p2', url: 'two.test:8000' });
    const account = db.createAccount({ name: 'a', proxyId: first.id, proxyStrategy: 'on_failure' });
    const manager = new ProxyManager({ db });
    expect(manager.resolveForAccount(account).proxy.id).toBe(first.id);
    expect(manager.resolveForAccount(account, { preferRotate: true }).proxy.id).toBe(second.id);
    db.close();
  });
});
