import { describe, expect, it, vi } from 'vitest';
import { TaskWorker } from '../src/worker.js';

function createWorkerHarness({ canStart = { ok: true }, submitError = null } = {}) {
  const task = {
    id: 'task-1',
    assets: [],
    model: 'seedance_2',
    prompt: 'hello',
    duration: 5,
    resolution: '480p',
    aspectRatio: '16:9',
    generateAudio: true,
    exploreMode: true
  };
  const account = { id: 'account-1' };
  const db = {
    updateTask: vi.fn(() => task),
    setAccountSubmitCooldown: vi.fn(),
    resetTaskSubmissionState: vi.fn(),
    releaseAccount: vi.fn(),
    logRequest: vi.fn(),
    markAccountError: vi.fn(),
    markAccountSuccess: vi.fn(),
    getTask: vi.fn(() => task)
  };
  const queue = {
    release: vi.fn(),
    heartbeat: vi.fn()
  };
  const runway = {
    canStartTask: vi.fn(async () => canStart),
    submitTask: submitError
      ? vi.fn(async () => { throw submitError; })
      : vi.fn(async () => ({ taskId: 'runway-task', status: 'queuing', rawStatus: 'PENDING', rawResponse: {} }))
  };
  const worker = new TaskWorker({
    db,
    runway,
    queue,
    config: { submitIntervalMinMs: 0, submitIntervalMaxMs: 0 },
    logger: { warn: vi.fn(), error: vi.fn() }
  });
  return { worker, db, queue, runway, task, account };
}

describe('TaskWorker upstream capacity handling', () => {
  it('defers a task and cools down the account when can_start rejects submission', async () => {
    const { worker, db, queue, runway, task, account } = createWorkerHarness({
      canStart: {
        ok: false,
        reason: 'Too many tasks are running or pending at the moment.',
        rawResponse: { error: 'Too many tasks are running or pending at the moment.' }
      }
    });

    await worker.submitOne(task, account);

    expect(runway.submitTask).not.toHaveBeenCalled();
    expect(db.setAccountSubmitCooldown).toHaveBeenCalledWith(
      account.id,
      expect.any(String),
      'Too many tasks are running or pending at the moment.'
    );
    expect(db.releaseAccount).toHaveBeenCalledWith(account.id);
    expect(db.resetTaskSubmissionState).toHaveBeenCalledWith(task.id);
    expect(queue.release).toHaveBeenCalledWith(task.id);
  });

  it('defers a task and cools down the account when submit returns the upstream queue limit', async () => {
    const err = new Error('Runway POST /v1/tasks returned 429');
    err.status = 429;
    err.body = { error: 'Too many tasks are running or pending at the moment.' };
    const { worker, db, queue, runway, task, account } = createWorkerHarness({ submitError: err });

    await worker.submitOne(task, account);

    expect(runway.canStartTask).toHaveBeenCalled();
    expect(db.markAccountError).not.toHaveBeenCalled();
    expect(db.setAccountSubmitCooldown).toHaveBeenCalledWith(
      account.id,
      expect.any(String),
      'Too many tasks are running or pending at the moment.'
    );
    expect(db.resetTaskSubmissionState).toHaveBeenCalledWith(task.id);
    expect(queue.release).toHaveBeenCalledWith(task.id);
  });
});

describe('TaskWorker retryable upstream failures', () => {
  function createPollHarness({ update, attemptCount = 1, maxAttempts = 3 } = {}) {
    const task = {
      id: 'task-1',
      accountId: 'account-1',
      runwayTaskId: 'runway-task-1',
      status: 'queuing',
      updatedAt: '2026-01-01T00:00:00.000Z',
      attemptCount
    };
    const account = { id: 'account-1', jwt: 'jwt' };
    const db = {
      getActiveRunwayTasks: vi.fn(() => [task]),
      getAccount: vi.fn(() => account),
      markAccountSuccess: vi.fn(),
      updateTask: vi.fn(),
      releaseAccount: vi.fn(),
      requeueTaskForAutoRetry: vi.fn(),
      markAccountError: vi.fn()
    };
    const runway = {
      pollTask: vi.fn(async () => update)
    };
    const worker = new TaskWorker({
      db,
      runway,
      queue: { release: vi.fn(), heartbeat: vi.fn() },
      config: {
        pollIntervalMs: 0,
        pollIntervalSlowMs: 0,
        submitIntervalMinMs: 0,
        submitIntervalMaxMs: 0,
        upstreamAutoRetryAttempts: maxAttempts
      },
      logger: { warn: vi.fn(), error: vi.fn() }
    });
    return { worker, db, runway, task, account };
  }

  it('requeues a failed task when Runway reports a temporary moderation outage', async () => {
    const update = {
      status: 'failed',
      rawStatus: 'FAILED',
      error: {
        raw: {
          error: {
            reason: 'INTERNAL',
            errorMessage: 'Moderation service temporarily unavailable'
          }
        }
      },
      rawResponse: {}
    };
    const { worker, db, task, account } = createPollHarness({ update });

    await worker.pollActiveTasks();

    expect(db.releaseAccount).toHaveBeenCalledWith(account.id);
    expect(db.requeueTaskForAutoRetry).toHaveBeenCalledWith(task.id, expect.objectContaining({
      runwayTaskId: task.runwayTaskId,
      rawStatus: 'FAILED'
    }));
    expect(db.updateTask).not.toHaveBeenCalled();
  });

  it('does not auto-retry content policy failures', async () => {
    const update = {
      status: 'failed',
      rawStatus: 'FAILED',
      error: {
        raw: {
          error: {
            code: 'SAFETY.INPUT.TEXT',
            errorMessage: 'Content did not pass content moderation.'
          }
        }
      },
      rawResponse: {}
    };
    const { worker, db, task } = createPollHarness({ update });

    await worker.pollActiveTasks();

    expect(db.requeueTaskForAutoRetry).not.toHaveBeenCalled();
    expect(db.updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      status: 'failed',
      rawStatus: 'FAILED',
      error: update.error
    }));
  });

  it('stops auto-retrying after the configured attempt limit', async () => {
    const update = {
      status: 'failed',
      rawStatus: 'FAILED',
      error: {
        raw: {
          error: {
            reason: 'INTERNAL',
            errorMessage: 'Failed to create task'
          }
        }
      },
      rawResponse: {}
    };
    const { worker, db, task } = createPollHarness({ update, attemptCount: 3, maxAttempts: 3 });

    await worker.pollActiveTasks();

    expect(db.requeueTaskForAutoRetry).not.toHaveBeenCalled();
    expect(db.updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      status: 'failed'
    }));
  });
});
