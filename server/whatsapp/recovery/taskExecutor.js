// server/whatsapp/recovery/taskExecutor.js
const config = require('./config');

class TaskExecutor {
  constructor(manager, sessionsModule, circuitBreaker) {
    this.manager = manager;
    this.sessions = sessionsModule;
    this.cb = circuitBreaker;
  }

  async executeRecoveryTask(task) {
    task.startedAt = Date.now();

    try {
      const success = await this.cb.call(async () => {
        return await this.manager.startSession(task.uid, {
          fresh: false,
          recovery: true,
          timeout: config.TIMEOUT_SOCKET,
        });
      });

      if (!success) throw new Error('startSession returned false');

      task.finishedAt = Date.now();
      task.duration = task.finishedAt - task.startedAt;
      return { success: true, task };
    } catch (err) {
      task.errorReason = err.message;
      task.finishedAt = Date.now();
      task.duration = task.finishedAt - task.startedAt;

      if (task.retryCount < config.MAX_RETRY_PER_SESSION) {
        return { success: false, retry: true, task };
      } else {
        this.sessions.setFailed(task.uid, { code: 'RECOVERY_MAX_RETRIES', message: err.message });
        return { success: false, retry: false, task };
      }
    }
  }
}

module.exports = TaskExecutor;
