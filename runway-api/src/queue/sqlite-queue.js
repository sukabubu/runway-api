export class SQLiteQueueAdapter {
  constructor({ db, workerId, leaseMs }) {
    this.db = db;
    this.workerId = workerId;
    this.leaseMs = leaseMs;
  }

  recoverStaleLeases() {
    return this.db.recoverStaleLeases(this.leaseMs);
  }

  leasePendingTasks(limit) {
    return this.db.leasePendingTasks({
      limit,
      workerId: this.workerId,
      leaseMs: this.leaseMs
    });
  }

  heartbeat(taskId) {
    return this.db.heartbeatTaskLease(taskId, this.workerId);
  }

  release(taskId) {
    return this.db.clearTaskLease(taskId, this.workerId);
  }
}
