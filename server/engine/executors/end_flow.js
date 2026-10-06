/* ══════════════════════════════════════════════════════════════════════
   engine/executors/end_flow.js (nó Encerrar Fluxo)
   ────────────────────────────────────────────────────────────────────
   Envia a mensagem final (se configurada) e sinaliza o fim da conversa.
   O reset efectivo de currentNode é feito pelo workflowEngine.js após
   este executor devolver handled:true (mantém a responsabilidade de
   persistência centralizada no motor, não nos executores).
   ══════════════════════════════════════════════════════════════════════ */

const logger = require('../logger');
const { interpolate } = require('./send_text');

/**
 * @param {object} ctx
 * @returns {Promise<{handled: boolean, isEnd: boolean}>}
 */
async function execute(ctx) {
  const settings = ctx.node.settings || {};
  const text = settings.msg || settings.reason || '';

  logger.executed(ctx.uid, ctx.phone, ctx.node.nodeId, 'encerrar');

  if (text) {
    await ctx.sendMessage(interpolate(text, ctx.variables));
  }

  return { handled: true, isEnd: true };
}

module.exports = { execute };
