import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunwayDatabase } from '../src/db.js';
import { normalizeTaskError } from '../src/errors.js';

describe('RunwayDatabase', () => {
  it('persists credentials and task state', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-api-test-'));
    const db = new RunwayDatabase(path.join(dir, 'test.sqlite'));
    db.upsertCredentials({ jwt: 'jwt', cookieHeader: 'session=abc', teamId: 1, assetGroupId: 'asset', clientId: 'client' });
    expect(db.getCredentialStatus()).toMatchObject({ ready: true, hasTeamId: true, hasClientId: true, hasCookie: true });
    const task = db.createTask({
      id: 'task-1',
      status: 'pending',
      prompt: 'hello',
      model: 'seedance_2',
      duration: 5,
      resolution: '480p',
      aspectRatio: '16:9',
      generateAudio: true,
      exploreMode: true
    });
    expect(task.status).toBe('pending');
    db.updateTask('task-1', { status: 'completed', runwayTaskId: 'runway-1', videoUrl: 'https://video' });
    expect(db.getTask('task-1')).toMatchObject({
      status: 'completed',
      runwayTaskId: 'runway-1',
      videoUrl: 'https://video'
    });
    db.updateTask('task-1', { status: 'generating', rawStatus: 'RUNNING', progress: 10 });
    expect(db.getTask('task-1')).toMatchObject({
      status: 'generating',
      runwayTaskId: 'runway-1',
      videoUrl: 'https://video',
      progress: 10
    });
    db.close();
  });

  it('selects the least loaded ready account and skips full or disabled accounts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-api-test-'));
    const db = new RunwayDatabase(path.join(dir, 'test.sqlite'));
    const first = db.createAccount({
      name: 'a',
      jwt: 'jwt-a',
      teamId: 1,
      assetGroupId: 'asset-a',
      maxConcurrent: 2,
      inflight: 2
    });
    const second = db.createAccount({
      name: 'b',
      jwt: 'jwt-b',
      teamId: 2,
      assetGroupId: 'asset-b',
      maxConcurrent: 2,
      inflight: 1
    });
    db.createAccount({
      name: 'c',
      jwt: 'jwt-c',
      teamId: 3,
      assetGroupId: 'asset-c',
      maxConcurrent: 2,
      isActive: 0
    });
    expect(db.selectLeastLoadedAccount().id).toBe(second.id);
    expect(db.selectLeastLoadedAccount({ preferredAccountId: first.id })).toBeNull();
    db.close();
  });

  it('treats assetGroupId as optional for ready accounts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-api-test-'));
    const db = new RunwayDatabase(path.join(dir, 'test.sqlite'));
    const account = db.createAccount({
      name: 'without asset group',
      jwt: 'jwt-a',
      teamId: 1
    });
    expect(account.ready).toBe(true);
    expect(db.getAccountSummary().ready).toBe(1);
    expect(db.selectLeastLoadedAccount().id).toBe(account.id);
    db.close();
  });

  it('applies generation limits and can reset usage', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-api-test-'));
    const db = new RunwayDatabase(path.join(dir, 'test.sqlite'));
    const today = new Date().toISOString();
    const full = db.createAccount({
      name: 'full',
      jwt: 'jwt-a',
      teamId: 1,
      assetGroupId: 'asset-a',
      generationLimit: 1,
      generationUsed: 1,
      generationResetAt: today
    });
    const available = db.createAccount({
      name: 'available',
      jwt: 'jwt-b',
      teamId: 2,
      assetGroupId: 'asset-b'
    });
    expect(full.generationLimit).toBe(1);
    expect(available.generationLimit).toBe(80);
    expect(db.selectLeastLoadedAccount().id).toBe(available.id);
    db.resetAccountGenerationUsage(full.id);
    expect(db.selectLeastLoadedAccount().id).toBe(full.id);
    db.close();
  });

  it('automatically resets generation usage on a new Shanghai calendar day', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-api-test-'));
    const db = new RunwayDatabase(path.join(dir, 'test.sqlite'));
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 36 * 60 * 60 * 1000);
    const account = db.createAccount({
      name: 'daily',
      jwt: 'jwt-a',
      teamId: 1,
      assetGroupId: 'asset-a',
      generationLimit: 1,
      generationUsed: 1,
      generationResetAt: now.toISOString()
    });

    expect(db.selectLeastLoadedAccount()).toBeNull();
    db.resetExpiredGenerationUsage(account.id, tomorrow);
    const reset = db.getAccount(account.id);
    expect(reset.generationUsed).toBe(0);
    expect(reset.generationResetAt).toBe(tomorrow.toISOString());
    expect(db.selectLeastLoadedAccount().id).toBe(account.id);
    db.close();
  });

  it('normalizes proxy formats and clears account proxy binding', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-api-test-'));
    const db = new RunwayDatabase(path.join(dir, 'test.sqlite'));
    const proxy = db.createProxy({ name: 'p1', url: 'host.test:8080:user:pass' });
    expect(proxy.url).toBe('http://user:pass@host.test:8080/');
    const account = db.createAccount({ name: 'a', proxyId: proxy.id, proxyStrategy: 'per_request' });
    expect(account.proxyId).toBe(proxy.id);
    expect(account.proxyStrategy).toBe('per_request');
    expect(db.updateAccount(account.id, { proxyId: null }).proxyId).toBeNull();
    db.close();
  });

  it('migrates an existing default account into a normal account and rewrites references', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-api-test-'));
    const profilesDir = path.join(dir, 'browser-profiles');
    fs.mkdirSync(path.join(profilesDir, 'default'), { recursive: true });
    fs.writeFileSync(path.join(profilesDir, 'default', 'marker.txt'), 'profile');

    const dbPath = path.join(dir, 'test.sqlite');
    let db = new RunwayDatabase(dbPath, { dbPath, browserProfilesDir: profilesDir });
    db.createAccount({
      id: 'default',
      name: '默认账号',
      jwt: 'jwt',
      teamId: 1,
      assetGroupId: 'asset'
    });
    db.createTask({
      id: 'task-default',
      accountId: 'default',
      status: 'pending',
      prompt: 'hello',
      model: 'seedance_2',
      duration: 5,
      resolution: '480p',
      aspectRatio: '16:9',
      generateAudio: true,
      exploreMode: true
    });
    db.addAsset({
      id: 'asset-default',
      taskId: 'task-default',
      accountId: 'default',
      localPath: path.join(dir, 'input.png'),
      filename: 'input.png',
      mimeType: 'image/png',
      mediaType: 'image',
      size: 1
    });
    db.logRequest({ accountId: 'default', operation: 'test', status: 'success' });
    db.close();

    db = new RunwayDatabase(dbPath, { dbPath, browserProfilesDir: profilesDir });
    const accounts = db.listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).not.toBe('default');
    expect(accounts[0].name).toBe('迁移账号');
    expect(db.getTask('task-default').accountId).toBe(accounts[0].id);
    expect(db.getAssetsByTask('task-default')[0].account_id).toBe(accounts[0].id);
    expect(db.listRequestLogs()[0].accountId).toBe(accounts[0].id);
    expect(fs.existsSync(path.join(profilesDir, 'default'))).toBe(false);
    expect(fs.existsSync(path.join(profilesDir, accounts[0].id, 'marker.txt'))).toBe(true);
    db.close();
  });

  it('summarizes Runway moderation failures in Chinese while preserving detail', () => {
    const normalized = normalizeTaskError({
      raw: {
        error: {
          code: 'SAFETY.INPUT.MULTIMODAL',
          category: 'SEXUALLY_EXPLICIT',
          message: 'content moderation failed'
        }
      }
    });
    expect(normalized).toMatchObject({
      errorSummary: '参考素材未通过内容审核',
      errorCode: 'SAFETY.INPUT.MULTIMODAL',
      errorCategory: 'SEXUALLY_EXPLICIT',
      errorMessage: 'content moderation failed'
    });
    expect(normalized.errorDetail.raw.error.message).toContain('moderation');
    const textModeration = normalizeTaskError({
      raw: {
        error: {
          reason: 'SAFETY.INPUT.TEXT',
          errorMessage: 'Content did not pass content moderation.',
          moderation_category: 'SEXUALLY_EXPLICIT',
          moderationMetadata: {
            moderationResponseClassification: [{
              name: 'SEXUALLY_EXPLICIT',
              result: 'SEXUALLY_EXPLICIT',
              llmResponse: 'The text prompt describes a sexual act and physical assault.'
            }]
          }
        }
      }
    });
    expect(textModeration).toMatchObject({
      errorSummary: '提示词未通过内容审核',
      errorCode: 'SAFETY.INPUT.TEXT',
      errorCategory: 'SEXUALLY_EXPLICIT',
      errorMessage: 'Content did not pass content moderation.',
      errorReason: 'The text prompt describes a sexual act and physical assault.'
    });
  });

  it('leases pending tasks atomically and only once', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-api-test-'));
    const db = new RunwayDatabase(path.join(dir, 'test.sqlite'));
    db.createTask({
      id: 'lease-task',
      status: 'pending',
      prompt: 'hello',
      model: 'seedance_2',
      duration: 5,
      resolution: '480p',
      aspectRatio: '16:9',
      generateAudio: true,
      exploreMode: true
    });
    expect(db.leasePendingTasks({ limit: 1, workerId: 'worker-a' })).toHaveLength(1);
    expect(db.leasePendingTasks({ limit: 1, workerId: 'worker-b' })).toHaveLength(0);
    expect(db.getTask('lease-task')).toMatchObject({ lockedBy: 'worker-a', attemptCount: 1 });
    db.close();
  });

  it('synthesizes a readable timeline for historical tasks without events', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-api-test-'));
    const db = new RunwayDatabase(path.join(dir, 'test.sqlite'));
    db.createTask({
      id: 'legacy-task',
      runwayTaskId: 'runway-legacy',
      status: 'failed',
      rawStatus: 'FAILED',
      prompt: 'hello',
      model: 'seedance_2',
      duration: 5,
      resolution: '480p',
      aspectRatio: '16:9',
      generateAudio: true,
      exploreMode: true,
      error: { code: 'SAFETY.INPUT.MULTIMODAL' },
      submittedAt: new Date().toISOString(),
      completedAt: new Date().toISOString()
    });
    db.db.prepare('DELETE FROM task_events WHERE task_id = ?').run('legacy-task');
    const events = db.getTaskEvents('legacy-task');
    expect(events.map((event) => event.type)).toEqual(['queued', 'submitted', 'status:failed']);
    expect(events[2].data.error.code).toBe('SAFETY.INPUT.MULTIMODAL');
    db.close();
  });

  it('marks timed out active tasks failed and rebuilds account inflight', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-api-test-'));
    const db = new RunwayDatabase(path.join(dir, 'test.sqlite'));
    const account = db.createAccount({
      name: 'a',
      jwt: 'jwt-a',
      teamId: 1,
      assetGroupId: 'asset-a',
      inflight: 1
    });
    db.createTask({
      id: 'timeout-task',
      accountId: account.id,
      runwayTaskId: 'runway-timeout',
      status: 'generating',
      prompt: 'hello',
      model: 'seedance_2',
      duration: 5,
      resolution: '480p',
      aspectRatio: '16:9',
      generateAudio: true,
      exploreMode: true,
      submittedAt: new Date(Date.now() - 60_000).toISOString()
    });
    expect(db.recoverTimedOutTasks(1)).toBe(1);
    expect(db.getTask('timeout-task')).toMatchObject({
      status: 'failed',
      errorSummary: '任务超过最大运行时间',
      errorCode: 'TASK_TIMEOUT'
    });
    expect(db.getAccount(account.id).inflight).toBe(0);
    db.close();
  });

  it('does not count queuing time toward task timeout', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-api-test-'));
    const db = new RunwayDatabase(path.join(dir, 'test.sqlite'));
    const account = db.createAccount({
      name: 'a',
      jwt: 'jwt-a',
      teamId: 1,
      inflight: 1
    });
    db.createTask({
      id: 'queued-timeout-task',
      accountId: account.id,
      runwayTaskId: 'runway-queued',
      status: 'queuing',
      rawStatus: 'PENDING',
      prompt: 'hello',
      model: 'seedance_2',
      duration: 5,
      resolution: '480p',
      aspectRatio: '16:9',
      generateAudio: true,
      exploreMode: true,
      submittedAt: new Date(Date.now() - 60_000).toISOString()
    });
    expect(db.recoverTimedOutTasks(1)).toBe(0);
    expect(db.getTask('queued-timeout-task')).toMatchObject({
      status: 'queuing',
      error: null
    });
    db.close();
  });
});
