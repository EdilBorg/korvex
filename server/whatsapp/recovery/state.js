// server/whatsapp/recovery/state.js
const EventEmitter = require('events');

class RecoveryState extends EventEmitter {
  constructor() {
    super();
    this.status = 'IDLE';
    this.startedAt = null;
    this.finishedAt = null;
    this.error = null;
    this.recoveryId = null;
  }

  static STATES = {
    IDLE: 'IDLE',
    STARTING: 'STARTING',
    RUNNING: 'RUNNING',
    FINISHED: 'FINISHED',
    FAILED: 'FAILED',
  };

  setStatus(newStatus, context = {}) {
    if (!Object.values(RecoveryState.STATES).includes(newStatus)) {
      throw new Error(`Invalid status: ${newStatus}`);
    }

    const oldStatus = this.status;
    this.status = newStatus;

    if (newStatus === 'STARTING') {
      this.startedAt = Date.now();
      this.finishedAt = null;
      this.error = null;
    } else if (newStatus === 'FINISHED') {
      this.finishedAt = Date.now();
      this.error = null;
    } else if (newStatus === 'FAILED') {
      this.finishedAt = Date.now();
      this.error = context.error || 'Unknown error';
    }

    this.emit('statusChange', { oldStatus, newStatus, recoveryId: this.recoveryId, ...context });
  }

  getStatus() {
    return {
      status: this.status,
      isRunning: this.status === 'RUNNING',
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      duration: this.finishedAt ? this.finishedAt - this.startedAt : null,
      error: this.error,
      recoveryId: this.recoveryId,
    };
  }

  isRunning() {
    return this.status === 'RUNNING';
  }

  setRecoveryId(id) {
    this.recoveryId = id;
  }

  reset() {
    this.status = 'IDLE';
    this.startedAt = null;
    this.finishedAt = null;
    this.error = null;
    this.recoveryId = null;
  }
}

module.exports = new RecoveryState();
