/* ══════════════════════════════════════════════════════════════════════
   sessions/index.js — Ponto de entrada do módulo de sessões
   ────────────────────────────────────────────────────────────────────
   Expõe as funções públicas de sessionManager e coordena a
   inicialização do Firestore.

   Utilização típica em server/index.js:
     const sessions = require('./sessions');
     sessions.setFirestore(db);

   Utilização em workflowEngine.js:
     const {
       getSession, createSession, updateSessionNode,
       completeSession, resetSession, getAiContext, saveMessage
     } = require('../sessions');

   Ferramentas do administrador (server/index.js):
     const {
       clearMessageHistory, blockAi, unblockAi, exportConversation
     } = require('./sessions');
   ══════════════════════════════════════════════════════════════════════ */

const sessionManager = require('./sessionManager');

/**
 * Inicializa o módulo de sessões com a instância do Firestore.
 * Deve ser chamado uma vez a partir de server/index.js após o Firebase
 * Admin estar pronto.
 * @param {import('firebase-admin').firestore.Firestore} db
 */
function setFirestore(db) {
  sessionManager.setFirestore(db);
}

module.exports = {
  // Inicialização
  setFirestore,

  // sessionManager — ciclo de vida da sessão
  getSession:        sessionManager.getSession,
  createSession:     sessionManager.createSession,
  updateSessionNode: sessionManager.updateSessionNode,
  completeSession:   sessionManager.completeSession,
  resetSession:      sessionManager.resetSession,

  // sessionManager — contexto para a IA
  getAiContext:      sessionManager.getAiContext,

  // sessionManager — histórico de mensagens
  saveMessage:       sessionManager.saveMessage,

  // Ferramentas do administrador
  clearMessageHistory: sessionManager.clearMessageHistory,
  blockAi:             sessionManager.blockAi,
  unblockAi:           sessionManager.unblockAi,
  exportConversation:  sessionManager.exportConversation,
};
