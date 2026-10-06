/* ══════════════════════════════════════════════════════════════════════
   FASE 3.2.7 — engine/executors/ask_question.js (nó Pergunta)
   ────────────────────────────────────────────────────────────────────
   Envia a pergunta configurada e marca a conversa como "à espera de
   resposta" neste nó (awaitingInput). A captura efectiva da resposta
   do utilizador (mensagem seguinte) é feita pelo workflowEngine.js,
   que reconhece awaitingInput e desvia o fluxo normal para
   _captureAnswer() ANTES de tratar a mensagem como um novo turno —
   este executor só cobre o "enviar a pergunta" (chegada ao nó).

   IMPORTANTE (regra do pedido): o utilizador do Korvex nunca precisa de
   criar/nomear variáveis manualmente. O campo `var` no Flow Builder já
   existe (ex.: "{{nome}}") apenas como rótulo legível no editor — aqui
   extraímos automaticamente o nome interno da variável de dentro das
   chavetas, sem exigir nada novo nem mudar esse campo na UI. Se o campo
   estiver vazio, geramos um nome de variável a partir do nodeId, para
   nunca falhar silenciosamente.
   ══════════════════════════════════════════════════════════════════════ */

const logger = require('../logger');
const { interpolate } = require('./send_text');

/**
 * Extrai o nome interno da variável a partir do campo `var`/`variable`
 * do nó (formatos aceites: "{{nome}}", "nome", ou vazio).
 * @param {object} node
 * @returns {string}
 */
function variableNameFor(node) {
  const settings = node.settings || {};
  const raw = settings.var || settings.variable || '';
  const match = String(raw).match(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/);
  if (match) return match[1];
  if (raw && /^[a-zA-Z0-9_]+$/.test(raw)) return raw;
  // Fallback: gerar nome estável a partir do nodeId, transparente para o utilizador
  return `resposta_${node.nodeId}`;
}

/**
 * @param {object} ctx
 * @returns {Promise<{handled: boolean, awaitingInput: boolean}>}
 */
async function execute(ctx) {
  const settings = ctx.node.settings || {};
  const text = settings.txt || settings.text || '';

  logger.executed(ctx.uid, ctx.phone, ctx.node.nodeId, 'pergunta');

  if (text) {
    await ctx.sendMessage(interpolate(text, ctx.variables));
  } else {
    logger.warn(ctx.uid, ctx.phone, `Nó ${ctx.node.nodeId} (pergunta) sem texto configurado.`);
  }

  // Sinaliza ao motor que a próxima mensagem do utilizador deve ser
  // tratada como resposta a este nó, não como um novo turno do fluxo.
  return { handled: true, awaitingInput: true };
}

module.exports = { execute, variableNameFor };
