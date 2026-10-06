// server/whatsapp/recovery/scheduler.js
class RecoveryScheduler {
  constructor(queue) {
    this.queue = queue;
    this.taskIdCounter = 1000;
  }

  async scheduleSession(session, recoveryId) {
    const taskId = `task_${recoveryId}_${this.taskIdCounter++}`;
    
    const task = {
      taskId,
      uid: session.uid,
      state: session.state,
      priority: this._getPriority(session.state),
      retryCount: 0,
      workerId: null,
      startedAt: null,
      finishedAt: null,
      duration: null,
      errorReason: null,
      recoveryId,
    };

    await this.queue.push(task);
    return task;
  }

  async getNextTask() {
    return await this.queue.pop();
  }

  async rescheduleTask(task) {
    task.retryCount++;
    task.startedAt = null;
    task.finishedAt = null;
    task.duration = null;
    task.workerId = null;
    await this.queue.push(task);
    return task;
  }

  _getPriority(state) {
    const p = { 'connected': 1, 'reconnecting': 2, 'connecting': 3 };
    return p[state] || 99;
  }

  async hasTask() {
    const size = await this.queue.size();
    return size > 0;
  }
}

module.exports = RecoveryScheduler;
