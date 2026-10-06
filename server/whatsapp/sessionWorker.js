/* ══════════════════════════════════════════════════════════════════════
   whatsapp/sessionWorker.js — Worker de sessões WhatsApp
   ────────────────────────────────────────────────────────────────────
   Cada worker é um processo Node.js independente que gere até
   SESSIONS_PER_WORKER sessões Baileys simultâneas.

   Comunicação com o processo pai (workerPool.js) via IPC (process.send /
   process.on('message')). Nenhum estado partilhado em memória entre
   workers — toda a coordenação passa pelo Firestore ou IPC.

   Mensagens que o worker recebe do pai (process.on('message')):
     { type: 'INIT',       db: <config>, workerId }
     { type: 'CONNECT',    uid, slot }
     { type: 'DISCONNECT', uid, slot }
     { type: 'SEND',       uid, slot, phone, text }
     { type: 'STATUS',     uid, slot, replyId }
     { type: 'QR',         uid, slot, replyId }
     { type: 'SHUTDOWN' }

   Mensagens que o worker envia ao pai (process.send):
     { type: 'READY',    workerId }
     { type: 'INCOMING', uid, slot, message }
     { type: 'REPLY',    replyId, data }
     { type: 'ERROR',    uid, slot, error }
     { type: 'STATUS_UPDATE', uid, slot, status, phone }
   ══════════════════════════════════════════════════════════════════════ */

'use strict';

const path    = require('path');
const fs      = require('fs');

// Importar manager existente — cada worker tem a sua própria instância
// em memória, isolada dos outros workers
const manager = require('./manager');

let _workerId  = null;
let _db        = null;
let _admin     = null;

// ── Inicialização ────────────────────────────────────────────────────

async function _init(config) {
  _workerId = config.workerId;

  try {
    _admin = require('firebase-admin');

    // Inicializar Firebase com nome único por worker para evitar conflito
    // de apps quando múltiplos workers correm no mesmo processo (em testes)
    const appName = `worker-${_workerId}`;
    const existing = _admin.apps.find(a => a.name === appName);

    if (!existing) {
      if (config.serviceAccount) {
        _admin.initializeApp({
          credential: _admin.credential.cert(config.serviceAccount),
        }, appName);
      } else if (config.projectId) {
        _admin.initializeApp({
          credential: _admin.credential.cert({
            projectId:   config.projectId,
            clientEmail: config.clientEmail,
            privateKey:  config.privateKey,
          }),
        }, appName);
      }
    }

    const app = _admin.app(appName);
    _db = app.firestore();

    manager.setFirestore(_db);

    // Ligar mensagens recebidas pelo manager ao processo pai
    manager.setOnIncomingMessage(async (sessionId, message) => {
      process.send({
        type:      'INCOMING',
        sessionId,
        message,
        workerId:  _workerId,
      });
    });

    process.send({ type: 'READY', workerId: _workerId });
    console.info(`[Worker ${_workerId}] Pronto.`);

  } catch (e) {
    console.error(`[Worker ${_workerId}] Erro na inicialização:`, e.message);
    process.send({ type: 'ERROR', workerId: _workerId, error: e.message });
  }
}

// ── Handlers de mensagens IPC ────────────────────────────────────────

const _handlers = {

  async CONNECT({ uid, slot }) {
    const sessionId = `${uid}_${slot}`;
    try {
      await manager.startSession(sessionId);
      process.send({ type: 'STATUS_UPDATE', uid, slot, status: 'connecting', workerId: _workerId });
    } catch (e) {
      console.error(`[Worker ${_workerId}] CONNECT erro ${sessionId}:`, e.message);
      process.send({ type: 'ERROR', uid, slot, error: e.message, workerId: _workerId });
    }
  },

  async DISCONNECT({ uid, slot }) {
    const sessionId = `${uid}_${slot}`;
    try {
      await manager.closeSession(sessionId, true);
      process.send({ type: 'STATUS_UPDATE', uid, slot, status: 'disconnected', workerId: _workerId });
    } catch (e) {
      console.error(`[Worker ${_workerId}] DISCONNECT erro ${sessionId}:`, e.message);
      process.send({ type: 'ERROR', uid, slot, error: e.message, workerId: _workerId });
    }
  },

  async SEND({ uid, slot, phone, text, replyId }) {
    const sessionId = `${uid}_${slot}`;
    try {
      await manager.sendMessage(sessionId, phone, text);
      if (replyId) process.send({ type: 'REPLY', replyId, data: { ok: true }, workerId: _workerId });
    } catch (e) {
      console.error(`[Worker ${_workerId}] SEND erro ${sessionId}:`, e.message);
      if (replyId) process.send({ type: 'REPLY', replyId, data: { ok: false, error: e.message }, workerId: _workerId });
    }
  },

  async PRESENCE({ uid, slot, phone, state }) {
    const sessionId = `${uid}_${slot}`;
    try {
      await manager.sendPresence(sessionId, phone, state);
    } catch (e) {
      // Indicador de presença não é crítico — falhar aqui não deve gerar
      // ERROR para o pai nem afectar o fluxo do delay executor.
      console.warn(`[Worker ${_workerId}] PRESENCE erro ${sessionId}:`, e.message);
    }
  },

  STATUS({ uid, slot, replyId }) {
    const sessionId = `${uid}_${slot}`;
    // [INSTRUMENTAÇÃO QR] Request STATUS recebido do frontend
    console.log(`[STATUS REQUEST] uid: ${uid}, slot: ${slot}, timestamp: ${Date.now()}`);
    const info = manager.getStatus(sessionId);
    // [INSTRUMENTAÇÃO QR] Response STATUS sendo enviado
    console.log(`[STATUS RESPONSE] uid: ${uid}, slot: ${slot}, status: ${info.status}, hasQR: ${!!info.qr}, timestamp: ${Date.now()}`);
    process.send({ type: 'REPLY', replyId, data: { ok: true, ...info, qr: undefined }, workerId: _workerId });
  },

  QR({ uid, slot, replyId }) {
    const sessionId = `${uid}_${slot}`;
    // [INSTRUMENTAÇÃO QR] Request QR recebido do frontend
    console.log(`[QR REQUEST FRONTEND] uid: ${uid}, slot: ${slot}, timestamp: ${Date.now()}`);
    const info = manager.getStatus(sessionId);
    // [INSTRUMENTAÇÃO QR] QR sendo enviado para o frontend
    console.log(`[ENVIO QR FRONTEND] uid: ${uid}, slot: ${slot}, qrExiste: ${!!info.qr}, timestamp: ${Date.now()}`);
    // [DIAGNÓSTICO QR] Verificar estado antes de montar resposta HTTP
    console.log(`[QR STORAGE BEFORE RESPONSE] uid: ${uid}, slot: ${slot}, qrExiste: ${!!info.qr}, tamanhoQR: ${info.qr ? info.qr.length : 0}, status: ${info.status}, timestamp: ${Date.now()}`);
    process.send({ type: 'REPLY', replyId, data: {
      ok: true, uid, slot,
      status:        info.status,
      qr:            info.qr || null,
      qrGeneratedAt: info.qrGeneratedAt || null,
    }, workerId: _workerId });
  },

  SHUTDOWN() {
    console.info(`[Worker ${_workerId}] A encerrar…`);
    process.exit(0);
  },
};

// ── Loop de mensagens IPC ────────────────────────────────────────────

process.on('message', async (msg) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'INIT') {
    await _init(msg);
    return;
  }

  const handler = _handlers[msg.type];
  if (handler) {
    // BUGFIX: nem todo handler é assíncrono (STATUS, QR e SHUTDOWN são
    // funções normais que devolvem undefined). `handler(msg).catch(...)`
    // assumia sempre uma Promise — em handlers síncronos isto rebentava
    // com "Cannot read properties of undefined (reading 'catch')" em
    // TODA chamada de STATUS/QR (ou seja, em todo polling do frontend
    // enquanto espera o QR Code ser escaneado). Envolver em
    // Promise.resolve() torna seguro chamar .catch() independentemente
    // do handler ser síncrono ou assíncrono.
    await Promise.resolve(handler(msg)).catch(e => {
      console.error(`[Worker ${_workerId}] Handler ${msg.type} erro:`, e.message);
    });
  } else {
    console.warn(`[Worker ${_workerId}] Tipo de mensagem desconhecido: ${msg.type}`);
  }
});

// ── Processo pai morreu / canal IPC caiu ──────────────────────────────
// Se o workerPool (processo pai) morrer por qualquer motivo (crash não
// relacionado às sessões WhatsApp, ex.: erro no arranque do servidor),
// o Node emite 'disconnect' neste processo assim que o canal IPC cai.
// Sem este handler, o worker ficava órfão e o socket Baileys interno
// continuava a tentar emitir eventos via process.send(), que falha
// repetidamente com "Channel closed" — gerando o mesmo spam infinito
// mas por uma causa totalmente diferente da reconexão de sessão.
// Antes (sintoma observado): pai crasha → workers ficam órfãos →
// "Channel closed" / "write EPIPE" sem parar, até o circuit-breaker
// abaixo reiniciar o worker — que volta a ficar órfão, porque o pai
// continua morto. Sair imediato aqui evita esse ciclo.
process.on('disconnect', () => {
  console.error(`[Worker ${_workerId}] Canal IPC com o processo pai caiu (pai provavelmente morreu) — a encerrar.`);
  process.exit(1);
});

// ── Erros não capturados — circuit breaker ────────────────────────────
// Antes: apanhava o erro e seguia em frente sem nunca terminar o
// processo. Quando o canal Baileys de uma sessão fica preso num estado
// irrecuperável ("Channel closed"), o socket interno emite esse erro
// repetidamente fora do listener 'connection.update' (por isso o guard
// de socketInstanceId em manager.js não o trava), gerando um spam
// infinito de "uncaught exception" — exactamente o que aparece ao correr
// `npm start`.
//
// Agora: contamos quantas exceções caem num curto espaço de tempo. Se
// ultrapassar o limite, assumimos que o worker está preso num loop
// irrecuperável e terminamos o processo de forma limpa — o workerPool
// (processo pai) deteta a saída e relança um worker novo, limpo.
const _EXC_WINDOW_MS   = 10_000; // janela de 10s
const _EXC_MAX_IN_WINDOW = 15;   // mais de 15 exceções em 10s = loop preso
let _excTimestamps = [];

function _handleFatalLoop(label, e) {
  console.error(`[Worker ${_workerId}] ${label}:`, e?.message || e);
  process.send?.({ type: 'ERROR', error: e?.message || String(e), workerId: _workerId });

  const now = Date.now();
  _excTimestamps.push(now);
  _excTimestamps = _excTimestamps.filter(t => now - t <= _EXC_WINDOW_MS);

  if (_excTimestamps.length > _EXC_MAX_IN_WINDOW) {
    console.error(`[Worker ${_workerId}] ${_excTimestamps.length} exceções em ${_EXC_WINDOW_MS}ms — worker preso em loop irrecuperável. A reiniciar processo.`);
    process.send?.({ type: 'ERROR', error: 'worker_stuck_loop_restarting', workerId: _workerId });
    // Sair com código != 0 para o workerPool saber que foi um crash e
    // relançar um worker novo (não um SHUTDOWN intencional).
    process.exit(1);
  }
}

process.on('uncaughtException', (e) => _handleFatalLoop('uncaughtException', e));
process.on('unhandledRejection', (reason) => _handleFatalLoop('unhandledRejection', reason));
