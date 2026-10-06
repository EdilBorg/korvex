// server/whatsapp/recovery/mutex.js
// Implementação simples de Mutex sem dependências externas
class Mutex {
  constructor() {
    this.locked = false;
    this.queue = [];
  }

  async lock(fn) {
    while (this.locked) {
      await new Promise(resolve => this.queue.push(resolve));
    }
    this.locked = true;
    try {
      return await fn();
    } finally {
      this.locked = false;
      const resolve = this.queue.shift();
      if (resolve) resolve();
    }
  }
}

module.exports = Mutex;
