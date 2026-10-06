/* ══════════════════════════════════════════════════════════════════════
   FASE 5 — executors/wait_reply.js
   ────────────────────────────────────────────────────────────────────
   Executor do bloco AGUARDAR.

   Comportamento:
     • Suspende o fluxo gravando awaitingInput = nodeId no Firestore.
     • Devolve { awaitingInput: true } — o motor para aqui.
     • Na próxima mensagem do utilizador, workflowEngine.js detecta
       awaitingInput e retoma a partir do nó SEGUINTE ao AGUARDAR
       (sem guardar variável — isso é responsabilidade do bloco PERGUNTA).

   Não altera nada do comportamento do bloco PERGUNTA (ask_question.js).
   ══════════════════════════════════════════════════════════════════════ */

const conversations = require('../conversations');
const logger        = require('../logger');

/**
 * @param {object} ctx  { uid, phone, node, flow, variables, incomingText, sendMessage }
 * @returns {Promise<{awaitingInput: boolean}>}
 */
async function execute(ctx) {
  const { uid, phone, node } = ctx;

  await conversations.setAwaitingInput(uid, phone, String(node.nodeId));

  logger.info(uid, phone, `[WAIT] Fluxo suspenso no nó ${node.nodeId} — à espera de resposta do utilizador.`);

  return { awaitingInput: true };
}

module.exports = { execute };
