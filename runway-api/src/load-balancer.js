export class LoadBalancer {
  constructor({ db }) {
    this.db = db;
  }

  selectAccount(options = {}) {
    return this.db.selectLeastLoadedAccount(options);
  }

  acquire(taskId, options = {}) {
    return this.db.acquireAccountForTask(taskId, options);
  }
}
