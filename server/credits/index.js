/* ══════════════════════════════════════════════════════════════════════
   credits/index.js — Ponto de entrada do módulo de créditos IA
   ────────────────────────────────────────────────────────────────────
   Expõe as funções públicas de creditManager, aiUsageLogger e
   aiUsageReport, e coordena a inicialização do Firestore nos três módulos.

   Utilização típica em server/index.js:
     const credits = require('./credits');
     credits.setFirestore(db);

   Utilização em workflowEngine.js:
     const { checkCredits, consumeCredits, checkRateLimit } = require('../credits');
     const { logAiUsage }                                   = require('../credits');
   ══════════════════════════════════════════════════════════════════════ */

const creditManager  = require('./creditManager');
const aiUsageLogger  = require('./aiUsageLogger');
const aiUsageReport  = require('./aiUsageReport');

/**
 * Inicializa o módulo de créditos com a instância do Firestore.
 * Deve ser chamado uma vez a partir de server/index.js após o Firebase Admin estar pronto.
 * @param {import('firebase-admin').firestore.Firestore} db
 */
function setFirestore(db) {
  creditManager.setFirestore(db);
  aiUsageLogger.setFirestore(db);
  aiUsageReport.setFirestore(db);
}

module.exports = {
  // Inicialização
  setFirestore,

  // creditManager
  loadGlobalConfig: creditManager.loadGlobalConfig,
  checkRateLimit:   creditManager.checkRateLimit,
  checkCredits:     creditManager.checkCredits,
  consumeCredits:   creditManager.consumeCredits,
  getWarningLevel:  creditManager.getWarningLevel,
  getUsageSummary:  creditManager.getUsageSummary,
  getCreditsEstimate: creditManager.getCreditsEstimate,

  // aiUsageLogger
  logAiUsage:       aiUsageLogger.logAiUsage,

  // aiUsageReport
  getUsageLogs:            aiUsageReport.getUsageLogs,
  getUsageSummaryByClient: aiUsageReport.getUsageSummaryByClient,
  getUsageTotals:          aiUsageReport.getUsageTotals,
};
