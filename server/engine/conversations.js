/* ══════════════════════════════════════════════════════════════════════
   FASE 3.2.3 — engine/conversations.js
   ────────────────────────────────────────────────────────────────────
   Sessões de conversa — cada número de telefone continua exactamente
   no ponto onde parou.

   Caminho Firestore:
     workspaces/{uid}/conversations/{phone}

   Documento:
     {
       phone:          string,
       currentNode:    string | null,   // nodeId onde a conversa está
       flowId:         string | null,   // a que fluxo esta posição pertence
       variables:      object,          // ex.: { nome: "João" }
       awaitingInput:  string | null,   // nodeId de uma 'pergunta' pendente
       lastInteraction: number,         // epoch ms
       createdAt:      number,
     }

   Nota: phone é usado directamente como ID do documento. Números de
   WhatsApp já vêm normalizados (ver manager.js — extracção em
   messages.upsert), mas sanitizamos aqui na key por segurança (Firestore
   document IDs não podem conter '/').
   ══════════════════════════════════════════════════════════════════════ */

const logger = require('./logger');

let _db = null;

// ── Cache em memória de conversas activas ────────────────────────────
// Evita uma leitura Firestore por cada mensagem recebida.
// TTL de 5 minutos — tempo razoável para dados de conversa que mudam
// frequentemente mas não precisam de consistência imediata a cada ms.
// Com 500 utilizadores activos: máximo 500 entradas × ~1KB = ~500KB RAM.
const _cache     = new Map(); // key: `${uid}:${safePhone}` → { data, expiresAt }
const CONV_TTL   = 5 * 60 * 1000; // 5 minutos

// Limpeza periódica: remover entradas expiradas a cada 10 minutos
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _cache) {
    if (now > v.expiresAt) _cache.delete(k);
  }
}, 10 * 60 * 1000);

function setFirestore(db) {
  _db = db;
}

// Invalidar cache de uma conversa específica (chamado após save())
function _invalidate(uid, phone) {
  _cache.delete(`${uid}:${_safeId(phone)}`);
}

function _safeId(phone) {
  return String(phone).replace(/\//g, '_');
}

function _ref(uid, phone) {
  if (!_db) return null;
  return _db
    .collection('workspaces').doc(uid)
    .collection('conversations').doc(_safeId(phone));
}

/**
 * Devolve a conversa existente, ou cria uma nova em branco (currentNode
 * null, sem variáveis) — não persiste a criação até à primeira escrita
 * via save(), para evitar custos de escrita em leituras puras.
 * @param {string} uid
 * @param {string} phone
 * @returns {Promise<object>}
 */
async function getOrCreate(uid, phone) {
  const cacheKey = `${uid}:${_safeId(phone)}`;
  const cached   = _cache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  const ref = _ref(uid, phone);
  if (!ref) {
    logger.warn(uid, phone, 'Firestore não inicializado — conversa apenas em memória.');
    return _blank(phone);
  }

  try {
    const snap = await ref.get();
    const data = snap.exists ? snap.data() : _blank(phone);
    _cache.set(cacheKey, { data, expiresAt: Date.now() + CONV_TTL });
    return data;
  } catch (e) {
    logger.error(uid, phone, `Erro ao carregar conversa: ${e.message}`);
    return _blank(phone);
  }
}

function _blank(phone) {
  return {
    phone,
    currentNode:     null,
    flowId:          null,
    variables:       {},
    awaitingInput:   null,
    lastInteraction: Date.now(),
    createdAt:       Date.now(),
  };
}

/**
 * Persiste o estado actual da conversa (merge — não apaga campos não
 * incluídos no patch).
 * @param {string} uid
 * @param {string} phone
 * @param {object} patch
 * @returns {Promise<void>}
 */
async function save(uid, phone, patch) {
  const ref = _ref(uid, phone);

  // Actualizar cache imediatamente em memória (optimistic update)
  // para que a próxima leitura não precise de ir ao Firestore
  const cacheKey = `${uid}:${_safeId(phone)}`;
  const existing = _cache.get(cacheKey);
  if (existing) {
    existing.data = { ...existing.data, ...patch, phone, lastInteraction: Date.now() };
    existing.expiresAt = Date.now() + CONV_TTL;
  }

  if (!ref) return;

  try {
    await ref.set(
      { ...patch, phone, lastInteraction: Date.now() },
      { merge: true }
    );
  } catch (e) {
    logger.error(uid, phone, `Erro ao guardar conversa: ${e.message}`);
    _invalidate(uid, phone); // invalidar cache se escrita falhou
  }
}

/**
 * Atualiza apenas o nó actual e, opcionalmente, o flowId associado.
 * @param {string} uid
 * @param {string} phone
 * @param {string|null} nodeId
 * @param {string} [flowId]
 */
async function setCurrentNode(uid, phone, nodeId, flowId) {
  const patch = { currentNode: nodeId };
  if (flowId) patch.flowId = flowId;
  await save(uid, phone, patch);
}

/**
 * Define qual nó (tipo 'pergunta'/'aguardar') está à espera da próxima
 * mensagem do utilizador como resposta. null = não está à espera de nada
 * em particular (próxima mensagem é tratada como novo turno normal).
 * @param {string} uid
 * @param {string} phone
 * @param {string|null} nodeId
 */
async function setAwaitingInput(uid, phone, nodeId) {
  await save(uid, phone, { awaitingInput: nodeId });
}

/**
 * Define uma variável da conversa (merge raso dentro de `variables`).
 * @param {string} uid
 * @param {string} phone
 * @param {object} currentVariables  Variáveis já carregadas em memória
 * @param {string} key
 * @param {*} value
 * @returns {object} novo objecto de variáveis (para manter em memória sem reler)
 */
async function setVariable(uid, phone, currentVariables, key, value) {
  const variables = { ...(currentVariables || {}), [key]: value };
  await save(uid, phone, { variables });
  return variables;
}

/**
 * Reinicia a conversa (usado pelo nó 'encerrar' — fim do fluxo).
 * @param {string} uid
 * @param {string} phone
 */
async function reset(uid, phone) {
  await save(uid, phone, { currentNode: null, awaitingInput: null, flowId: null });
}

module.exports = {
  setFirestore, getOrCreate, save,
  setCurrentNode, setAwaitingInput, setVariable, reset,
};
