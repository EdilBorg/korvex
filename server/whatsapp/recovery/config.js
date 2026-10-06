// server/whatsapp/recovery/config.js
module.exports = {
  // Concorrência
  MAX_CONCURRENT_WORKERS: parseInt(process.env.RECOVERY_WORKERS) || 4,
  MAX_RECOVERY_SESSIONS_PER_RUN: parseInt(process.env.RECOVERY_MAX_SESSIONS) || 500,
  MAX_QUEUE_SIZE: 10000,
  
  // Retry
  MAX_RETRY_PER_SESSION: 3,
  
  // Timeouts (ms)
  TIMEOUT_SOCKET: 30000,
  TIMEOUT_QUERY_FIRESTORE: 5000,
  TIMEOUT_LOAD_CREDENTIALS: 3000,
  TIMEOUT_FINGERPRINT: 2000,
  
  // Circuit Breaker
  CB_FAILURE_THRESHOLD: 3,
  CB_SUCCESS_THRESHOLD: 2,
  CB_RESET_TIMEOUT: 30000,
  
  // Hash
  HASH_ALGORITHM: process.env.HASH_ALGORITHM || 'sha256',
  
  // Delays
  DELAY_WORKER_CHECK: 100,
};
