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

  it('skips accounts in submit cooldown until the cooldown expires', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-api-test-'));
    const db = new RunwayDatabase(path.join(dir, 'test.sqlite'));
    const cooled = db.createAccount({
      name: 'cooled',
      jwt: 'jwt-a',
      teamId: 1
    });
    const available = db.createAccount({
      name: 'available',
      jwt: 'jwt-b',
      teamId: 2
    });

    db.setAccountSubmitCooldown(cooled.id, new Date(Date.now() + 60_000).toISOString(), 'Runway queue is full');
    expect(db.getAccount(cooled.id).submitCooldownUntil).toBeTruthy();
    expect(db.selectLeastLoadedAccount().id).toBe(available.id);
    expect(db.acquireAccountForTask('missing-task', { preferredAccountId: cooled.id })).toBeNull();

    db.setAccountSubmitCooldown(cooled.id, new Date(Date.now() - 1000).toISOString());
    expect([cooled.id, available.id]).toContain(db.selectLeastLoadedAccount().id);
    db.markAccountSuccess(cooled.id);
    expect(db.getAccount(cooled.id).submitCooldownUntil).toBeNull();
    db.close();
  });

  it('isolates account acquisition by account pool', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-api-test-'));
    const db = new RunwayDatabase(path.join(dir, 'test.sqlite'));
    const poolA = db.createAccountPool({ name: 'pool A', apiKey: 'pool-a-key' });
    const poolB = db.createAccountPool({ name: 'pool B', apiKey: 'pool-b-key' });
    const accountA = db.createAccount({ name: 'a', jwt: 'jwt-a', teamId: 1, poolId: poolA.id });
    const accountB = db.createAccount({ name: 'b', jwt: 'jwt-b', teamId: 2, poolId: poolB.id });
    const defaultAccount = db.createAccount({ name: 'default', jwt: 'jwt-default', teamId: 3 });
    const taskA = db.createTask({
      id: 'task-a',
      poolId: poolA.id,
      prompt: 'a',
      model: 'gen4',
      duration: 5,
      resolution: '720p',
      aspectRatio: '16:9',
      generateAudio: false,
      exploreMode: false
    });
    const taskDefault = db.createTask({
      id: 'task-default-pool',
      prompt: 'default',
      model: 'gen4',
      duration: 5,
      resolution: '720p',
      aspectRatio: '16:9',
      generateAudio: false,
      exploreMode: false
    });

    expect(db.getAccountPoolByApiKey('pool-a-key').id).toBe(poolA.id);
    expect(db.acquireAccountForTask(taskA.id, { poolId: poolA.id }).id).toBe(accountA.id);
    expect(db.acquireAccountForTask(taskA.id, { preferredAccountId: accountB.id, poolId: poolA.id })).toBeNull();
    expect(db.acquireAccountForTask(taskDefault.id, { poolId: null }).id).toBe(defaultAccount.id);
    expect(db.listTasks({ poolId: poolA.id }).map((task) => task.id)).toEqual(['task-a']);
    expect(db.listTasks({ poolId: poolB.id })).toEqual([]);
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
    expect([full.id, available.id]).toContain(db.selectLeastLoadedAccount().id);
    db.close();
  });

  it('spreads account acquisition across equal-load accounts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-api-test-'));
    const db = new RunwayDatabase(path.join(dir, 'test.sqlite'));
    const accounts = Array.from({ length: 4 }, (_, index) => db.createAccount({
      name: `account-${index + 1}`,
      jwt: `jwt-${index + 1}`,
      teamId: index + 1,
      maxConcurrent: 2
    }));
    const acquired = [];
    for (let index = 0; index < accounts.length; index += 1) {
      const task = db.createTask({
        id: `lb-task-${index + 1}`,
        status: 'pending',
        prompt: 'hello',
        model: 'seedance_2',
        duration: 5,
        resolution: '480p',
        aspectRatio: '16:9',
        generateAudio: true,
        exploreMode: true
      });
      acquired.push(db.acquireAccountForTask(task.id).id);
    }
    expect(new Set(acquired).size).toBe(accounts.length);
    db.close();
  });

  it('counts generation usage only when a task completes successfully', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-api-test-'));
    const db = new RunwayDatabase(path.join(dir, 'test.sqlite'));
    const account = db.createAccount({
      name: 'quota-account',
      jwt: 'jwt-a',
      teamId: 1,
      generationLimit: 10
    });
    db.createTask({
      id: 'failed-task',
      accountId: account.id,
      runwayTaskId: 'runway-failed',
      status: 'generating',
      prompt: 'hello',
      model: 'seedance_2',
      duration: 5,
      resolution: '480p',
      aspectRatio: '16:9',
      generateAudio: true,
      exploreMode: true
    });
    db.createTask({
      id: 'completed-task',
      accountId: account.id,
      runwayTaskId: 'runway-completed',
      status: 'generating',
      prompt: 'hello',
      model: 'seedance_2',
      duration: 5,
      resolution: '480p',
      aspectRatio: '16:9',
      generateAudio: true,
      exploreMode: true
    });

    db.updateTask('failed-task', { status: 'failed', error: { code: 'SAFETY.INPUT.TEXT' } });
    expect(db.getAccount(account.id).generationUsed).toBe(0);

    db.updateTask('completed-task', { status: 'completed', videoUrl: 'https://video' });
    expect(db.getAccount(account.id).generationUsed).toBe(1);

    db.updateTask('completed-task', { progress: 100 });
    expect(db.getAccount(account.id).generationUsed).toBe(1);
    db.close();
  });

  it('counts only successfully completed videos from the current Shanghai day', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-api-test-'));
    const db = new RunwayDatabase(path.join(dir, 'test.sqlite'));
    const account = db.createAccount({
      name: 'stats',
      jwt: 'jwt-a',
      teamId: 1
    });
    const today = new Date().toISOString();
    const submitted = new Date(Date.now() - 120_000).toISOString();
    const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
    db.createTask({
      id: 'today-completed',
      accountId: account.id,
      status: 'completed',
      prompt: 'today',
      model: 'gen4',
      duration: 5,
      resolution: '720p',
      aspectRatio: '16:9',
      generateAudio: false,
      exploreMode: false,
      submittedAt: submitted,
      completedAt: today
    });
    db.createTask({
      id: 'today-failed',
      accountId: account.id,
      status: 'failed',
      prompt: 'failed',
      model: 'gen4',
      duration: 5,
      resolution: '720p',
      aspectRatio: '16:9',
      generateAudio: false,
      exploreMode: false,
      completedAt: today
    });
    db.createTask({
      id: 'old-completed',
      accountId: account.id,
      status: 'completed',
      prompt: 'old',
      model: 'gen4',
      duration: 5,
      resolution: '720p',
      aspectRatio: '16:9',
      generateAudio: false,
      exploreMode: false,
      completedAt: yesterday
    });

    expect(db.getAccountSummary().todayCompletedTasks).toBe(1);
    expect(db.getAccount(account.id).todayCompletedCount).toBe(1);
    expect(db.getAccount(account.id).todayAvgGenerationMs).toBeGreaterThanOrEqual(119_000);
    expect(db.getAccount(account.id).todayAvgGenerationMs).toBeLessThanOrEqual(121_000);
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

  it('preserves account credentials when auth failures disable the account', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-api-test-'));
    const db = new RunwayDatabase(path.join(dir, 'test.sqlite'));
    const account = db.createAccount({
      name: 'auth',
      jwt: 'jwt-a',
      cookieHeader: 'session=abc',
      teamId: 1
    });

    db.markAccountAuthFailed(account.id, 'Runway returned 401');

    expect(db.getAccount(account.id, { includeSecret: true })).toMatchObject({
      isActive: false,
      jwt: 'jwt-a',
      cookieHeader: 'session=abc',
      lastError: 'Runway returned 401'
    });
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

  it('requeues retryable upstream failures without clearing uploaded assets', () => {
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
      id: 'retryable-task',
      accountId: account.id,
      runwayTaskId: 'runway-failed',
      status: 'queuing',
      rawStatus: 'FAILED',
      prompt: 'hello',
      model: 'seedance_2',
      duration: 5,
      resolution: '480p',
      aspectRatio: '16:9',
      generateAudio: true,
      exploreMode: true,
      submittedAt: new Date().toISOString()
    });
    db.addAsset({
      id: 'asset-1',
      taskId: 'retryable-task',
      accountId: account.id,
      localPath: path.join(dir, 'asset.png'),
      filename: 'asset.png',
      mimeType: 'image/png',
      mediaType: 'image',
      size: 123,
      runwayAssetId: 'runway-asset',
      runwayUrl: 'https://example.test/asset.png',
      previewUrl: 'https://example.test/preview.png'
    });

    db.releaseAccount(account.id);
    const requeued = db.requeueTaskForAutoRetry('retryable-task', {
      reason: 'Moderation service temporarily unavailable',
      error: { raw: { error: { reason: 'INTERNAL' } } },
      runwayTaskId: 'runway-failed',
      rawStatus: 'FAILED'
    });

    expect(requeued).toMatchObject({
      status: 'pending',
      accountId: null,
      runwayTaskId: null,
      rawStatus: null,
      error: null,
      rawResponse: null,
      submittedAt: null,
      completedAt: null
    });
    expect(requeued.assets[0]).toMatchObject({
      accountId: null,
      runwayAssetId: 'runway-asset',
      runwayUrl: 'https://example.test/asset.png',
      previewUrl: 'https://example.test/preview.png'
    });
    expect(db.getAccount(account.id).inflight).toBe(0);
    expect(db.getTaskEvents('retryable-task').map((event) => event.type)).toContain('auto_retry_requeued');
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
