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

  it('auto-assigns unused proxies and avoids sharing them across accounts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-api-test-'));
    const db = new RunwayDatabase(path.join(dir, 'test.sqlite'));
    const first = db.createProxy({ name: 'p1', url: 'one.test:8000' });
    const second = db.createProxy({ name: 'p2', url: 'two.test:8000' });
    const accountA = db.createAccount({ name: 'a', proxyId: null, proxyStrategy: 'fixed' });
    const accountB = db.createAccount({ name: 'b', proxyId: null, proxyStrategy: 'fixed' });
    const manager = new ProxyManager({ db });

    expect(manager.resolveForAccount(accountA).proxy.id).toBe(first.id);
    expect(manager.resolveForAccount(accountB).proxy.id).toBe(second.id);
    expect(db.getAccount(accountA.id).proxyId).toBe(first.id);
    expect(db.getAccount(accountB.id).proxyId).toBe(second.id);
    db.close();
  });

  it('ignores inactive account bindings when selecting an unused proxy', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-api-test-'));
    const db = new RunwayDatabase(path.join(dir, 'test.sqlite'));
    const proxy = db.createProxy({ name: 'p1', url: 'one.test:8000' });
    db.createAccount({ name: 'disabled', proxyId: proxy.id, proxyStrategy: 'fixed', isActive: false });
    const active = db.createAccount({ name: 'active', proxyId: null, proxyStrategy: 'fixed' });
    const manager = new ProxyManager({ db });

    expect(manager.resolveForAccount(active).proxy.id).toBe(proxy.id);
    expect(db.getAccount(active.id).proxyId).toBe(proxy.id);
    db.close();
  });

  it('rotates failed proxy to an unused replacement before falling back to direct', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-api-test-'));
    const db = new RunwayDatabase(path.join(dir, 'test.sqlite'));
    const failed = db.createProxy({ name: 'p1', url: 'one.test:8000' });
    const used = db.createProxy({ name: 'p2', url: 'two.test:8000' });
    const replacement = db.createProxy({ name: 'p3', url: 'three.test:8000' });
    const account = db.createAccount({ name: 'a', proxyId: failed.id, proxyStrategy: 'fixed' });
    db.createAccount({ name: 'b', proxyId: used.id, proxyStrategy: 'fixed' });
    const manager = new ProxyManager({ db });

    const next = manager.handleProxyFailure(account, failed, 'connect ETIMEDOUT one.test:8000');

    expect(next.id).toBe(replacement.id);
    expect(db.getProxy(failed.id).isActive).toBe(false);
    expect(db.getAccount(account.id).proxyId).toBe(replacement.id);
    db.close();
  });

  it('disables failed proxy and falls back to direct when no replacement exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-api-test-'));
    const db = new RunwayDatabase(path.join(dir, 'test.sqlite'));
    const proxy = db.createProxy({ name: 'p1', url: 'one.test:8000' });
    const account = db.createAccount({ name: 'a', proxyId: proxy.id, proxyStrategy: 'fixed' });
    const manager = new ProxyManager({ db });

    const next = manager.handleProxyFailure(account, proxy, 'connect ETIMEDOUT one.test:8000');

    expect(next).toBeNull();
    expect(db.getProxy(proxy.id).isActive).toBe(false);
    expect(db.getAccount(account.id).proxyId).toBeNull();
    expect(manager.resolveForAccount(db.getAccount(account.id)).proxy).toBeNull();
    db.close();
  });
});
