// server/whatsapp/recovery/repository.js
const config = require('./config');

class RecoveryRepository {
  constructor(firebaseDb) {
    this.db = firebaseDb;
  }

  async loadRecoverableSessions(timeout = 5000) {
    try {
      const snap = await Promise.race([
        this.db.collection('whatsappSessions')
          .where('status', 'in', ['connected', 'connecting', 'reconnecting'])
          .get(),
        new Promise((_, r) => setTimeout(() => r(new Error('Timeout')), timeout)),
      ]);

      return snap.docs.map(doc => ({ ...doc.data(), id: doc.id }));
    } catch (err) {
      throw new Error(`Failed to load sessions: ${err.message}`);
    }
  }

  async saveMetrics(recoveryId, metrics) {
    try {
      await this.db.collection('recoveryMetrics').doc(recoveryId).set({
        ...metrics,
        timestamp: Date.now(),
      });
    } catch (err) {
      console.error(`[Recovery] Failed to save metrics: ${err.message}`);
    }
  }

  async updateRecoveryStatus(recoveryId, status) {
    try {
      await this.db.collection('recoveryStatus').doc(recoveryId).set({
        status,
        updatedAt: Date.now(),
      }, { merge: true });
    } catch (err) {
      console.error(`[Recovery] Failed to update status: ${err.message}`);
    }
  }
}

module.exports = RecoveryRepository;
