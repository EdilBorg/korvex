/* ══════════════════════════════════════════════════════════════════════
   credits/aiUsageLogger.js — Logger de chamadas à IA por workspace
   ────────────────────────────────────────────────────────────────────
   Regista cada invocação ao modelo Gemini numa subcolecção Firestore:
     workspaces/{workspaceId}/ai_usage_logs/{autoId}

   Campos gravados:
     timestamp          — quando a chamada ocorreu (ms UTC)
     phone_number       — número de telefone do contacto
     input_tokens       — tokens de entrada consumidos
     output_tokens      — tokens de saída gerados
     model              — modelo utilizado (ex.: gemini-2.5-flash)
     duration_ms        — tempo de resposta da API em milissegundos
     estimated_cost_usd — custo estimado em USD desta chamada
   ══════════════════════════════════════════════════════════════════════ */

const logger = require('../engine/logger');

let _db = null;

function setFirestore(db) {
  _db = db;
}

/**
 * Regista uma chamada à IA na subcolecção ai_usage_logs da workspace.
 *
 * O documento é criado com ID automático do Firestore (addDoc).
 * Falhas de escrita são silenciosas — não devem impedir o fluxo principal.
 *
 * Preços para cálculo do custo:
 *   Input:  $0.30 por milhão de tokens
 *   Output: $2.50 por milhão de tokens
 *
 * @param {string} workspaceId    — UID da workspace
 * @param {string} phoneNumber    — número WhatsApp do utilizador final
 * @param {number} inputTokens    — tokens de entrada da resposta da API
 * @param {number} outputTokens   — tokens de saída da resposta da API
 * @param {string} model          — nome do modelo utilizado
 * @param {number} durationMs     — duração total da chamada em ms
 * @returns {Promise<void>}
 */
async function logAiUsage(workspaceId, phoneNumber, inputTokens, outputTokens, model, durationMs) {
  if (!_db) {
    logger.warn(workspaceId, phoneNumber, '[AiUsageLogger] Firestore não inicializado — registo ignorado.');
    return;
  }

  try {
    const estimated_cost_usd =
      ((inputTokens  || 0) / 1_000_000) * 0.30 +
      ((outputTokens || 0) / 1_000_000) * 2.50;

    const logEntry = {
      timestamp:          Date.now(),
      phone_number:       phoneNumber    || null,
      input_tokens:       inputTokens    || 0,
      output_tokens:      outputTokens   || 0,
      model:              model          || null,
      duration_ms:        durationMs     || 0,
      estimated_cost_usd,
    };

    await _db
      .collection('workspaces')
      .doc(workspaceId)
      .collection('ai_usage_logs')
      .add(logEntry);

    logger.info(
      workspaceId,
      phoneNumber,
      `[AiUsageLogger] Registo gravado — in: ${inputTokens} | out: ${outputTokens} | ${durationMs}ms | $${estimated_cost_usd.toFixed(6)}`
    );

  } catch (e) {
    // Falha de logging nunca deve quebrar o fluxo principal
    logger.error(
      workspaceId,
      phoneNumber,
      `[AiUsageLogger] Erro ao gravar registo de uso: ${e.message}`
    );
  }
}

module.exports = {
  setFirestore,
  logAiUsage,
};
