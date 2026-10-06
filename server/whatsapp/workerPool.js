/* ══════════════════════════════════════════════════════════════════════
   whatsapp/workerPool.js — Pool de workers de sessões WhatsApp
   ────────────────────────────────────────────────────────────────────
   Gere N processos filho (sessionWorker.js), cada um a gerir até
   SESSIONS_PER_WORKER sessões Baileys simultâneas.

   DISTRIBUIÇÃO DE SESSÕES:
   - Cada uid+slot é atribuído a um worker de forma determinística:
       workerIndex = hash(uid) % numWorkers
   - Isto garante que a mesma sessão vai sempre para o mesmo worker,
     evitando conflitos de estado
   - Com 4 workers de 250 sessões = suporte para 1000 sessões simultâneas

   RESTART AUTOMÁTICO:
   - Se um worker crashar, é reiniciado automaticamente em 3s
   - As sessões desse worker são recuperadas do Firestore pelo authStore
   - O backoff exponencial do manager.js evita crash loops

   COMUNICAÇÃO:
   - Pedidos síncronos (STATUS, QR, SEND): Promise com timeout de 10s
   - Pedidos assíncronos (CONNECT, DISCONNECT): fire-and-forget
   - Eventos (INCOMING, STATUS_UPDATE): callbacks registados

   CONFIGURAÇÃO via variáveis de ambiente:
     WORKER_COUNT          — número de workers (padrão: 2)
     SESSIONS_PER_WORKER   — sessões máx por worker (padrão: 250)
   ══════════════════════════════════════════════════════════════════════ */

'use strict';

const { fork }  = require('child_process');
const path      = require('path');
const crypto    = require('crypto');

const WORKER_SCRIPT      = path.join(__dirname, 'sessionWorker.js');
const WORKER_COUNT       = parseInt(process.env.WORKER_COUNT       || '2', 10);
const SESSIONS_PER_WORKER = parseInt(process.env.SESSIONS_PER_WORKER || '250', 10);
const REPLY_TIMEOUT_MS   = 10000; // 10s para respostas síncronas
const WORKER_RESTART_MS  = 3000;  // delay antes de reiniciar worker crashado

// ── Estado do pool ───────────────────────────────────────────────────

const _workers    = new Map(); // workerId → { process, ready, sessions: Set }
const _pendingReplies = new Map(); // replyId → { resolve, reject, timer }
let   _onIncoming = null;     // callback(sessionId, message)
let   _dbConfig   = null;     // config Firebase para passar aos workers
let   _started    = false;

// ── Hash determinístico uid → workerIndex ────────────────────────────

function _workerIndexFor(uid) {
  const hash = crypto.createHash('md5').update(uid).digest('hex');
  return parseInt(hash.slice(0, 8), 16) % WORKER_COUNT;
}

function _workerIdFor(uid) {
  return `w${_workerIndexFor(uid)}`;
}

// ── Iniciar um worker ────────────────────────────────────────────────

function _spawnWorker(workerId) {
  console.info(`[WorkerPool] A iniciar worker ${workerId}…`);

  const proc = fork(WORKER_SCRIPT, [], {
    silent: false, // herdar stdout/stderr do pai para logs unificados
    env: { ...process.env },
  });

  const worker = {
    process:  proc,
    ready:    false,
    sessions: new Set(),
    workerId,
  };

  _workers.set(workerId, worker);

  // Enviar configuração Firebase ao worker logo após fork
  proc.send({ type: 'INIT', workerId, ..._dbConfig });

  // ── Mensagens do worker ──────────────────────────────────────────
  proc.on('message', (msg) => {
    if (!msg || !msg.type) return;

    switch (msg.type) {

      case 'READY':
        worker.ready = true;
        console.info(`[WorkerPool] Worker ${workerId} pronto.`);
        break;

      case 'INCOMING':
        // Mensagem recebida do WhatsApp — encaminhar ao workflowEngine
        if (_onIncoming) {
          _onIncoming(msg.sessionId, msg.message).catch(e => {
            console.error(`[WorkerPool] Erro ao processar mensagem incoming:`, e.message);
          });
        }
        break;

      case 'STATUS_UPDATE':
        // Worker reporta mudança de estado de uma sessão
        console.info(`[WorkerPool] Status update — uid: ${msg.uid} | slot: ${msg.slot} | status: ${msg.status}`);
        break;

      case 'REPLY':
        // Resposta a um pedido síncrono (STATUS, QR, SEND)
        _resolveReply(msg.replyId, msg.data);
        break;

      case 'ERROR':
        console.error(`[WorkerPool] Erro do worker ${workerId}:`, msg.error);
        if (msg.replyId) _rejectReply(msg.replyId, new Error(msg.error));
        break;

      default:
        break;
    }
  });

  // ── Restart automático se o worker crashar ───────────────────────
  proc.on('exit', (code, signal) => {
    console.warn(`[WorkerPool] Worker ${workerId} terminou (code: ${code}, signal: ${signal}). A reiniciar em ${WORKER_RESTART_MS}ms…`);
    _workers.delete(workerId);

    // Rejeitar todos os pedidos pendentes deste worker
    for (const [replyId, pending] of _pendingReplies) {
      _rejectReply(replyId, new Error(`Worker ${workerId} crashou`));
    }

    setTimeout(() => {
      if (_started) _spawnWorker(workerId);
    }, WORKER_RESTART_MS);
  });

  proc.on('error', (e) => {
    console.error(`[WorkerPool] Erro no processo do worker ${workerId}:`, e.message);
  });

  return worker;
}

// ── Resolver/rejeitar pedidos síncronos ─────────────────────────────

function _resolveReply(replyId, data) {
  const pending = _pendingReplies.get(replyId);
  if (!pending) return;
  clearTimeout(pending.timer);
  _pendingReplies.delete(replyId);
  pending.resolve(data);
}

function _rejectReply(replyId, err) {
  const pending = _pendingReplies.get(replyId);
  if (!pending) return;
  clearTimeout(pending.timer);
  _pendingReplies.delete(replyId);
  pending.reject(err);
}

function _sendAndWait(workerId, msg) {
  return new Promise((resolve, reject) => {
    const replyId = crypto.randomUUID();
    const worker  = _workers.get(workerId);

    if (!worker || !worker.ready) {
      return reject(new Error(`Worker ${workerId} não está disponível`));
    }

    const timer = setTimeout(() => {
      _pendingReplies.delete(replyId);
      reject(new Error(`Timeout aguardando resposta do worker ${workerId}`));
    }, REPLY_TIMEOUT_MS);

    _pendingReplies.set(replyId, { resolve, reject, timer });
    worker.process.send({ ...msg, replyId });
  });
}

function _send(workerId, msg) {
  const worker = _workers.get(workerId);
  if (!worker || !worker.ready) {
    console.warn(`[WorkerPool] Worker ${workerId} não disponível para mensagem ${msg.type}`);
    return;
  }
  worker.process.send(msg);
}

// ══════════════════════════════════════════════════════════════════════
// API PÚBLICA — compatível com manager.js existente
// O server/index.js passa a usar workerPool em vez de manager directamente
// ══════════════════════════════════════════════════════════════════════

/**
 * Inicializar o pool com a configuração Firebase.
 * Deve ser chamado uma vez no arranque do servidor.
 */
function init(dbConfig, onIncomingMessage) {
  if (_started) return;
  _started    = true;
  _dbConfig   = dbConfig;
  _onIncoming = onIncomingMessage;

  console.info(`[WorkerPool] A iniciar ${WORKER_COUNT} workers (${SESSIONS_PER_WORKER} sessões/worker = ${WORKER_COUNT * SESSIONS_PER_WORKER} total)…`);

  for (let i = 0; i < WORKER_COUNT; i++) {
    _spawnWorker(`w${i}`);
  }
}

/**
 * Iniciar sessão WhatsApp para um utilizador num determinado slot.
 */
async function startSession(uid, slot = 'whatsapp_1') {
  const workerId = _workerIdFor(uid);
  _send(workerId, { type: 'CONNECT', uid, slot });
}

/**
 * Encerrar sessão WhatsApp.
 */
async function closeSession(uid, slot = 'whatsapp_1') {
  const workerId = _workerIdFor(uid);
  _send(workerId, { type: 'DISCONNECT', uid, slot });
}

/**
 * Enviar mensagem de texto via WhatsApp.
 */
async function sendMessage(sessionId, phone, text) {
  // sessionId = "uid_slot" ou apenas "uid" (legado)
  let uid  = sessionId;
  let slot = 'whatsapp_1';
  const m  = sessionId.match(/^(.+)_(whatsapp_[12])$/);
  if (m) { uid = m[1]; slot = m[2]; }

  const workerId = _workerIdFor(uid);
  return _sendAndWait(workerId, { type: 'SEND', uid, slot, phone, text });
}

/**
 * Obter estado actual de uma sessão.
 */
async function getStatus(sessionId) {
  let uid  = sessionId;
  let slot = 'whatsapp_1';
  const m  = sessionId.match(/^(.+)_(whatsapp_[12])$/);
  if (m) { uid = m[1]; slot = m[2]; }

  const workerId = _workerIdFor(uid);
  try {
    return await _sendAndWait(workerId, { type: 'STATUS', uid, slot });
  } catch {
    return { status: 'disconnected', qr: null, phone: null };
  }
}

/**
 * Obter QR Code actual de uma sessão.
 */
async function getQr(uid, slot = 'whatsapp_1') {
  const workerId = _workerIdFor(uid);
  try {
    return await _sendAndWait(workerId, { type: 'QR', uid, slot });
  } catch {
    return { ok: false, status: 'disconnected', qr: null };
  }
}

/**
 * Encerrar todos os workers de forma limpa (para graceful shutdown).
 */
function shutdown() {
  _started = false;
  for (const [id, worker] of _workers) {
    try { worker.process.send({ type: 'SHUTDOWN' }); } catch {}
  }
}

/**
 * Devolver informação sobre o estado do pool (para /health).
 */
function getPoolStatus() {
  const workers = [];
  for (const [id, w] of _workers) {
    workers.push({
      workerId:      id,
      ready:         w.ready,
      pid:           w.process.pid,
      sessionCount:  w.sessions.size,
    });
  }
  return {
    workerCount:       WORKER_COUNT,
    sessionsPerWorker: SESSIONS_PER_WORKER,
    maxSessions:       WORKER_COUNT * SESSIONS_PER_WORKER,
    workers,
  };
}

/**
 * Enviar indicador de presença (a digitar.../pausado) via WhatsApp.
 * Espelha sendMessage — a sessão real vive no worker subprocess, nunca
 * no processo principal, por isso isto tem de passar pelo workerPool
 * em vez de chamar manager.js directamente (que não tem sockets activos
 * fora do worker).
 */
async function sendPresence(sessionId, phone, state) {
  let uid  = sessionId;
  let slot = 'whatsapp_1';
  const m  = sessionId.match(/^(.+)_(whatsapp_[12])$/);
  if (m) { uid = m[1]; slot = m[2]; }

  const workerId = _workerIdFor(uid);
  // Fire-and-forget — indicador de presença não é crítico o suficiente
  // para justificar esperar por reply síncrono (REPLY_TIMEOUT_MS=10s
  // atrasaria o delay executor desnecessariamente).
  _send(workerId, { type: 'PRESENCE', uid, slot, phone, state });
}

module.exports = {
  init,
  startSession,
  closeSession,
  sendMessage,
  getStatus,
  getQr,
  shutdown,
  getPoolStatus,
};
