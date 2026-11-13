/* ══════════════════════════════════════════════════════════════════════
   CAMADA 1.1 — WHATSAPP STABILIZER — sessions.js
   ────────────────────────────────────────────────────────────────────
   Registo em memória das sessões WhatsApp activas com STATE MACHINE
   completa (State Machine Obrigatória).
   
   ESTADOS VÁLIDOS:
   • idle          → sessão nunca foi iniciada
   • connecting    → tentando se conectar (QR aguardando leitura)
   • reconnecting  → tentando se reconectar após desconexão
   • connected     → conectado com sucesso
   • failed        → atingiu limite de tentativas / irrecuperável
   • disconnected  → desconectado manualmente

   Cada sessão é indexada pelo uid do utilizador Korvex.

   Estrutura de cada sessão (NOVA):
   {
     uid:              string,        // uid Firebase do utilizador
     sessionId:        string,        // igual ao uid (1 sessão por utilizador)
     socket:           BaileysSocket, // socket Baileys activo
     state:            string,        // novo: 'idle'|'connecting'|'connected'|'reconnecting'|'failed'|'disconnected'
     phone:            string | null, // número conectado (+258xxxxxxxxx)
     qr:               string | null, // QR Code em base64 (data URI)
     qrGeneratedAt:    number | null,
     connectedAt:      number | null,
     createdAt:        number,
     
     // NOVOS campos para State Machine + Retry Control:
     retryCount:       number,        // tentativas consecutivas actuais
     maxRetries:       number,        // limite máximo (5)
     lastError:        object | null, // { code, message, timestamp }
     lastErrorAt:      number | null, // timestamp do último erro
     failedAt:         number | null, // quando entrou em estado FAILED
     socketInstanceId: number,        // guarda contra sockets fantasma
     stateChangedAt:   number,        // timestamp da última mudança de state
   }
   ══════════════════════════════════════════════════════════════════════ */

/** @type {Map<string, object>} */
const _sessions = new Map();

// Constantes de limite
const DEFAULT_MAX_RETRIES = 5;
const WATCHDOG_CONNECTING_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutos

// Estados válidos
const VALID_STATES = ['idle', 'connecting', 'reconnecting', 'connected', 'failed', 'disconnected'];

/**
 * Cria ou substitui a entrada para um uid.
 * @param {string} uid
 * @param {object} data
 */
function set(uid, data) {
  const existing = _sessions.get(uid) || {};
  
  // Validar transição de state se fornecido
  if (data.state && !VALID_STATES.includes(data.state)) {
    throw new Error(`[Sessions] State inválido: ${data.state}. Estados válidos: ${VALID_STATES.join(', ')}`);
  }
  
  // Se state está mudando, registar timestamp
  const stateChanging = data.state && data.state !== existing.state;
  
  const updated = {
    ...existing,
    ...data,
    uid,
    stateChangedAt: stateChanging ? Date.now() : (existing.stateChangedAt || Date.now()),
  };
  
  _sessions.set(uid, updated);
  return updated;
}

/**
 * Devolve a sessão para um uid (ou null).
 * @param {string} uid
 * @returns {object|null}
 */
function get(uid) {
  return _sessions.get(uid) || null;
}

/**
 * Remove a sessão de um uid.
 * @param {string} uid
 */
function remove(uid) {
  _sessions.delete(uid);
}

/**
 * Verifica se existe sessão para um uid.
 * @param {string} uid
 * @returns {boolean}
 */
function has(uid) {
  return _sessions.has(uid);
}

/**
 * Devolve todos os uids com sessão activa.
 * @returns {string[]}
 */
function allUids() {
  return [..._sessions.keys()];
}

/**
 * Devolve o número de sessões no estado especificado.
 * @param {string} state  — 'idle'|'connecting'|'connected'|'reconnecting'|'failed'|'disconnected'
 * @returns {number}
 */
function countByState(state) {
  if (!VALID_STATES.includes(state)) {
    throw new Error(`[Sessions] countByState: state inválido: ${state}`);
  }
  let n = 0;
  for (const s of _sessions.values()) {
    if (s.state === state) n++;
  }
  return n;
}

// Alias para compatibilidade (alguns pontos do código ainda usam "status")
function countByStatus(status) {
  // Mapear status antigo para novo state
  const statusToState = {
    'connecting': 'connecting',
    'connected': 'connected',
    'disconnected': 'disconnected',
  };
  const state = statusToState[status];
  if (state) return countByState(state);
  return 0;
}

/**
 * Actualiza o state de uma sessão com validação.
 * @param {string} uid
 * @param {string} state  — 'idle'|'connecting'|'connected'|'reconnecting'|'failed'|'disconnected'
 * @param {object} [extra] — campos adicionais a fundir
 */
function setState(uid, state, extra = {}) {
  if (!VALID_STATES.includes(state)) {
    throw new Error(`[Sessions] setState: state inválido: ${state}`);
  }
  return set(uid, { state, status: state, ...extra });
}

/**
 * NOVO — Verifica se é seguro iniciar uma nova conexão para um uid.
 * Retorna true se:
 * - Não existe sessão, OU
 * - Sessão está em 'idle', 'failed', 'disconnected', ou 'reconnecting'
 *
 * 'reconnecting' é permitido: significa que a ligação anterior já fechou
 * e o auto-reconnect (ou um pedido manual) deve poder criar um novo socket.
 *
 * Retorna false (bloqueia) se:
 * - Sessão está em 'connecting' ou 'connected' (ligação viva / em curso)
 *
 * Usa isto ANTES de chamar makeWASocket() para evitar sockets duplicados.
 * A serialização de startSession() continua em _startSessionLocks no manager.
 * 
 * @param {string} uid
 * @returns {boolean}
 */
function canStartNewConnection(uid) {
  const sess = get(uid);
  if (!sess) return true; // sem sessão = pode iniciar

  // reconnecting = a ligação anterior já encerrou e está agendada uma
  // nova tentativa (auto-reconnect). NÃO bloquear: caso contrário
  // startSession({ fresh:false }) é rejeitado e a sessão fica presa
  // em "reconnecting" sem QR nem socket novo.
  // A protecção contra sockets duplicados continua em:
  //   - _startSessionLocks (uma execução de startSession por uid)
  //   - estados 'connecting' / 'connected' abaixo
  if (sess.state === 'reconnecting') {
    return true;
  }

  // Estados que BLOQUEIAM nova conexão (ligação viva ou em curso)
  const blockingStates = ['connecting', 'connected'];
  return !blockingStates.includes(sess.state);
}

/**
 * NOVO — Marca uma sessão como FAILED (atingiu limite de retries).
 * Regista o timestamp para observabilidade.
 * 
 * @param {string} uid
 * @param {object} lastError — { code?: string, message: string }
 */
function setFailed(uid, lastError = null) {
  const sess = get(uid);
  if (!sess) return;
  
  set(uid, {
    state: 'failed',
    failedAt: Date.now(),
    lastError: lastError || { message: 'Estado FAILED' },
    lastErrorAt: Date.now(),
  });
}

/**
 * NOVO — Verifica se uma sessão pode tentar reconectar.
 * Retorna false se:
 * - Está em FAILED (limite de retries atingido)
 * - Logout foi detectado (código 401)
 * 
 * @param {string} uid
 * @returns {boolean}
 */
function canReconnect(uid) {
  const sess = get(uid);
  if (!sess) return false;
  if (sess.state === 'failed') return false;
  return true;
}

/**
 * NOVO — Incrementa o contador de retry para uma sessão.
 * Retorna true se ainda pode continuar tentando.
 * Retorna false se atingiu o limite (maxRetries).
 * 
 * @param {string} uid
 * @returns {boolean} true se pode continuar, false se atingiu limite
 */
function incrementRetry(uid) {
  const sess = get(uid);
  if (!sess) return false;
  
  const maxRetries = sess.maxRetries || DEFAULT_MAX_RETRIES;
  const newCount = (sess.retryCount || 0) + 1;
  
  set(uid, {
    retryCount: newCount,
    lastErrorAt: Date.now(),
  });
  
  return newCount <= maxRetries;
}

/**
 * NOVO — Reseta o contador de retry (após conexão bem-sucedida).
 * 
 * @param {string} uid
 */
function resetRetry(uid) {
  const sess = get(uid);
  if (!sess) return;
  
  set(uid, {
    retryCount: 0,
    lastError: null,
    lastErrorAt: null,
    failedAt: null,
  });
}

/**
 * NOVO — Inicializa uma nova sessão com state machine completa.
 * Chamado quando startSession() cria uma nova sessão.
 * 
 * @param {string} uid
 * @param {object} data — dados iniciais (socket, socketInstanceId, etc.)
 */
function initializeSession(uid, data = {}) {
  const now = Date.now();
  return set(uid, {
    uid,
    sessionId: uid,
    state: 'connecting',
    status: 'connecting', // compatibilidade
    phone: null,
    qr: null,
    qrGeneratedAt: null,
    connectedAt: null,
    createdAt: now,
    retryCount: 0,
    maxRetries: DEFAULT_MAX_RETRIES,
    lastError: null,
    lastErrorAt: null,
    failedAt: null,
    stateChangedAt: now,
    ...data,
  });
}

/**
 * NOVO — Gera log estruturado para uma sessão.
 * Formato: [Manager][uid][state] mensagem {dados}
 * 
 * @param {string} uid
 * @returns {object} { prefix, state, retryCount, ... }
 */
function getStructuredLog(uid) {
  const sess = get(uid);
  if (!sess) {
    return {
      prefix: `[Manager][${uid}][no-session]`,
      state: 'none',
      retryCount: 0,
    };
  }
  return {
    prefix: `[Manager][${uid}][${sess.state}]`,
    state: sess.state,
    retryCount: sess.retryCount || 0,
    maxRetries: sess.maxRetries || DEFAULT_MAX_RETRIES,
    phone: sess.phone || null,
    hasQr: !!sess.qr,
    socketInstanceId: sess.socketInstanceId || null,
  };
}

module.exports = {
  set,
  get,
  remove,
  has,
  allUids,
  countByState,
  countByStatus,
  setState,
  // CAMADA 1.1 — State Machine
  canStartNewConnection,
  setFailed,
  canReconnect,
  incrementRetry,
  resetRetry,
  initializeSession,
  getStructuredLog,
  // Constantes
  VALID_STATES,
  DEFAULT_MAX_RETRIES,
  WATCHDOG_CONNECTING_TIMEOUT_MS,
};
