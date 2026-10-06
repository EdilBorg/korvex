/* ══════════════════════════════════════════════════════════════════════
   FASE 5 — executors/delay.js
   ────────────────────────────────────────────────────────────────────
   Executor do bloco DELAY (Atraso Inteligente).

   Comportamento:
     1. Cancela qualquer delay activo para este uid+phone (evita
        execuções paralelas quando chega nova mensagem durante delay).
     2. Calcula executeAt = now + duração configurada no nó.
     3. Persiste em Firestore: workspaces/{uid}/pendingDelays/{id}
        { uid, phone, flowId, nodeId, nextNodeId, executeAt, createdAt }
     4. Agenda setTimeout para executar na hora certa.
     5. Devolve { isDelay: true } — o motor para aqui.
     6. Quando o timeout dispara: apaga o doc Firestore, chama
        workflowEngine._resumeFromDelay() para continuar o fluxo.

   Se o servidor reiniciar durante o delay:
     server/index.js lê todos os pendingDelays do Firestore no boot
     e reagenda cada um com o tempo restante real (executeAt - now).

   Logs: [DELAY] Agendado | [DELAY] Executado | [DELAY] Cancelado | [DELAY] Reagendado após restart
   ══════════════════════════════════════════════════════════════════════ */

const logger = require('../logger');
const graph  = require('../graph');

let _db              = null;
let _resumeFromDelay = null; // injectado por setResumeCallback()

function setFirestore(db) { _db = db; }

/**
 * Injectado por workflowEngine.js após init().
 * Evita dependência circular (delay.js → workflowEngine.js → delay.js).
 */
function setResumeCallback(fn) { _resumeFromDelay = fn; }

// Injectado por workflowEngine.js após init()
let _sendPresenceFn = null;
function setSendPresence(fn) { _sendPresenceFn = fn; }

// ── Mapa de timers activos em memória ────────────────────────────────
// Chave: `${uid}__${safePhone}` → Array de { timerId, delayId }
// Permite cancelar todos os delays de um contacto quando chega nova
// mensagem (evita execuções duplicadas de fluxos em paralelo).
/** @type {Map<string, Array<{timerId: NodeJS.Timeout, delayId: string}>>} */
const _activeTimers = new Map();

function _timerKey(uid, phone) {
  return `${uid}__${String(phone).replace(/\//g, '_')}`;
}

/**
 * Regista um timer activo para um uid+phone.
 */
function _registerTimer(uid, phone, timerId, delayId) {
  const key = _timerKey(uid, phone);
  if (!_activeTimers.has(key)) _activeTimers.set(key, []);
  _activeTimers.get(key).push({ timerId, delayId });
}

/**
 * Remove um timer da lista activa (chamado quando o timer dispara
 * normalmente, para não acumular entradas obsoletas no mapa).
 */
function _unregisterTimer(uid, phone, delayId) {
  const key = _timerKey(uid, phone);
  const timers = _activeTimers.get(key);
  if (!timers) return;
  const idx = timers.findIndex(t => t.delayId === delayId);
  if (idx !== -1) timers.splice(idx, 1);
  if (timers.length === 0) _activeTimers.delete(key);
}

/**
 * Cancela todos os delays activos em memória para um uid+phone.
 * Remove também os respectivos documentos do Firestore.
 * Chamado pelo workflowEngine quando chega uma nova mensagem enquanto
 * há um delay pendente para esse contacto.
 * @param {string} uid
 * @param {string} phone
 */
async function cancelPendingDelays(uid, phone) {
  const key = _timerKey(uid, phone);
  const timers = _activeTimers.get(key);
  if (!timers || timers.length === 0) return;

  // Copiar antes de limpar para não iterar sobre array mutável
  const toCancel = [...timers];
  _activeTimers.delete(key);

  for (const { timerId, delayId } of toCancel) {
    clearTimeout(timerId);
    if (_db) {
      try {
        await _db.collection('workspaces').doc(uid)
                 .collection('pendingDelays').doc(delayId).delete();
      } catch (e) {
        // Não bloquear — o timer já foi cancelado em memória
      }
    }
    logger.info(uid, phone, `[DELAY] Cancelado — id: ${delayId}`);
  }
}

// ── Conversão de unidade → milissegundos ─────────────────────────────
const UNIT_MS = {
  'Segundos': 1000,
  'Minutos':  60 * 1000,
  'Horas':    60 * 60 * 1000,
  'Dias':     24 * 60 * 60 * 1000,
};

function _toMs(amount, unit) {
  const multiplier = UNIT_MS[unit] || UNIT_MS['Segundos'];
  return Math.max(500, Number(amount) * multiplier); // mínimo 0.5s
}

// ── ID único por delay ────────────────────────────────────────────────
function _delayId(uid, phone) {
  const safePhone = String(phone).replace(/\//g, '_').replace(/[^a-zA-Z0-9_\-+@.]/g, '');
  return `${uid}_${safePhone}_${Date.now()}`;
}

// ── Referência Firestore ──────────────────────────────────────────────
function _delayRef(uid, delayId) {
  if (!_db) return null;
  return _db.collection('workspaces').doc(uid)
            .collection('pendingDelays').doc(delayId);
}

/**
 * Executor principal — chamado pelo workflowEngine quando encontra um nó delay.
 */
async function execute(ctx) {
  const { uid, phone, remoteJid, node, flow, flowId } = ctx;
  const settings = node.settings || {};

  // Leitura do tempo: suporta nó standalone e sub-item de bloco composto
  // O frontend guarda a unidade em "_unit" (com underscore) via FlowSerializer
  // que faz n.data → node.settings. Aceitar ambas as formas por segurança.
  let amount, unit;
  if (Array.isArray(settings._items) && settings._items.length) {
    const item = settings._items.find(it => it.type === 'delay') || settings._items[0];
    amount = Number(item.data?.secs)  || Number(settings.secs)  || 3;
    unit   = item.data?._unit || item.data?.unit || settings._unit || settings.unit || 'Segundos';
  } else {
    amount = Number(settings.secs)  || Number(node.data?.secs)  || 3;
    unit   = settings._unit || settings.unit || node.data?._unit || 'Segundos';
  }
  logger.info(uid, phone, `[DELAY] Configuração lida — secs: ${amount} | unit: ${unit} | settings raw: ${JSON.stringify(settings)}`);
  const ms     = _toMs(amount, unit);
  const executeAt = Date.now() + ms;

  // Pré-calcular o próximo nó para não precisar do flowDoc no callback
  const nextNode = graph.getNextNode(node.nodeId, flow);
  const nextNodeId = nextNode ? String(nextNode.nodeId) : null;

  const delayId = _delayId(uid, phone);

  // Persistir no Firestore
  if (_db) {
    try {
      await _delayRef(uid, delayId).set({
        uid,
        phone,
        remoteJid:   remoteJid || null,
        flowId:      flowId || null,
        nodeId:      String(node.nodeId),
        nextNodeId,
        executeAt,
        createdAt:   Date.now(),
      });
    } catch (e) {
      logger.error(uid, phone, `[DELAY] Erro ao persistir delay ${delayId}: ${e.message}`);
      // Continuar mesmo sem persistência — o timeout em memória ainda funciona
    }
  }

  logger.info(uid, phone,
    `[DELAY] Agendado — id: ${delayId} | duração: ${amount} ${unit} (${ms}ms) | executeAt: ${new Date(executeAt).toISOString()}`);

  // Agendar execução
  _scheduleDelay({ uid, phone, remoteJid: remoteJid || null, flowId, nextNodeId, executeAt, delayId });

  return { isDelay: true };
}

/**
 * Agenda (ou reagenda) um delay via setTimeout.
 * Usado tanto no execute() normal como na recuperação após restart.
 */
function _scheduleDelay({ uid, phone, remoteJid, flowId, nextNodeId, executeAt, delayId, isRecovery = false }) {
  const remaining = Math.max(0, executeAt - Date.now());

  if (isRecovery) {
    logger.info(uid, phone,
      `[DELAY] Reagendado após restart — id: ${delayId} | tempo restante: ${Math.round(remaining / 1000)}s`);
  }

  // Activar indicador "a digitar" durante o delay e renovar a cada 25s
  let _typingInterval = null;
  const _tPresence0 = Date.now();
  logger.info(uid, phone, `[SEQ][A] _scheduleDelay iniciado | remoteJid=${remoteJid} | remaining=${remaining}ms | t=${_tPresence0}`);
  logger.info(uid, phone, `[SEQ][B] _sendPresenceFn disponivel: ${!!_sendPresenceFn}`);
  if (_sendPresenceFn) {
    const presenceTarget = remoteJid || phone;
    logger.info(uid, phone, `[SEQ][C] A chamar composing | target=${presenceTarget} | t=${Date.now()}`);
    _sendPresenceFn(uid, presenceTarget, 'composing')
      .then(() => logger.info(uid, phone, `[SEQ][D] composing RETORNOU | duração=${Date.now()-_tPresence0}ms | t=${Date.now()}`))
      .catch(e => logger.error(uid, phone, `[SEQ][D] composing ERRO: ${e.message}`));
    logger.info(uid, phone, `[SEQ][E] setTimeout agendado para daqui a ${remaining}ms | mensagem será enviada em t=${Date.now()+remaining}`);
    _typingInterval = setInterval(() => {
      logger.info(uid, phone, `[SEQ][RENEW] Renovando composing | t=${Date.now()}`);
      _sendPresenceFn(uid, presenceTarget, 'composing').catch(e =>
        logger.error(uid, phone, `[SEQ][RENEW] ERRO renovar composing: ${e.message}`));
    }, 25000);
  } else {
    logger.warn(uid, phone, '[SEQ][B] _sendPresenceFn NULL — typing nao sera enviado!');
  }

  const timerId = setTimeout(async () => {
    const _tTimeout = Date.now();
    logger.info(uid, phone, `[SEQ][F] setTimeout disparou | t=${_tTimeout} | elapsed desde composing=${_tTimeout - _tPresence0}ms`);

    // Parar o intervalo de "a digitar"
    if (_typingInterval) clearInterval(_typingInterval);

    // Remover da lista de activos antes de executar
    _unregisterTimer(uid, phone, delayId);

    // Parar indicador "a digitar"
    if (_sendPresenceFn) {
      logger.info(uid, phone, `[SEQ][G] A enviar paused | target=${remoteJid || phone} | t=${Date.now()}`);
      _sendPresenceFn(uid, remoteJid || phone, 'paused').catch(() => {});
    }

    logger.info(uid, phone, `[DELAY] Executado — id: ${delayId} | nextNodeId: ${nextNodeId || 'nenhum'}`);

    // Apagar do Firestore
    if (_db) {
      try {
        await _delayRef(uid, delayId).delete();
      } catch (e) {
        logger.error(uid, phone, `[DELAY] Erro ao apagar delay ${delayId}: ${e.message}`);
      }
    }

    // Retomar fluxo
    if (nextNodeId && _resumeFromDelay) {
      try {
        await _resumeFromDelay(uid, phone, flowId, nextNodeId, remoteJid);
      } catch (e) {
        logger.error(uid, phone, `[DELAY] Erro ao retomar fluxo após delay: ${e.message}`);
      }
    } else {
      logger.info(uid, phone, `[DELAY] Sem nó seguinte após delay — fluxo terminou aqui.`);
    }
  }, remaining);

  // Registar no mapa de activos
  _registerTimer(uid, phone, timerId, delayId);
}

/**
 * Chamado por server/index.js no arranque do servidor.
 * Lê todos os pendingDelays do Firestore e reagenda os que ainda não executaram.
 */
async function recoverPendingDelays(db, resumeCallback) {
  if (!db) return;

  _db = db;
  _resumeFromDelay = resumeCallback;

  try {
    // Iterar todos os workspaces com pendingDelays
    // Estrutura: workspaces/{uid}/pendingDelays/{delayId}
    const workspacesSnap = await db.collection('workspaces').get();
    let total = 0;

    for (const wsDoc of workspacesSnap.docs) {
      const uid = wsDoc.id;
      const delaysSnap = await db.collection('workspaces').doc(uid)
                                 .collection('pendingDelays').get();

      for (const delayDoc of delaysSnap.docs) {
        const data = delayDoc.data();
        total++;

        if (!data.phone || !data.executeAt) {
          // Doc corrompido — apagar
          await delayDoc.ref.delete().catch(() => {});
          continue;
        }

        _scheduleDelay({
          uid,
          phone:       data.phone,
          remoteJid:   data.remoteJid || null,
          flowId:      data.flowId,
          nextNodeId:  data.nextNodeId,
          executeAt:   data.executeAt,
          delayId:     delayDoc.id,
          isRecovery:  true,
        });
      }
    }

    if (total > 0) {
      console.info(`[DELAY] ${total} delay(s) pendente(s) reagendado(s) após restart.`);
    }
  } catch (e) {
    console.error('[DELAY] Erro ao recuperar delays pendentes:', e.message);
  }
}

/**
 * Verifica se há algum delay activo em memória para um uid+phone.
 * Usado pelo workflowEngine para ignorar mensagens durante um delay activo.
 */
function hasActiveDeley(uid, phone) {
  const key = _timerKey(uid, phone);
  const timers = _activeTimers.get(key);
  return !!(timers && timers.length > 0);
}

/** Permite que composite.js aceda à função de presença sem dependência circular. */
function _getSendPresence() { return _sendPresenceFn; }

module.exports = { execute, setFirestore, setResumeCallback, setSendPresence, _getSendPresence, recoverPendingDelays, cancelPendingDelays, hasActiveDeley };
