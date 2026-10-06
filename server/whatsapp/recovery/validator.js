// server/whatsapp/recovery/validator.js
const fs = require('fs').promises;
const crypto = require('crypto');
const path = require('path');
const config = require('./config');

class SessionValidator {
  constructor(sessionsModule, authStore, firebaseDb) {
    this.sessionsModule = sessionsModule;
    this.authStore = authStore;
    this.db = firebaseDb;
  }

  static RECOVERABLE = ['connected', 'connecting', 'reconnecting'];

  async canRecover(sessionDoc, timeout = 5000) {
    const start = Date.now();
    const uid = sessionDoc.uid;

    try {
      if (!SessionValidator.RECOVERABLE.includes(sessionDoc.state)) return false;
      if (sessionDoc.logoutAt) return false;

      // Validar credenciais existem em Firestore
      const credsRef = this.db.collection('whatsapp_auth').doc(sessionDoc.sessionId).collection('meta').doc('creds');
      const credsSnap = await Promise.race([
        credsRef.get(),
        new Promise((_, r) => setTimeout(() => r(new Error('Timeout')), timeout / 3)),
      ]);

      if (!credsSnap.exists) return false;

      // Verificar duração
      return (Date.now() - start) <= timeout;
    } catch (err) {
      return false;
    }
  }

  getPriority(state) {
    const p = { 'connected': 1, 'reconnecting': 2, 'connecting': 3 };
    return p[state] || 99;
  }
}

module.exports = SessionValidator;
