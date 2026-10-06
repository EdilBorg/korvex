// server/whatsapp/recovery/metrics.js
class RecoveryMetrics {
  constructor() {
    this.reset();
  }

  reset() {
    this.startedAt = Date.now();
    this.finishedAt = null;
    this.workersActive = 0;
    this.workersMax = 0;
    this.tasksTotal = 0;
    this.tasksSuccess = 0;
    this.tasksFailed = 0;
    this.tasksCancelled = 0;
    this.tasksTimings = [];
    this.queueSizes = [];
    this.errorsByType = {};
  }

  recordTaskStart(taskId) {
    this.tasksTotal++;
    if (!this._timing) this._timing = {};
    this._timing[taskId] = Date.now();
  }

  recordTaskSuccess(taskId) {
    this.tasksSuccess++;
    const dur = Date.now() - (this._timing?.[taskId] || Date.now());
    this.tasksTimings.push(dur);
    delete this._timing?.[taskId];
  }

  recordTaskFail(taskId, errorType = 'unknown') {
    this.tasksFailed++;
    const dur = Date.now() - (this._timing?.[taskId] || Date.now());
    this.tasksTimings.push(dur);
    this.errorsByType[errorType] = (this.errorsByType[errorType] || 0) + 1;
    delete this._timing?.[taskId];
  }

  recordTaskCancelled(taskId) {
    this.tasksCancelled++;
    delete this._timing?.[taskId];
  }

  setWorkersActive(count) {
    this.workersActive = count;
    this.workersMax = Math.max(this.workersMax, count);
  }

  recordQueueSize(size) {
    this.queueSizes.push(size);
  }

  finish() {
    this.finishedAt = Date.now();
  }

  getReport() {
    const dur = (this.finishedAt || Date.now()) - this.startedAt;
    const avg = this.tasksTimings.length ? Math.round(this.tasksTimings.reduce((a, b) => a + b) / this.tasksTimings.length) : 0;
    const max = this.tasksTimings.length ? Math.max(...this.tasksTimings) : 0;
    const qAvg = this.queueSizes.length ? Math.round(this.queueSizes.reduce((a, b) => a + b) / this.queueSizes.length) : 0;
    const qMax = this.queueSizes.length ? Math.max(...this.queueSizes) : 0;

    return {
      duration: dur,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      workersMax: this.workersMax,
      tasksTotal: this.tasksTotal,
      tasksSuccess: this.tasksSuccess,
      tasksFailed: this.tasksFailed,
      tasksCancelled: this.tasksCancelled,
      successRate: this.tasksTotal ? ((this.tasksSuccess / this.tasksTotal) * 100).toFixed(2) + '%' : '0%',
      avgTaskTime: avg,
      maxTaskTime: max,
      avgQueueSize: qAvg,
      maxQueueSize: qMax,
      errorsByType: this.errorsByType,
    };
  }
}

module.exports = RecoveryMetrics;
