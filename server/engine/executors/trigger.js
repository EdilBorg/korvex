/* ══════════════════════════════════════════════════════════════════════
   FASE 3.2.5 — engine/executors/trigger.js (nó Início)
   ────────────────────────────────────────────────────────────────────
   O nó Início não produz nenhuma saída para o utilizador — apenas marca
   o ponto de entrada do fluxo. O motor avança automaticamente para o
   próximo nó conectado logo a seguir a executar este.
   ══════════════════════════════════════════════════════════════════════ */

const logger = require('../logger');

/**
 * @param {object} ctx
 * @returns {Promise<{handled: boolean}>}
 */
async function execute(ctx) {
  logger.executed(ctx.uid, ctx.phone, ctx.node.nodeId, 'inicio');
  return { handled: true };
}

module.exports = { execute };
