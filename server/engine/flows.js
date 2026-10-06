/* ══════════════════════════════════════════════════════════════════════
   FASE 3.2.1 — engine/flows.js (Gestão de Fluxos por Número WhatsApp)
   ────────────────────────────────────────────────────────────────────
   ALTERAÇÃO CRÍTICA — substitui por completo o antigo conceito de
   "Fluxo Publicado". O motor NUNCA MAIS procura published/draft.

   Novo comportamento:
     1. Ler workspaces/{uid}/connections/whatsapp → activeFlowId
     2. Se não houver activeFlowId definido → não há fluxo para executar
        (mensagens são ignoradas até o utilizador escolher um fluxo em
        "Gerir Canal" — decisão confirmada para esta fase)
     3. Carregar workspaces/{uid}/flows/{activeFlowId} directamente

   Esta camada é, propositadamente, "burra": não sabe nada sobre status,
   publicação, ou validação — apenas associação directa entre o número
   (a conexão) e o fluxo a executar.

   Preparado para múltiplos números (Parte 8): hoje só existe o
   documento connections/whatsapp (um único número), mas a função
   aceita explicitamente um "channelDoc" (por omissão 'whatsapp') para
   o dia em que existirem vários documentos de conexão — um por número
   — sem precisar de alterar a assinatura desta função.

   Cache: cada (uid, channelDoc) fica em cache em memória por
   CACHE_TTL_MS, evitando duas leituras ao Firestore (connections +
   flows) por cada mensagem recebida.
   ══════════════════════════════════════════════════════════════════════ */

const logger = require('./logger');

let _db = null;

/** @type {Map<string, {flow: object|null, expiresAt: number}>} */
const _cache = new Map();

// TTL base de 30s com jitter de ±5s para evitar thundering herd:
// se 500 utilizadores carregassem o fluxo ao mesmo tempo, todos os
// caches expirariam em simultâneo e disparariam 500 leituras Firestore
// ao mesmo segundo. O jitter distribui as expirações ao longo do tempo.
const CACHE_TTL_BASE_MS  = 30 * 1000;
const CACHE_TTL_JITTER_MS = 5 * 1000;
function _cacheTTL() {
  return CACHE_TTL_BASE_MS + Math.floor(Math.random() * CACHE_TTL_JITTER_MS * 2) - CACHE_TTL_JITTER_MS;
}
const CACHE_TTL_MS = CACHE_TTL_BASE_MS; // mantido para compatibilidade

function setFirestore(db) {
  _db = db;
}

// Limpeza periódica do cache de fluxos (a cada 2 minutos)
// Evita que o Map cresça indefinidamente com entradas de contas inactivas
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _cache) {
    if (now > v.expiresAt) _cache.delete(k);
  }
}, 2 * 60 * 1000);

/**
 * Invalida o cache de um workspace/canal específico (ou todo o cache se
 * uid omitido).
 * @param {string} [uid]
 * @param {string} [channelDoc]
 */
function invalidate(uid, channelDoc) {
  if (uid && channelDoc) _cache.delete(`${uid}:${channelDoc}`);
  else if (uid) {
    for (const key of _cache.keys()) if (key.startsWith(`${uid}:`)) _cache.delete(key);
  } else {
    _cache.clear();
  }
}

/**
 * Devolve o fluxo ativo associado ao número de WhatsApp (documento de
 * conexão) de um workspace, ou null se:
 *   - não houver documento de conexão para este canal, ou
 *   - activeFlowId não estiver definido, ou
 *   - o fluxo referenciado já não existir (ex.: foi apagado).
 *
 * @param {string} uid
 * @param {string} [channelDoc='whatsapp']  Documento em connections/{channelDoc}.
 *   Preparado para múltiplos números no futuro (Parte 8) — cada número
 *   terá o seu próprio documento de conexão com o seu próprio
 *   activeFlowId, e esta função já aceita identificá-lo.
 * @returns {Promise<object|null>}
 */
async function getActiveFlowForChannel(uid, channelDoc = 'whatsapp') {
  const cacheKey = `${uid}:${channelDoc}`;
  const cached = _cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.flow;
  }

  if (!_db) {
    logger.warn(uid, null, 'Firestore não inicializado — getActiveFlowForChannel() abortado.');
    return null;
  }

  try {
    // 1. Ler o documento de conexão para obter activeFlowId
    const connSnap = await _db
      .collection('workspaces').doc(uid)
      .collection('connections').doc(channelDoc)
      .get();

    if (!connSnap.exists) {
      _cache.set(cacheKey, { flow: null, expiresAt: Date.now() + _cacheTTL() });
      return null;
    }

    const activeFlowId = connSnap.data().activeFlowId;
    if (!activeFlowId) {
      // Nenhum fluxo escolhido ainda para este número — comportamento
      // esperado: ignorar mensagens até o utilizador escolher um fluxo
      // em "Gerir Canal" (decisão confirmada para esta fase).
      _cache.set(cacheKey, { flow: null, expiresAt: Date.now() + _cacheTTL() });
      return null;
    }

    // 2. Carregar o fluxo directamente pelo flowId
    const flowSnap = await _db
      .collection('workspaces').doc(uid)
      .collection('flows').doc(activeFlowId)
      .get();

    if (!flowSnap.exists) {
      logger.warn(uid, null, `activeFlowId "${activeFlowId}" aponta para um fluxo que já não existe.`);
      _cache.set(cacheKey, { flow: null, expiresAt: Date.now() + _cacheTTL() });
      return null;
    }

    const flow = flowSnap.data();
    // ─────────────────────────────────────────────────────────────────

    _cache.set(cacheKey, { flow, expiresAt: Date.now() + _cacheTTL() });
    return flow;
  } catch (e) {
    logger.error(uid, null, `Erro ao buscar fluxo ativo do canal "${channelDoc}": ${e.message}`);
    return null;
  }
}

module.exports = { setFirestore, getActiveFlowForChannel, invalidate };
