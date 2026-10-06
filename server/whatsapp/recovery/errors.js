// server/whatsapp/recovery/errors.js
class RecoveryError extends Error {
  constructor(message, code, context = {}) {
    super(message);
    this.name = 'RecoveryError';
    this.code = code;
    this.context = context;
  }
}

class CircuitBreakerOpenError extends RecoveryError {
  constructor(serviceName) {
    super(`CircuitBreaker ${serviceName} OPEN`, 'CB_OPEN', { service: serviceName });
  }
}

module.exports = { RecoveryError, CircuitBreakerOpenError };
