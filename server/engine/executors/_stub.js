/* ══════════════════════════════════════════════════════════════════════
   engine/executors/_stub.js
   ────────────────────────────────────────────────────────────────────
   Executor de fallback para tipos de nó cujo comportamento completo
   ainda não foi implementado nesta fase (Botão, Lista, Condição,
   Webhook, etc. — ver relatório da FASE 3.2 sobre o porquê).

   Comportamento seguro: regista o log, NÃO envia nada ao utilizador
   (para não enviar uma mensagem de erro confusa numa conversa real),
   e devolve handled:true para o motor poder tentar avançar para o
   próximo nó pela primeira aresta disponível (sem lógica condicional).
   Isto evita que o fluxo trave numa conversa real só porque contém um
   tipo de nó ainda não activado — o pior caso é "salta" esse nó.
   ══════════════════════════════════════════════════════════════════════ */

const logger = require('../logger');

/**
 * @param {object} ctx
 * @returns {Promise<{handled: boolean}>}
 */
async function execute(ctx) {
  logger.warn(
    ctx.uid, ctx.phone,
    `Nó ${ctx.node.nodeId} (tipo "${ctx.node.type}") ainda não tem executor completo nesta fase — a saltar para o próximo.`
  );
  return { handled: true };
}

module.exports = { execute };
