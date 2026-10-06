// server/whatsapp/recovery/circuitBreaker.js
class CircuitBreaker {
  constructor(name, options = {}) {
    this.name = name;
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureAt = null;
    this.failureThreshold = options.failureThreshold || 3;
    this.successThreshold = options.successThreshold || 2;
    this.resetTimeout = options.resetTimeout || 30000;
    this.timeout = options.timeout || 5000;
  }

  async call(fn) {
    if (this.state === 'OPEN') {
      const since = Date.now() - this.lastFailureAt;
      if (since < this.resetTimeout) {
        throw new Error(`CB ${this.name} OPEN`);
      }
      this.state = 'HALF_OPEN';
      this.successCount = 0;
    }

    try {
      const result = await Promise.race([
        fn(),
        new Promise((_, r) => setTimeout(() => r(new Error('CB timeout')), this.timeout)),
      ]);
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure();
      throw err;
    }
  }

  _onSuccess() {
    this.failureCount = 0;
    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.state = 'CLOSED';
        this.successCount = 0;
      }
    }
  }

  _onFailure() {
    this.lastFailureAt = Date.now();
    this.failureCount++;
    if (this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
    } else if (this.state === 'CLOSED' && this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
    }
  }

  getState() {
    return { name: this.name, state: this.state, failures: this.failureCount };
  }

  reset() {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureAt = null;
  }
}

module.exports = CircuitBreaker;
