/* ══════════════════════════════════════════════════════════════════════
   credits/aiUsageReport.js — Relatório de uso da IA por conta
   ────────────────────────────────────────────────────────────────────
   Lê a subcolecção ai_usage_logs de cada conta e agrega os dados
   para o painel do administrador.

   Estrutura Firestore lida:
     workspaces/{accountId}/ai_usage_logs/{autoId}
       → timestamp          (ms UTC)
       → phone_number
       → input_tokens
       → output_tokens
       → model
       → duration_ms
       → estimated_cost_usd

   Funções exportadas:
     getUsageLogs(accountId, options)  — lista de logs paginada
     getUsageSummaryByClient(accountId) — custo e tokens por número
     getUsageTotals(accountId)          — totais agregados da conta
   ══════════════════════════════════════════════════════════════════════ */

const logger = require('../engine/logger');

let _db = null;

// Cache de relatórios agregados (by-client e totals) — 2 minutos
// Evita carregar 2000 documentos a cada vez que o painel é aberto.
// Os logs individuais (getUsageLogs) não são cacheados — têm paginação.
const _reportCache = new Map(); // key → { data, expiresAt }
const REPORT_TTL   = 2 * 60 * 1000;

function setFirestore(db) {
  _db = db;
}

/**
 * Devolve os logs de uso da IA de uma conta, ordenados do mais recente
 * para o mais antigo, com paginação opcional.
 *
 * @param {string} accountId
 * @param {object} options
 * @param {number} [options.limit=50]         — máximo de registos a devolver (máx: 500)
 * @param {number} [options.startAfterTs]     — timestamp ms para paginação (cursor)
 * @param {string} [options.phoneNumber]      — filtrar por número específico
 * @returns {Promise<{ logs: object[], hasMore: boolean }>}
 */
async function getUsageLogs(accountId, options = {}) {
  if (!_db) throw new Error('Firestore não inicializado.');

  const limit    = Math.min(Number(options.limit) || 50, 500);
  const phone    = options.phoneNumber || null;
  const cursorTs = options.startAfterTs ? Number(options.startAfterTs) : null;

  try {
    let query = _db
      .collection('workspaces')
      .doc(accountId)
      .collection('ai_usage_logs')
      .orderBy('timestamp', 'desc')
      .limit(limit + 1); // +1 para saber se há mais páginas

    if (phone) {
      query = query.where('phone_number', '==', phone);
    }

    if (cursorTs) {
      query = query.startAfter(cursorTs);
    }

    const snap = await query.get();
    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    const hasMore = docs.length > limit;
    if (hasMore) docs.pop(); // remover o extra usado para detectar hasMore

    return { logs: docs, hasMore };
  } catch (e) {
    logger.error(accountId, null, `[AiUsageReport] Erro ao ler logs: ${e.message}`);
    throw e;
  }
}

/**
 * Agrega o uso da IA por número de telefone (cliente).
 * Útil para o administrador ver quanto cada cliente está a consumir.
 *
 * @param {string} accountId
 * @returns {Promise<Array<{ phone_number, total_input_tokens, total_output_tokens, total_cost_usd, request_count }>>}
 */
async function getUsageSummaryByClient(accountId) {
  if (!_db) throw new Error('Firestore não inicializado.');

  const cacheKey = `byClient:${accountId}`;
  const cached   = _reportCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  try {
    const snap = await _db
      .collection('workspaces')
      .doc(accountId)
      .collection('ai_usage_logs')
      .orderBy('timestamp', 'desc')
      .limit(2000) // janela razoável para agregação sem sobrecarregar
      .get();

    // Agregar em memória por número de telefone
    const byPhone = {};

    for (const doc of snap.docs) {
      const d = doc.data();
      const phone = d.phone_number || 'desconhecido';

      if (!byPhone[phone]) {
        byPhone[phone] = {
          phone_number:        phone,
          total_input_tokens:  0,
          total_output_tokens: 0,
          total_cost_usd:      0,
          request_count:       0,
          last_activity:       0,
        };
      }

      byPhone[phone].total_input_tokens  += d.input_tokens  || 0;
      byPhone[phone].total_output_tokens += d.output_tokens || 0;
      byPhone[phone].total_cost_usd      += d.estimated_cost_usd || 0;
      byPhone[phone].request_count       += 1;

      if ((d.timestamp || 0) > byPhone[phone].last_activity) {
        byPhone[phone].last_activity = d.timestamp;
      }
    }

    // Ordenar por custo descendente
    const result = Object.values(byPhone).sort((a, b) => b.total_cost_usd - a.total_cost_usd);
    _reportCache.set(`byClient:${accountId}`, { data: result, expiresAt: Date.now() + REPORT_TTL });
    return result;
  } catch (e) {
    logger.error(accountId, null, `[AiUsageReport] Erro ao agregar por cliente: ${e.message}`);
    throw e;
  }
}

/**
 * Devolve os totais agregados de uso da IA da conta.
 *
 * @param {string} accountId
 * @returns {Promise<{ total_requests, total_input_tokens, total_output_tokens, total_cost_usd, avg_duration_ms }>}
 */
async function getUsageTotals(accountId) {
  if (!_db) throw new Error('Firestore não inicializado.');

  const cacheKey = `totals:${accountId}`;
  const cached   = _reportCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  try {
    const snap = await _db
      .collection('workspaces')
      .doc(accountId)
      .collection('ai_usage_logs')
      .orderBy('timestamp', 'desc')
      .limit(2000)
      .get();

    let total_input_tokens  = 0;
    let total_output_tokens = 0;
    let total_cost_usd      = 0;
    let total_duration_ms   = 0;
    const total_requests    = snap.size;

    for (const doc of snap.docs) {
      const d = doc.data();
      total_input_tokens  += d.input_tokens        || 0;
      total_output_tokens += d.output_tokens       || 0;
      total_cost_usd      += d.estimated_cost_usd  || 0;
      total_duration_ms   += d.duration_ms         || 0;
    }

    const result = {
      total_requests,
      total_input_tokens,
      total_output_tokens,
      total_cost_usd:  parseFloat(total_cost_usd.toFixed(6)),
      avg_duration_ms: total_requests > 0
        ? Math.round(total_duration_ms / total_requests)
        : 0,
    };
    _reportCache.set(`totals:${accountId}`, { data: result, expiresAt: Date.now() + REPORT_TTL });
    return result;
  } catch (e) {
    logger.error(accountId, null, `[AiUsageReport] Erro ao calcular totais: ${e.message}`);
    throw e;
  }
}

module.exports = {
  setFirestore,
  getUsageLogs,
  getUsageSummaryByClient,
  getUsageTotals,
};
