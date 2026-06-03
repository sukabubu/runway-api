import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { SQLiteQueueAdapter } from './queue/sqlite-queue.js';
import { isTooManyRunwayTasksError } from './runway/client.js';

const DEFAULT_SUBMIT_COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_UPSTREAM_AUTO_RETRY_ATTEMPTS = 3;

export class TaskWorker {
  constructor({ db, runway, config, logger, queue = null }) {
    this.db = db;
    this.runway = runway;
    this.config = config;
    this.logger = logger;
    this.workerId = `worker-${randomUUID()}`;
    this.queue = queue || new SQLiteQueueAdapter({
      db,
      workerId: this.workerId,
      leaseMs: config.queueLeaseTimeoutMs || 120000
    });
    this.running = false;
    this.loopPromise = null;
    this.activeSubmissions = new Set();
    this.lastSubmitAt = 0;
  }

  start() {
    if (this.running) return;
    this.db.rebuildAccountInflight?.();
    this.running = true;
    this.loopPromise = this.loop();
  }

  async stop() {
    this.running = false;
    await this.loopPromise;
  }

  async loop() {
    while (this.running) {
      try {
        this.queue.recoverStaleLeases();
        this.db.recoverStaleActiveTasks?.(this.config.staleTaskTimeoutMs || 1800000);
        this.db.recoverTimedOutTasks?.(this.db.getRuntimeConfig?.().taskTimeoutMs || this.config.staleTaskTimeoutMs || 1500000);
        await this.pollActiveTasks();
        await this.submitPendingTasks();
        this.pruneRuntimeData();
      } catch (err) {
        this.logger.error?.({ err }, 'worker loop failed');
      }
      await delay(1000);
    }
  }

  async submitPendingTasks() {
    const tasks = this.queue.leasePendingTasks(50);
    for (const task of tasks) {
      if (this.activeSubmissions.has(task.id)) continue;
      const account = this.db.acquireAccountForTask(task.id, {
        preferredAccountId: task.accountId,
        poolId: task.poolId ?? null
      });
      if (!account) {
        this.queue.release(task.id);
        continue;
      }
      this.activeSubmissions.add(task.id);
      this.submitOne(task, account).finally(() => this.activeSubmissions.delete(task.id));
    }
  }

  async submitOne(task, account) {
    try {
      const assignedTask = this.db.updateTask(task.id, { status: 'submitting', accountId: account.id });
      this.queue.heartbeat(task.id);
      await this.respectSubmitGap();
      if (this.isCancelled(task.id)) return this.queue.release(task.id);
      const canStart = await this.checkCanStart(assignedTask, account);
      if (!canStart.ok) {
        return this.deferSubmission(task.id, account.id, canStart.reason || 'Runway cannot start more tasks right now', canStart.rawResponse);
      }
      const uploadedAssets = [];
      for (const asset of assignedTask.assets) {
        if (this.isCancelled(task.id)) return this.queue.release(task.id);
        if (asset.runwayAssetId && asset.runwayUrl) {
          uploadedAssets.push(asset);
          continue;
        }
        this.queue.heartbeat(task.id);
        const uploaded = await this.runway.uploadAsset(asset, { account });
        const updated = this.db.updateAsset(asset.id, {
          accountId: account.id,
          runwayAssetId: uploaded.assetId,
          runwayUrl: uploaded.url,
          previewUrl: uploaded.previewUrl
        });
        uploadedAssets.push({
          ...asset,
          accountId: account.id,
          runwayAssetId: updated.runway_asset_id,
          runwayUrl: updated.runway_url,
          previewUrl: updated.preview_url
        });
      }
      this.queue.heartbeat(task.id);
      if (this.isCancelled(task.id)) return this.queue.release(task.id);
      const submission = await this.runway.submitTask(assignedTask, uploadedAssets, { account });
      if (this.isCancelled(task.id)) return this.queue.release(task.id);
      this.lastSubmitAt = Date.now();
      this.db.markAccountSuccess?.(account.id);
      this.db.logRequest?.({
        accountId: account.id,
        operation: 'submit',
        status: 'success',
        message: `task ${task.id} -> ${submission.taskId}`
      });
      this.db.updateTask(task.id, {
        runwayTaskId: submission.taskId,
        status: submission.status,
        rawStatus: submission.rawStatus,
        rawResponse: submission.rawResponse,
        submittedAt: new Date().toISOString()
      });
      this.queue.release(task.id);
    } catch (err) {
      if (isTooManyRunwayTasksError(err)) {
        return this.deferSubmission(task.id, account.id, err.body?.error || err.message, err.body || null);
      }
      this.db.markAccountError?.(account.id, err.message);
      this.db.logRequest?.({
        accountId: account.id,
        operation: 'submit',
        status: 'failed',
        message: err.message
      });
      this.db.updateTask(task.id, {
        status: 'failed',
        error: {
          code: err.code || 'SUBMIT_FAILED',
          message: err.message,
          status: err.status || err.statusCode || null,
          body: err.body || null
        }
      });
      this.queue.release(task.id);
      this.logger.error?.({ err, taskId: task.id, accountId: account.id }, 'task submission failed');
    }
  }

  async checkCanStart(task, account) {
    if (!this.runway.canStartTask) return { ok: true };
    try {
      return await this.runway.canStartTask(task, { account });
    } catch (err) {
      if (err.code === 'AUTH_FAILED') throw err;
      this.logger.warn?.({ err, taskId: task.id, accountId: account.id }, 'can_start check failed');
      return { ok: true, reason: 'can_start_check_failed', rawResponse: err.body || null };
    }
  }

  deferSubmission(taskId, accountId, reason, rawResponse = null) {
    const cooldownUntil = new Date(Date.now() + DEFAULT_SUBMIT_COOLDOWN_MS).toISOString();
    this.db.setAccountSubmitCooldown?.(accountId, cooldownUntil, reason);
    this.db.releaseAccount?.(accountId);
    this.db.resetTaskSubmissionState?.(taskId);
    this.db.updateTask(taskId, {
      status: 'pending',
      accountId: null,
      runwayTaskId: null,
      error: {
        code: 'RUNWAY_ACCOUNT_BUSY',
        message: reason,
        cooldownUntil,
        runwayResponse: rawResponse
      }
    });
    this.queue.release(taskId);
    this.db.logRequest?.({
      accountId,
      operation: 'submit_deferred',
      status: 'deferred',
      message: `${reason}; cooldown until ${cooldownUntil}`,
      responseBody: rawResponse
    });
  }

  async pollActiveTasks() {
    const tasks = this.db.getActiveRunwayTasks();
    const now = Date.now();
    for (const task of tasks) {
      const updatedAt = Date.parse(task.updatedAt);
      const interval = task.status === 'queuing' ? this.config.pollIntervalSlowMs : this.config.pollIntervalMs;
      if (Number.isFinite(updatedAt) && now - updatedAt < interval) continue;
      const account = task.accountId ? this.db.getAccount(task.accountId, { includeSecret: true }) : null;
      if (!(account?.jwt || account?.cookieHeader)) {
        this.db.updateTask(task.id, {
          status: 'failed',
          error: { code: 'AUTH_FAILED', message: '任务绑定账号凭证不可用' }
        });
        continue;
      }
      try {
        const update = await this.runway.pollTask(task.runwayTaskId, { account });
        this.db.markAccountSuccess?.(account.id);
        if (this.shouldAutoRetryUpstreamFailure(task, update)) {
          this.db.releaseAccount?.(account.id);
          this.db.requeueTaskForAutoRetry?.(task.id, {
            reason: getRetryableUpstreamFailureReason(update),
            error: update.error,
            runwayTaskId: task.runwayTaskId,
            rawStatus: update.rawStatus
          });
          this.logger.warn?.({
            taskId: task.id,
            accountId: account.id,
            runwayTaskId: task.runwayTaskId,
            attemptCount: task.attemptCount,
            error: update.error
          }, 'task auto-requeued after retryable upstream failure');
          continue;
        }
        this.db.updateTask(task.id, {
          status: update.status,
          rawStatus: update.rawStatus,
          progress: update.progress,
          videoUrl: update.videoUrl,
          thumbnailUrl: update.thumbnailUrl,
          error: update.error,
          rawResponse: update.rawResponse
        });
      } catch (err) {
        this.logger.warn?.({ err, taskId: task.id, accountId: account.id }, 'task poll failed');
        if (err.code === 'AUTH_FAILED') {
          this.db.updateTask(task.id, {
            status: 'failed',
            error: { code: 'AUTH_FAILED', message: err.message, status: err.status, body: err.body || null }
          });
        } else {
          this.db.markAccountError?.(account.id, err.message);
        }
      }
    }
  }

  pruneRuntimeData() {
    const runtime = this.db.getRuntimeConfig?.();
    if (!runtime) return;
    if (!this.lastPruneAt || Date.now() - this.lastPruneAt > 60_000) {
      this.lastPruneAt = Date.now();
      this.db.pruneRequestLogs?.({ retentionDays: runtime.logRetentionDays });
      this.db.cleanupUploadFiles?.({ retentionDays: runtime.uploadRetentionDays });
    }
  }

  async respectSubmitGap() {
    const min = this.config.submitIntervalMinMs;
    const max = this.config.submitIntervalMaxMs;
    const targetGap = min + Math.floor(Math.random() * Math.max(max - min, 1));
    const elapsed = Date.now() - this.lastSubmitAt;
    if (this.lastSubmitAt && elapsed < targetGap) await delay(targetGap - elapsed);
  }

  isCancelled(taskId) {
    return this.db.getTask(taskId)?.status === 'cancelled';
  }

  shouldAutoRetryUpstreamFailure(task, update) {
    if (!this.db.requeueTaskForAutoRetry) return false;
    if (update?.status !== 'failed') return false;
    const maxAttempts = Number(this.config.upstreamAutoRetryAttempts ?? DEFAULT_UPSTREAM_AUTO_RETRY_ATTEMPTS);
    if (maxAttempts <= 1) return false;
    if ((Number(task.attemptCount) || 0) >= maxAttempts) return false;
    return isRetryableUpstreamFailure(update);
  }
}

export function isRetryableUpstreamFailure(update) {
  const reason = getRetryableUpstreamFailureReason(update);
  if (!reason) return false;
  if (/content did not pass|did not pass content moderation|SAFETY\.INPUT|SEXUALLY_EXPLICIT|policy|unauthorized|auth/i.test(reason)) {
    return false;
  }
  return /Moderation service temporarily unavailable|temporarily unavailable|INTERNAL|Failed to create task|BytePlus video task timed out|timed out after \d+s|timeout|service unavailable|Bad Gateway|Gateway Timeout/i.test(reason);
}

function getRetryableUpstreamFailureReason(update) {
  return [
    update?.error?.message,
    update?.error?.reason,
    update?.error?.code,
    update?.error?.category,
    update?.error?.raw?.error?.errorMessage,
    update?.error?.raw?.error?.reason,
    update?.error?.raw?.errorMessage,
    update?.error?.raw?.failureReason,
    update?.error?.raw?.errorReason,
    update?.rawResponse?.task?.error?.errorMessage,
    update?.rawResponse?.task?.error?.reason
  ].filter(Boolean).join(' ');
}
