// server/whatsapp/recovery/queue.js
const Mutex = require('./mutex');

class RecoveryQueue {
  constructor() {
    this.tasks = [];
    this.mutex = new Mutex();
  }

  static PRIORITY = {
    'connected': 1,
    'reconnecting': 2,
    'connecting': 3,
  };

  async push(task) {
    return this.mutex.lock(async () => {
      if (!task || !task.uid) throw new Error('Invalid task: missing uid');
      task.priority = RecoveryQueue.PRIORITY[task.state] || 99;
      
      if (this.tasks.some(t => t.uid === task.uid)) {
        throw new Error(`Task ${task.uid} exists`);
      }

      let inserted = false;
      for (let i = 0; i < this.tasks.length; i++) {
        if (task.priority < this.tasks[i].priority) {
          this.tasks.splice(i, 0, task);
          inserted = true;
          break;
        }
      }
      if (!inserted) this.tasks.push(task);
      return task;
    });
  }

  async pop() {
    return this.mutex.lock(async () => this.tasks.shift() || null);
  }

  async has(uid) {
    return this.mutex.lock(async () => this.tasks.some(t => t.uid === uid));
  }

  async size() {
    return this.mutex.lock(async () => this.tasks.length);
  }

  async getAll() {
    return this.mutex.lock(async () => [...this.tasks]);
  }

  async getStats() {
    return this.mutex.lock(async () => ({
      total: this.tasks.length,
      byState: {
        connected: this.tasks.filter(t => t.state === 'connected').length,
        reconnecting: this.tasks.filter(t => t.state === 'reconnecting').length,
        connecting: this.tasks.filter(t => t.state === 'connecting').length,
      },
    }));
  }
}

module.exports = RecoveryQueue;
