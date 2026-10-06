// server/whatsapp/recovery/engine.js
const state = require('./state');
const RecoveryScheduler = require('./scheduler');
const RecoveryMetrics = require('./metrics');
const SessionValidator = require('./validator');
const CircuitBreaker = require('./circuitBreaker');
const config = require('./config');

class RecoveryEngine {
  constructor(deps) {
    this.manager = deps.manager;
    this.sessionsModule = deps.sessionsModule;
    this.firebaseDb = deps.firebaseDb;
    this.queue = deps.queue;
    this.taskExecutor = deps.taskExecutor;
    this.repository = deps.repository;

    this.state = state;
    this.scheduler = new RecoveryScheduler(this.queue);
    this.metrics = new RecoveryMetrics();
    this.validator = new SessionValidator(this.sessionsModule, null, this.firebaseDb);

    this.cbFirestore = new CircuitBreaker('firestore', {
      failureThreshold: 3,
      resetTimeout: 30000,
    });

    this.cancelRequested = false;
    this.activeWorkers = 0;
  }

  async start() {
    if (this.state.isRunning()) return;

    const recoveryId = this._generateRecoveryId();
    this.state.setRecoveryId(recoveryId);
    this.state.setStatus('STARTING');

    // Não bloqueia: background
    setImmediate(() => this._executeRecovery());
  }

  async _executeRecovery() {
    try {
      this.state.setStatus('RUNNING');
      this.metrics.reset();

      const sessions = await this.cbFirestore.call(() =>
        this.repository.loadRecoverableSessions(config.TIMEOUT_QUERY_FIRESTORE)
      );

      if (!sessions || sessions.length === 0) {
        this.state.setStatus('FINISHED');
        this.metrics.finish();
        return;
      }

      const validSessions = await this._validateSessions(sessions);
      if (validSessions.length === 0) {
        this.state.setStatus('FINISHED');
        this.metrics.finish();
        return;
      }

      const toRecover = validSessions.slice(0, config.MAX_RECOVERY_SESSIONS_PER_RUN);

      for (const session of toRecover) {
        if (this.cancelRequested) break;
        await this.scheduler.scheduleSession(session, this.state.recoveryId);
      }

      await this._processQueue();

      this.state.setStatus('FINISHED');
      this.metrics.finish();
      await this.repository.saveMetrics(this.state.recoveryId, this.metrics.getReport());
    } catch (err) {
      console.error(`[Recovery] Error: ${err.message}`);
      this.state.setStatus('FAILED', { error: err.message });
      this.metrics.finish();
    }
  }

  async _validateSessions(sessions) {
    const valid = [];
    for (const session of sessions) {
      if (this.cancelRequested) break;
      const ok = await this.validator.canRecover(session, config.TIMEOUT_QUERY_FIRESTORE);
      if (ok) valid.push(session);
    }
    return valid;
  }

  async _processQueue() {
    while ((await this.scheduler.hasTask()) && !this.cancelRequested) {
      if (this.activeWorkers >= config.MAX_CONCURRENT_WORKERS) {
        await this._waitWorkerSlot();
      }

      const task = await this.scheduler.getNextTask();
      if (!task) break;

      this.activeWorkers++;
      this.metrics.setWorkersActive(this.activeWorkers);
      this.metrics.recordTaskStart(task.taskId);

      this._executeTask(task).then(() => {
        this.activeWorkers--;
        this.metrics.setWorkersActive(this.activeWorkers);
      }).catch(err => {
        console.error(`[Recovery] Task error: ${err.message}`);
        this.activeWorkers--;
        this.metrics.setWorkersActive(this.activeWorkers);
      });

      await this._delay(10);
    }

    await this._waitAllWorkers();
  }

  async _executeTask(task) {
    const { success, retry } = await this.taskExecutor.executeRecoveryTask(task);

    if (success) {
      this.metrics.recordTaskSuccess(task.taskId);
    } else if (retry) {
      this.metrics.recordTaskFail(task.taskId, 'retry');
      await this.scheduler.rescheduleTask(task);
    } else {
      this.metrics.recordTaskFail(task.taskId, 'max_retries');
    }
  }

  _waitWorkerSlot() {
    return new Promise(resolve => {
      const check = setInterval(() => {
        if (this.activeWorkers < config.MAX_CONCURRENT_WORKERS) {
          clearInterval(check);
          resolve();
        }
      }, config.DELAY_WORKER_CHECK);
    });
  }

  _waitAllWorkers() {
    return new Promise(resolve => {
      const check = setInterval(() => {
        if (this.activeWorkers === 0) {
          clearInterval(check);
          resolve();
        }
      }, config.DELAY_WORKER_CHECK);
    });
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  _generateRecoveryId() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const seq = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
    return `recovery_${yyyy}${mm}${dd}_${seq}`;
  }

  cancel() {
    this.cancelRequested = true;
    this.state.setStatus('FINISHED');
  }

  getStatus() {
    return this.state.getStatus();
  }

  getMetrics() {
    return this.metrics.getReport();
  }

  isRunning() {
    return this.state.isRunning();
  }
}

module.exports = RecoveryEngine;
