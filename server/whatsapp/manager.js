/* ══════════════════════════════════════════════════════════════════════
   FASE 4.1C — manager.js (+ motor de execução de fluxos)
   ────────────────────────────────────────────────────────────────────
   Gestor de sessões WhatsApp via Baileys.

   Responsabilidades:
   • Iniciar sessão (gerar QR Code)
   • Monitorizar estado da ligação
   • Fechar sessão
   • Sincronizar estado com Firestore (workspaces/{uid}/connections/whatsapp)
   • Preparado para múltiplos utilizadores (mapa uid → socket)
   • Auto-expirar sessões "connecting" presas (timeout de segurança —
     defesa em profundidade, complementar ao timeout do frontend)
   • Resolver a versão do protocolo Baileys com timeout próprio, para
     nunca bloquear a geração do QR por causa de rede externa lenta
   • Garantir handshake limpo (sem credenciais antigas) em cada pedido
     de ligação do utilizador, e impedir sessões concorrentes para o
     mesmo uid (reconexões automáticas vs. pedidos manuais)
   • FASE 3.2 — Receber mensagens (messages.upsert) e delegar ao motor
     de fluxos (server/engine/workflowEngine.js) via callback injectado;
     enviar mensagens de resposta (sendMessage)

   Nada do comportamento de conexão/QR/disconnect documentado acima foi
   alterado nesta fase — apenas adicionado o necessário para mensagens.
   ══════════════════════════════════════════════════════════════════════ */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');

const pino   = require('pino');
const path   = require('path');
const fs     = require('fs');
const sessions      = require('./sessions');
// CAMADA 1.1: Importar funções de State Machine
const { 
  canStartNewConnection, setFailed, canReconnect, 
  incrementRetry, resetRetry, initializeSession,
  getStructuredLog, WATCHDOG_CONNECTING_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES
} = require('./sessions');
const { useFirestoreAuthState } = require('./authStore');
const qrUtil   = require('./qr');

// Suprimir logs verbosos do Baileys em produção
const _logger = pino({ level: 'silent' });

// ── LID Map — resolução @lid → número real ───────────────────────────
// O WhatsApp introduziu o sistema de privacidade LID (Linked ID), onde
// mensagens de alguns utilizadores chegam com JID do tipo
// "1234567890123456789@lid" em vez de "258841234567@s.whatsapp.net".
// O Baileys expõe o evento contacts.update que, em alguns casos, mapeia
// um LID para o número real. Este Map guarda esses mapeamentos por uid.
//
// Estrutura: Map< uid, Map< lid_string, phone_string > >
//   lid_string : "1234567890123456789@lid"  (chave tal como vem do Baileys)
//   phone_string: "+258841234567"            (número normalizado, pronto para uso)
//
// Limitação conhecida: o Baileys não garante que contacts.update entregue
// SEMPRE o mapeamento antes da primeira mensagem @lid chegar. Quando o
// número não for resolvível, a mensagem é descartada e registado um aviso
// — nunca é gravado o próprio LID como número de telefone.
/** @type {Map<string, Map<string, string>>} */
const _lidMaps = new Map();

// ── Fila de mensagens LID pendentes ─────────────────────────────────
// Quando uma mensagem chega via @lid sem senderPn e sem entrada no lidMap,
// guardamos a mensagem + uid + raw_m aqui por até LID_PENDING_TTL_MS.
// Quando o contacts.update/upsert resolver o LID, despachamos as mensagens
// pendentes em vez de as perder para sempre.
// Estrutura: Map< lid_string, [{uid, m, socketInstanceId, addedAt}] >
/** @type {Map<string, Array<{uid: string, m: object, instanceId: number, addedAt: number}>>} */
const _lidPendingMessages = new Map();
const LID_PENDING_TTL_MS = 10000; // 10s — suficiente para contacts.update chegar

function _enqueueLidMessage(lid, uid, m, instanceId) {
  if (!_lidPendingMessages.has(lid)) _lidPendingMessages.set(lid, []);
  const queue = _lidPendingMessages.get(lid);
  // Evitar duplicados pelo ID da mensagem
  const msgId = m.key?.id;
  if (msgId && queue.some(e => e.m.key?.id === msgId)) return;
  queue.push({ uid, m, instanceId, addedAt: Date.now() });
  // Auto-limpar mensagens expiradas depois do TTL
  setTimeout(() => {
    const q = _lidPendingMessages.get(lid);
    if (q) {
      const fresh = q.filter(e => Date.now() - e.addedAt < LID_PENDING_TTL_MS);
      if (fresh.length === 0) _lidPendingMessages.delete(lid);
      else _lidPendingMessages.set(lid, fresh);
    }
  }, LID_PENDING_TTL_MS + 100);
}

async function _flushLidQueue(lid, phone) {
  const queue = _lidPendingMessages.get(lid);
  if (!queue || queue.length === 0) return;
  _lidPendingMessages.delete(lid);
  for (const entry of queue) {
    if (Date.now() - entry.addedAt > LID_PENDING_TTL_MS) continue;
    try {
      const text  = _extractText(entry.m.message);
      const media = text == null ? _extractMedia(entry.m.message) : null;
      if (text == null && media == null) continue;
      const timestamp = (entry.m.messageTimestamp ? Number(entry.m.messageTimestamp) : Math.floor(Date.now() / 1000)) * 1000;
      const pushName  = entry.m.pushName || null;
      if (_onIncomingMessage) {
        if (media) {
          await _onIncomingMessage(entry.uid, { phone, timestamp, pushName, text: media.caption, type: media.type, mediaUrl: null, mediaMime: media.mediaMime });
        } else {
          await _onIncomingMessage(entry.uid, { phone, text, timestamp, pushName, type: 'text' });
        }
        console.info(`[Manager][LID] Mensagem retida despachada: LID=${lid} PHONE=${phone} (uid: ${entry.uid})`);
      }
    } catch (e) {
      console.error('[Manager][LID] Erro ao despachar mensagem retida:', e.message);
    }
  }
}


// Directório onde as credenciais de autenticação ficam guardadas
// (uma pasta por utilizador: auth/{uid}/)
const AUTH_BASE = path.join(__dirname, '..', 'auth');

// Timeout de segurança no backend (defesa em profundidade).
// O frontend já expira o estado "connecting" aos 60s, mas se a aba
// fechar ou perder ligação, o backend garante que a sessão não fica
// presa indefinidamente em memória.
const CONNECT_TIMEOUT_MS = 70000; // 70s (um pouco acima do timeout do frontend)

// Referência ao Firestore (injectada via init)
let _db = null;

// ── Contador de instâncias de socket ─────────────────────────────────
// Cada chamada a startSession() gera um socketInstanceId único e
// incremental. Este id é gravado em sessions junto com o socket, e
// capturado em closure por todos os handlers do Baileys (connection.update,
// messages.upsert, contacts.update). Antes de qualquer efeito colateral
// (alterar sessions, Firestore, ou agendar reconexão), o handler verifica
// se o seu socketInstanceId ainda corresponde ao registado em sessions.
// Se não corresponder, o socket é antigo ("ghost") e o evento é ignorado.
let _socketInstanceCounter = 0;

// FASE 3.2.1 — callback injectado pelo motor de fluxos (workflowEngine.js)
// para processar mensagens recebidas. Mantido como variável de módulo,
// no mesmo padrão já usado para _db, para não alterar a assinatura de
// startSession() nem de mais nenhuma função já existente.
let _onIncomingMessage = null;

/**
 * Regista a função a chamar sempre que uma mensagem de texto chega de
 * qualquer sessão activa. Chamado uma vez a partir de server/index.js.
 * @param {(uid: string, message: {phone: string, text: string, timestamp: number}) => Promise<void>} fn
 */
function setOnIncomingMessage(fn) {
  _onIncomingMessage = fn;
}

/**
 * Extrai o texto simples de um objecto de mensagem Baileys, cobrindo os
 * formatos mais comuns enviados por clientes WhatsApp. Devolve null para
 * tipos de mensagem fora do âmbito desta fase (imagem, áudio, vídeo,
 * documento, localização, etc.) — o motor ignora-os silenciosamente.
 * @param {object} message  m.message do evento messages.upsert
 * @returns {string|null}
 */

// CAMADA 1.1 — Log Estruturado Obrigatório
/**
 * Regista eventos críticos da sessão em formato JSON estruturado.
 * Facilita agregação e debugging em produção.
 * 
 * @param {string} component 
 * @param {string} level — 'info'|'warn'|'error'
 * @param {string} uid 
 * @param {string} message 
 * @param {object} extra — dados adicionais
 */
function _logStructured(component, level, uid, message, extra = {}) {
  const sess = sessions.get(uid);
  const log = {
    timestamp: Date.now(),
    level,
    component,
    uid,
    slot: uid.includes('_') ? uid.split('_')[1] : 'unknown',
    state: sess?.state || 'none',
    retryCount: sess?.retryCount || 0,
    errorCode: extra.errorCode || null,
    message,
    ...extra,
  };
  
  if (level === 'error') {
    console.error(`[${component}] ${JSON.stringify(log)}`);
  } else if (level === 'warn') {
    console.warn(`[${component}] ${JSON.stringify(log)}`);
  } else {
    console.info(`[${component}] ${JSON.stringify(log)}`);
  }
}

function _extractText(message) {
  if (!message) return null;
  if (typeof message.conversation === 'string') return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.buttonsResponseMessage?.selectedDisplayText) return message.buttonsResponseMessage.selectedDisplayText;
  if (message.listResponseMessage?.title) return message.listResponseMessage.title;
  return null;
}

/**
 * FASE 4.0 — Detecta se a mensagem é de mídia (imagem/vídeo/áudio/
 * documento), para a Inbox poder registá-la mesmo quando o motor de
 * fluxos a ignora (ver _extractText, que continua só a reconhecer
 * texto — este bloco NÃO altera esse comportamento).
 *
 * Korvex ainda não faz download/hospedagem dos ficheiros de mídia
 * recebidos (fora do âmbito desta fase); por isso mediaUrl fica null
 * por agora — a estrutura já fica pronta para quando essa parte for
 * implementada, sem precisar de migração de dados.
 * @param {object} message  m.message do evento messages.upsert
 * @returns {{type: string, mediaMime: string|null, caption: string|null}|null}
 */
function _extractMedia(message) {
  if (!message) return null;
  if (message.imageMessage) {
    return { type: 'image', mediaMime: message.imageMessage.mimetype || 'image/jpeg', caption: message.imageMessage.caption || null };
  }
  if (message.videoMessage) {
    return { type: 'video', mediaMime: message.videoMessage.mimetype || 'video/mp4', caption: message.videoMessage.caption || null };
  }
  if (message.audioMessage) {
    return { type: 'audio', mediaMime: message.audioMessage.mimetype || 'audio/mpeg', caption: null };
  }
  if (message.documentMessage) {
    return { type: 'document', mediaMime: message.documentMessage.mimetype || 'application/octet-stream', caption: message.documentMessage.caption || message.documentMessage.fileName || null };
  }
  return null;
}

/**
 * Injectar instância do Firestore Admin.
 * Chamado em server/index.js após inicializar o Firebase Admin.
 * @param {import('firebase-admin').firestore.Firestore} db
 */
function setFirestore(db) {
  _db = db;
}

// ── Resolver uid/slot + referência Firestore a partir do sessionId ────
// ÚNICO ponto do manager que faz a distinção uid vs sessionId. Todo o
// resto do ficheiro (sessions Map, locks, timers, reconnect, sockets,
// authStore, etc.) continua a operar exclusivamente sobre sessionId,
// exactamente como antes — esta função não muda isso, apenas corrige
// o caminho gravado no Firestore.
//
// Formato exigido: "{uid}_{slot}", slot ∈ {whatsapp_1, whatsapp_2} — é o
// único formato que server/index.js e sessionWorker.js alguma vez
// constroem antes de chamar o manager. Não há fallback para um formato
// legado sem slot: se chegar aqui algo fora desse formato, é um bug
// noutro ponto da cadeia de chamada e deve falhar alto, não ser mascarado
// com um valor por omissão.
//
// @param {string} sessionId
// @returns {{ uid: string, slot: string, ref: FirebaseFirestore.DocumentReference|null }}
function resolveWorkspaceRef(sessionId) {
  const match = typeof sessionId === 'string'
    ? sessionId.match(/^(.+)_(whatsapp_[12])$/)
    : null;

  if (!match) {
    throw new Error(`[Manager] resolveWorkspaceRef: sessionId com formato inválido: ${JSON.stringify(sessionId)} (esperado "{uid}_{slot}", slot ∈ {whatsapp_1, whatsapp_2})`);
  }

  const [, uid, slot] = match;

  const ref = _db
    ? _db.collection('workspaces').doc(uid).collection('connections').doc(slot)
    : null;

  return { uid, slot, ref };
}

// ── Escrever estado no Firestore ────────────────────────────────────
async function _syncFirestore(sessionId, patch) {
  try {
    const { ref } = resolveWorkspaceRef(sessionId);
    if (!ref) return;
    await withTimeout(ref.set({ ...patch, updatedAt: Date.now() }, { merge: true }), 10000, `_syncFirestore(${sessionId})`);
  } catch (e) {
    console.error('[Manager] Firestore sync error:', e.message);
  }
}

// ══════════════════════════════════════════════════════════════════════
// _resolveBaileysVersion — versão do protocolo WhatsApp Web com timeout
// ══════════════════════════════════════════════════════════════════════

// Versão fixa de fallback, conhecida por funcionar com @whiskeysockets/baileys
// ^6.7.9. Usada apenas se o pedido de rede a fetchLatestBaileysVersion()
// falhar ou demorar mais que BAILEYS_VERSION_TIMEOUT_MS. Actualizar
// ocasionalmente se o WhatsApp deixar de aceitar versões muito antigas.
const FALLBACK_BAILEYS_VERSION = [2, 3000, 1015901307];
const BAILEYS_VERSION_TIMEOUT_MS = 8000; // 8s

/**
 * Obtém a versão do protocolo a usar no socket Baileys, sem nunca
 * bloquear a criação da sessão por mais de BAILEYS_VERSION_TIMEOUT_MS.
 * @returns {Promise<number[]>}
 */
async function _resolveBaileysVersion() {
  try {
    const result = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout ao obter versão Baileys')), BAILEYS_VERSION_TIMEOUT_MS)
      ),
    ]);
    return result.version;
  } catch (e) {
    console.warn(`[Manager] Não foi possível obter a versão mais recente do Baileys (${e.message}). A usar versão de fallback.`);
    return FALLBACK_BAILEYS_VERSION;
  }
}

// ══════════════════════════════════════════════════════════════════════
// startSession(uid) — iniciar sessão WhatsApp para um utilizador
// ══════════════════════════════════════════════════════════════════════

// ── Lock de concorrência por uid ────────────────────────────────────
// PROBLEMA: startSession() é assíncrona e faz vários `await` (fechar
// sessão anterior, ler/gravar auth no Firestore ou disco, resolver a
// versão do Baileys via rede) antes de registar a nova sessão em
// `sessions`. Se startSession(uid) for chamada uma segunda vez antes da
// primeira terminar — HTTP "Conectar", reconexão automática (linha
// startSession(uid,{fresh:false}) no handler de connection.update),
// "Atualizar QR", retry do frontend, etc. — as duas execuções corriam
// em paralelo, cada uma criava o seu próprio makeWASocket(), e só a
// última a chamar sessions.set(uid, …) "vencia": o socket da outra
// ficava órfão (ghost), sem nunca ser fechado, continuando ligado ao
// WhatsApp e a consumir recursos/eventos em paralelo com o socket
// "oficial".
//
// SOLUÇÃO: um mapa uid → Promise da execução em curso. Uma segunda
// chamada para o mesmo uid, enquanto a primeira ainda não terminou,
// NÃO executa o corpo de startSession outra vez (logo não cria outro
// socket) — recebe de volta a mesma Promise já em curso e resolve/rejeita
// junto com ela. Só depois de a execução em curso terminar (com sucesso
// ou com erro) é que uma nova chamada para esse uid arranca uma execução
// nova. O `finally` garante que o lock é sempre libertado, mesmo que o
// corpo lance uma excepção — não há caminho que deixe o uid preso.
/** @type {Map<string, Promise<void>>} */
const _startSessionLocks = new Map();

// ── Função utilitária: withTimeout ──────────────────────────────────
// Envolve uma Promise com um timeout. Se a Promise não completar dentro
// de `ms` milissegundos, lança erro de timeout.
//
// CARACTERÍSTICAS:
// - Se Promise resolve: devolve exatamente o resultado
// - Se Promise rejeita: propaga exatamente o erro original
// - Se timeout expira: lança erro de timeout
// - Sempre cancela o setTimeout para evitar memory leak
//
// Uso:
//   await withTimeout(firestore.ref.set(data), 10000, 'Firestore write');
function withTimeout(promise, ms, operationName = 'Operation') {
  let timeoutHandle;

  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        console.error(`[Timeout] ${operationName} após ${ms}ms`);
        reject(new Error(`${operationName} timeout após ${ms}ms`));
      }, ms);
    })
  ]).finally(() => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  });
}

/**
 * Inicia (ou reinicia) uma sessão WhatsApp para o utilizador.
 * Devolve imediatamente; o QR Code fica disponível em sessions.get(uid).qr
 * quando o evento 'connection.update' o emite.
 *
 * Garante, para cada uid, no máximo UMA execução em curso de
 * startSession() em simultâneo — ver `_startSessionLocks` acima.
 *
 * @param {string} uid  Firebase UID do utilizador
 * @param {object} [opts]
 * @param {boolean} [opts.fresh=true]  Se true (padrão), apaga quaisquer
 *   credenciais antigas em disco antes de iniciar. Isto garante um
 *   handshake limpo sempre que o utilizador pede uma ligação nova
 *   (botão "Conectar" ou "Atualizar QR"). Passar `false` apenas nas
 *   reconexões automáticas internas, onde queremos reaproveitar a
 *   sessão já autenticada.
 * @returns {Promise<void>}
 */
function startSession(uid, opts = {}) {
  // Já existe uma execução de startSession em curso para este uid —
  // devolver essa mesma Promise em vez de iniciar outra ligação/socket
  // concorrente. Quem chamou esta segunda vez fica "à boleia" do
  // resultado da execução já em curso.
  const inFlight = _startSessionLocks.get(uid);
  if (inFlight) {
    console.warn(`[Manager] startSession(${uid}) ignorado — já existe uma execução em curso para este uid.`);
    return inFlight;
  }

  const execution = _startSessionInternal(uid, opts).finally(() => {
    // Só remover o lock se ainda for o desta execução (protecção
    // adicional, embora não devesse poder ser substituído enquanto
    // está em _startSessionLocks — ver comentário acima).
    if (_startSessionLocks.get(uid) === execution) {
      _startSessionLocks.delete(uid);
    }
  });

  _startSessionLocks.set(uid, execution);
  return execution;
}

/**
 * Corpo real de startSession() — só deve ser chamado a partir do
 * wrapper startSession(), nunca directamente, para preservar a garantia
 * de exclusão mútua por uid.
 * @param {string} uid
 * @param {object} opts
 * @returns {Promise<void>}
 */
async function _startSessionInternal(uid, opts = {}) {
  const startSessionEnterTime = Date.now();
  const instanceBefore = sessions.get(uid)?.socketInstanceId ?? 'none';
  const existingWorker = sessions.get(uid)?.worker ?? null;
  
  // Capturar stack para ver quem chamou
  const stack = new Error().stack.split('\n').slice(1, 4).join(' | ');
  
  console.log(`
[START SESSION ENTER]
┌─ timestamp: ${startSessionEnterTime}
├─ uid: ${uid}
├─ slot: ${uid.includes('_') ? uid.split('_')[1] : 'whatsapp_1'}
├─ instanceExistente: ${instanceBefore}
├─ worker: ${existingWorker ? 'sim' : 'não'}
├─ fresh: ${opts.fresh}
├─ quemChamou: ${stack}
└─ parâmetrosRecebidos: ${JSON.stringify(opts)}
  `);

  const { fresh = true } = opts;

  // Cancelar qualquer reconexão automática que ainda esteja agendada
  // para este uid (evita duas sessões Baileys concorrentes — uma a
  // gerar QR novo, outra "fantasma" prestes a arrancar sozinha).
  
  // CAMADA 1.1 — Verificar se é seguro iniciar nova conexão
  if (!canStartNewConnection(uid)) {
    const sess = sessions.get(uid);
    
    // [START SESSION LOCK CHECK]
    console.log(`
[START SESSION LOCK CHECK]
┌─ timestamp: ${Date.now()}
├─ uid: ${uid}
├─ existeIsStarting: ${sess?.isStarting ? 'sim' : 'não'}
├─ existeConnecting: ${sess?.connecting ? 'sim' : 'não'}
├─ existePending: ${sess?.pending ? 'sim' : 'não'}
├─ existeInitializing: ${sess?.initializing ? 'sim' : 'não'}
├─ existeMutex: ${sess?.mutex ? 'sim' : 'não'}
├─ existePromiseEmExecucao: ${sess?.promiseRunning ? 'sim' : 'não'}
├─ state: ${sess?.state}
└─ motivoDoBloqueio: session_em_estado_${sess?.state}
    `);
    
    // [START SESSION BLOCKED]
    console.log(`[START SESSION BLOCKED] uid: ${uid}, bloqueadoPor: ${sess?.state}, timestamp: ${Date.now()}`);
    
    _logStructured('Manager', 'warn', uid,
      'Tentativa de iniciar nova conexão bloqueada — sessão já em estado ativo',
      { currentState: sess?.state });
    throw new Error(`Impossível iniciar nova conexão — sessão em estado: ${sess?.state}`);
  }

  // CORREÇÃO CRÍTICA: ORDEM DO LIFECYCLE
  // ════════════════════════════════════════════════════════════════════
  // ANTES (BUG - race condition):
  //   1. initializeSession() → cria sessão
  //   2. if (sessions.has(uid)) → destrói IMEDIATAMENTE
  //   Isto faz perder o QR code
  //
  // DEPOIS (CORREÇÃO):
  //   1. Verificar se sessão antiga existe
  //   2. SE EXISTIR: closeSession() completo
  //   3. DEPOIS: initializeSession() nova
  // ════════════════════════════════════════════════════════════════════

  _cancelPendingReconnect(uid);

  // PASSO 1: Verificar se existe sessão antiga (ANTES de criar a nova)
  const hasExistingSession = sessions.has(uid);

  if (hasExistingSession) {
    // [START SESSION -> DESTROY]
    const destroyStartTime = Date.now();
    const destroyBefore = sessions.get(uid)?.state ?? 'unknown';
    
    console.log(`
[START SESSION -> DESTROY]
┌─ timestamp: ${destroyStartTime}
├─ uid: ${uid}
├─ motivo: fechar_sessao_existente_antes_de_iniciar_nova
├─ estadoAntes: ${destroyBefore}
└─ clearAuth: false
    `);
    
    // PASSO 2: AGUARDAR completamente o encerramento da sessão antiga
    // Garantir que:
    //   - socket antigo foi fechado
    //   - listeners antigos terminaram
    //   - sessão foi removida
    await closeSession(uid, false); // false = não apagar auth files
    
    // [DESTROY FINISHED]
    const destroyEndTime = Date.now();
    const destroyDuration = destroyEndTime - destroyStartTime;
    const destroyAfter = sessions.get(uid)?.state ?? 'removed';
    
    console.log(`
[DESTROY FINISHED]
┌─ timestamp: ${destroyEndTime}
├─ uid: ${uid}
├─ tempoGasto: ${destroyDuration}ms
├─ estadoAntes: ${destroyBefore}
├─ estadoDepois: ${destroyAfter}
├─ sessaoRemovida: ${!sessions.has(uid) ? 'sim' : 'não'}
├─ authRemovida: não
└─ pronto_para_nova_sessao: sim
    `);
  }

  // PASSO 3: SÓ AGORA criar a nova sessão (depois de destruir completamente a antiga)
  const sessionMapBefore = sessions.has(uid);
  
  // [CREATE SESSION OBJECT]
  console.log(`
[CREATE SESSION OBJECT]
┌─ timestamp: ${Date.now()}
├─ uid: ${uid}
├─ slot: ${uid.includes('_') ? uid.split('_')[1] : 'whatsapp_1'}
├─ worker: null
├─ sessionMapAntes: ${sessionMapBefore ? 'sim' : 'não'}
├─ hadExistingSessionBefore: ${hasExistingSession ? 'sim' : 'não'}
└─ ação: vai_criar_sessao_com_state_connecting
  `);
  
  initializeSession(uid, { state: 'connecting', maxRetries: DEFAULT_MAX_RETRIES });
  
  const sessionMapAfter = sessions.has(uid);
  const createdSession = sessions.get(uid);
  
  console.log(`
[CREATE SESSION OBJECT DONE]
┌─ uid: ${uid}
├─ sessionMapDepois: ${sessionMapAfter ? 'sim' : 'não'}
├─ state: ${createdSession?.state}
├─ socketInstanceId: ${createdSession?.socketInstanceId ?? 'none'}
└─ createdAt: ${createdSession?.createdAt}
  `);
  
  _logStructured('Manager', 'info', uid, 'Iniciando nova sessão WhatsApp', { fresh });

  // FASE 3.1.3 — BUGFIX: credenciais antigas em auth/{uid}/ (de uma
  // tentativa anterior que falhou, ou de um servidor reiniciado entre
  // testes) faziam o Baileys tentar retomar uma sessão já inválida do
  // lado do WhatsApp. O resultado era um fecho quase imediato com
  // código 401 (logout) — por vezes antes do QR sequer chegar a ser
  // entregue ao frontend, por vezes logo a seguir, fazendo o QR
  // "aparecer" nos logs do servidor mas nunca chegar a ser exibido a
  // tempo no browser. Começar sempre do zero numa ligação pedida pelo
  // utilizador resolve isto.
  if (fresh) {
    _clearAuthFiles(uid);
  }

  // ── Autenticação persistida no Firestore ───────────────────────────
  // Em produção: credenciais guardadas em whatsapp_auth/{uid}/ no Firestore.
  // Sobrevive a restarts do servidor e funciona com múltiplas instâncias.
  // Fallback para disco (useMultiFileAuthState) se Firestore não estiver disponível.
  let state, saveCreds, clearAuthFn;

  if (_db) {
    const authResult = await useFirestoreAuthState(_db, uid);
    state       = authResult.state;
    saveCreds   = authResult.saveCreds;
    clearAuthFn = authResult.clearAuth;
  } else {
    console.warn(`[Manager] Firestore não disponível — usando auth em disco para ${uid}`);
    const authDir = path.join(AUTH_BASE, uid);
    fs.mkdirSync(authDir, { recursive: true });
    const diskAuth = await useMultiFileAuthState(authDir);
    state       = diskAuth.state;
    saveCreds   = diskAuth.saveCreds;
    clearAuthFn = async () => {
      if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
    };
  }

  // FASE 3.1.2 — BUGFIX: fetchLatestBaileysVersion() faz um pedido de
  // rede ao GitHub para descobrir a versão mais recente do protocolo
  // WhatsApp Web. Se a máquina não tiver saída de rede para o exterior
  // (proxy, firewall, ambiente isolado) ou a ligação estiver lenta, esta
  // chamada podia ficar pendurada — a sessão nunca avançava, nenhum QR
  // era gerado, e o utilizador só via "tempo de ligação expirado" 60s
  // depois, sem qualquer pista da causa real.
  //
  // Correcção: aplicar um timeout curto (8s) a este pedido. Se falhar ou
  // demorar demais, usar uma versão fixa conhecida e compatível do
  // protocolo Baileys como fallback, e seguir em frente normalmente —
  // a versão exacta do protocolo raramente é crítica para gerar o QR.
  const version = await _resolveBaileysVersion();

  // [ABOUT TO CREATE SOCKET] — Antes de chamar makeWASocket
  const socketCreateStartTime = Date.now();
  const instanceIdAnterior = sessions.get(uid)?.socketInstanceId ?? 'none';
  
  console.log(`
[ABOUT TO CREATE SOCKET]
┌─ timestamp: ${socketCreateStartTime}
├─ uid: ${uid}
├─ slot: ${uid.includes('_') ? uid.split('_')[1] : 'whatsapp_1'}
├─ instanceIdAnterior: ${instanceIdAnterior}
├─ version: ${version}
├─ agoraVaiChamar: makeWASocket()
└─ estado: criacao_do_socket
  `);

  let sock = null;
  let socketCreateError = null;
  
  try {
    sock = makeWASocket({
      version,
      logger: _logger,
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys:  makeCacheableSignalKeyStore(state.keys, _logger),
      },
      browser: ['Korvex', 'Chrome', '1.0.0'],
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      // Necessário para que sendPresenceUpdate('composing') apareça no WhatsApp.
      // Com markOnlineOnConnect: true (default), a sessão fica sempre 'online'
      // e o WhatsApp ignora os indicadores 'a digitar'.
      markOnlineOnConnect: false,
    });
    
    // [SOCKET CREATED SUCCESS]
    const socketCreateEndTime = Date.now();
    console.log(`
[SOCKET CREATED SUCCESS]
┌─ timestamp: ${socketCreateEndTime}
├─ uid: ${uid}
├─ slot: ${uid.includes('_') ? uid.split('_')[1] : 'whatsapp_1'}
├─ socketExiste: ${!!sock}
├─ tempoGasto: ${socketCreateEndTime - socketCreateStartTime}ms
├─ version: ${version}
└─ proximoId: ${_socketInstanceCounter + 1}
    `);
  } catch (makeWASocketError) {
    // [SOCKET CREATE FAILED]
    socketCreateError = makeWASocketError;
    console.log(`
[SOCKET CREATE FAILED]
┌─ timestamp: ${Date.now()}
├─ uid: ${uid}
├─ slot: ${uid.includes('_') ? uid.split('_')[1] : 'whatsapp_1'}
├─ erro: ${socketCreateError.message}
├─ code: ${socketCreateError.code}
└─ stack: ${socketCreateError.stack}
    `);
    throw socketCreateError;
  }

  // Identificador único desta instância de socket.
  // Incrementado a cada startSession(), capturado em closure por todos
  // os handlers Baileys abaixo. Permite que qualquer handler verifique
  // se ainda é o socket autorizado antes de agir.
  const socketInstanceId = ++_socketInstanceCounter;

  // Registar sessão em memória
  sessions.set(uid, {
    socket:           sock,
    socketInstanceId, // ← id desta instância; muda a cada startSession
    status:           'connecting',
    phone:            null,
    qr:               null,
    qrGeneratedAt:    null,
    connectedAt:      null,
    createdAt:        Date.now(),
    sessionId:        uid,
  });

  // CAMADA 1.1 — Watchdog de 2 minutos para "connecting preso"
  // Se a sessão não conectar em 2 minutos, força estado FAILED
  _armWatchdogConnecting(uid);
  
  // Timeout de segurança (70s): se a sessão continuar "connecting" depois de
  // CONNECT_TIMEOUT_MS, forçar encerramento. O watchdog (2 min) também está activo.
  _armConnectTimeout(uid);

  // Actualizar Firestore: connecting
  await _syncFirestore(uid, {
    channel:   'whatsapp',
    status:    'connecting',
    phone:     null,
    sessionId: uid,
    qrGeneratedAt: null,
  });

  // ── Eventos Baileys ─────────────────────────────────────────────────
  
  // [REGISTER EVENTS]
  console.log(`
[REGISTER EVENTS]
┌─ timestamp: ${Date.now()}
├─ uid: ${uid}
├─ instanceId: ${socketInstanceId}
├─ socketExiste: ${!!sock}
├─ conexaoUpdateRegistando: aguardando_registo
├─ credsUpdateRegistando: aguardando_registo
├─ messagesUpsertRegistando: aguardando_registo
└─ estadoSocket: pronto_para_listeners
  `);

  sock.ev.on('creds.update', saveCreds);
  
  console.log(`[CREDS.UPDATE REGISTADO] uid: ${uid}, instanceId: ${socketInstanceId}, timestamp: ${Date.now()}`);

  // ══════════════════════════════════════════════════════════════════
  // FASE 3.2.1 — messages.upsert: ponte para o motor de execução de
  // fluxos (server/engine/workflowEngine.js). Apenas extrai os dados
  // (phone, text, timestamp) e delega — nenhuma lógica de fluxo aqui.
  // Não interfere em nada do fluxo de conexão/QR já existente acima.
  //
  // FASE 4.0 — ALTERAÇÃO ADITIVA: mensagens de mídia (imagem/vídeo/
  // áudio/documento), que antes eram completamente ignoradas (`continue`
  // antes mesmo de chegar a _onIncomingMessage), agora também são
  // repassadas — com text=null e type/mediaMime preenchidos — para que
  // a Inbox (observadora) as registe no histórico. O motor de fluxos
  // CONTINUA a ignorá-las exactamente como antes: handleIncoming() só
  // executa nós quando typeof text === 'string' (ver workflowEngine.js).
  // Também passamos pushName (nome do perfil WhatsApp), usado só pela
  // Inbox para o nome do contacto — o motor de fluxos não o usa.
  // ══════════════════════════════════════════════════════════════════
  sock.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
    console.log(`[LISTENER CALLED] messages.upsert - uid: ${uid}, instanceId: ${socketInstanceId}, type: ${type}, numMsgs: ${msgs?.length ?? 0}, timestamp: ${Date.now()}`);
    
    if (type !== 'notify') return; // ignorar histórico sincronizado, só mensagens novas

    // BUGFIX: ignorar eventos de sockets antigos/obsoletos (mesma guarda já
    // usada em connection.update). Sem isto, sockets "fantasma" de
    // reconexões anteriores continuam a processar e a duplicar mensagens,
    // causando "Bad MAC" (duas sessões Signal a decifrar o mesmo
    // pacote) e estados internos inconsistentes (ex.: uid.slice crash).
    const _currentEntry = sessions.get(uid);
    if (!_currentEntry || _currentEntry.socketInstanceId !== socketInstanceId) {
      console.warn(`[Manager] messages.upsert ignorado — socket obsoleto (uid: ${uid}, instância: ${socketInstanceId}, actual: ${_currentEntry?.socketInstanceId ?? 'none'})`);
      return;
    }

    for (const m of msgs) {
      try {
        if (!m.message) continue;
        if (m.key?.fromMe) continue; // ignorar mensagens enviadas pelo próprio Korvex

        const jid = m.key?.remoteJid || '';

        if (jid.endsWith('@lid')) {
        }

        // ── Filtrar JIDs não suportados ────────────────────────────────
        if (!jid) continue;
        if (jid.endsWith('@broadcast'))     continue; // listas e status
        if (jid.endsWith('@newsletter'))    continue; // canais WhatsApp

        // ── FASE 4 — Grupos (@g.us) ────────────────────────────────────
        if (jid.endsWith('@g.us')) {
          // Anti-spam: ignorar mensagens de sistema do WhatsApp
          const msgTypes = Object.keys(m.message || {});
          const isSystemMsg = msgTypes.some(t => [
            'protocolMessage','reactionMessage','pollUpdateMessage',
            'groupParticipantsUpdate','senderKeyDistributionMessage',
            'messageContextInfo',
          ].includes(t));
          if (isSystemMsg) {
            console.info(`[GROUP] Mensagem de sistema ignorada — jid: ${jid}`);
            continue;
          }

          // Anti-spam adicional: texto de sistema conhecido
          const rawTxt = _extractText(m.message) || '';
          const systemPhrases = ['entrou no grupo','saiu do grupo','alterou o assunto','alterou a foto','adicionou','removeu'];
          if (systemPhrases.some(p => rawTxt.toLowerCase().includes(p))) {
            console.info(`[GROUP] Texto de sistema ignorado — "${rawTxt.slice(0,60)}"`);
            continue;
          }

          // Resolver participante — quem enviou a mensagem dentro do grupo
          const participantJid = m.key?.participant || '';
          let participantPhone = null;

          // 1.ª tentativa: participantPn (campo directo, mais fiável)
          const rawParticipantPn = (m.key?.participantPn || '').replace('@s.whatsapp.net','').replace(/[^0-9]/g,'');
          if (rawParticipantPn && rawParticipantPn.length >= 7) {
            participantPhone = '+' + rawParticipantPn.replace(/^0+/,'');
            console.info(`[GROUP] Participante resolvido via participantPn: ${participantPhone} — grupo: ${jid}`);
          }

          // 2.ª tentativa: extrair do JID do participante directamente
          if (!participantPhone && participantJid.endsWith('@s.whatsapp.net')) {
            const digits = participantJid.replace('@s.whatsapp.net','').replace(/[^0-9]/g,'');
            if (digits && digits.length >= 7) {
              participantPhone = '+' + digits.replace(/^0+/,'');
              console.info(`[GROUP] Participante resolvido via JID: ${participantPhone} — grupo: ${jid}`);
            }
          }

          // 3.ª tentativa: lidMap (caso raro em grupos)
          if (!participantPhone && participantJid.endsWith('@lid')) {
            const lidMap = _lidMaps.get(uid);
            const resolved = lidMap ? lidMap.get(participantJid) : null;
            if (resolved) {
              participantPhone = resolved;
              console.info(`[GROUP] Participante resolvido via lidMap: ${participantPhone} — grupo: ${jid}`);
            }
          }

          console.info(`[GROUP] Grupo detectado — jid: ${jid} | participante: ${participantPhone || 'não resolvido'}`);

          const groupText  = _extractText(m.message);
          const groupMedia = groupText == null ? _extractMedia(m.message) : null;
          if (groupText == null && groupMedia == null) continue;

          const groupTimestamp = (m.messageTimestamp ? Number(m.messageTimestamp) : Math.floor(Date.now() / 1000)) * 1000;
          const groupPushName  = m.pushName || null;

          if (_onIncomingMessage) {
            const payload = groupMedia
              ? { phone: jid, timestamp: groupTimestamp, pushName: groupPushName,
                  text: groupMedia.caption, type: groupMedia.type,
                  mediaUrl: null, mediaMime: groupMedia.mediaMime,
                  isGroup: true, groupJid: jid,
                  participantPhone, participantPushName: groupPushName }
              : { phone: jid, text: groupText, timestamp: groupTimestamp,
                  pushName: groupPushName, type: 'text',
                  isGroup: true, groupJid: jid,
                  participantPhone, participantPushName: groupPushName };
            await _onIncomingMessage(uid, payload);
          }
          continue; // grupo tratado — não cai no bloco privado abaixo
        }

        // ── Resolver JID para número de telefone ───────────────────────
        let phone = null;

        if (jid.endsWith('@s.whatsapp.net')) {
          // Caso normal — JID já tem o número directamente.
          const rawDigits = jid.replace('@s.whatsapp.net', '').replace(/[^0-9]/g, '');
          if (!rawDigits) {
            console.warn(`[Manager] JID @s.whatsapp.net sem dígitos ignorado: ${jid}`);
            continue;
          }
          phone = '+' + rawDigits.replace(/^0+/, '');

        } else if (jid.endsWith('@lid')) {
          // Caso LID — resolução em duas etapas:
          // 1.ª tentativa: m.key.senderPn (campo directo do Baileys, mais fiável e imediato).
          // 2.ª tentativa: lidMap (populado por contacts.update, pode chegar depois da mensagem).
          const rawSenderPn = (m.key?.senderPn || '').replace('@s.whatsapp.net', '').replace(/[^0-9]/g, '');
          if (rawSenderPn && rawSenderPn.length >= 7) {
            phone = '+' + rawSenderPn.replace(/^0+/, '');
            console.info(`[Manager][LID] senderPn resolvido: LID=${jid} PHONE=${phone} (uid: ${uid})`);
          } else {
            // senderPn ausente — fallback: lidMap preenchido por contacts.update.
            const lidMap = _lidMaps.get(uid);
            const resolved = lidMap ? lidMap.get(jid) : null;

            if (resolved) {
              phone = resolved;
              console.info(`[Manager] LID resolvido: ${jid} → ${phone} (uid: ${uid})`);
              console.info(`[Manager][LID] Resolvido: LID=${jid} PHONE=${phone}`);
            } else {
              // LID ainda não mapeado — guardar na fila e aguardar contacts.update/upsert.
              // A mensagem será despachada quando o mapeamento chegar (até LID_PENDING_TTL_MS).
              console.warn(`[Manager] Mensagem @lid retida (uid: ${uid}): ${jid}. A aguardar mapeamento LID→número.`);
              _enqueueLidMessage(jid, uid, m, socketInstanceId);
              continue;
            }
          }

        } else {
          // Formato de JID desconhecido — ignorar.
          console.warn(`[Manager] JID com sufixo desconhecido ignorado: ${jid}`);
          continue;
        }

        // ── Validação final do número ──────────────────────────────────
        // Bloquear definitivamente contactos fantasmas (ex.: "+", "+0", etc.)
        const digits = phone.replace(/[^0-9]/g, '');
        if (!digits || digits.length < 7) {
          console.warn(`[Manager] Número inválido após resolução (uid: ${uid}): "${phone}" — descartado.`);
          continue;
        }

        const text  = _extractText(m.message);
        const media = text == null ? _extractMedia(m.message) : null;

        // Nem texto reconhecido, nem mídia reconhecida — nada a fazer.
        if (text == null && media == null) continue;

        const timestamp = (m.messageTimestamp ? Number(m.messageTimestamp) : Math.floor(Date.now() / 1000)) * 1000;
        const pushName  = m.pushName || null;

        if (_onIncomingMessage) {
          if (media) {
            await _onIncomingMessage(uid, {
              phone, remoteJid: jid, timestamp, pushName,
              text:      media.caption,
              type:      media.type,
              mediaUrl:  null,
              mediaMime: media.mediaMime,
            });
          } else {
            await _onIncomingMessage(uid, { phone, remoteJid: jid, text, timestamp, pushName, type: 'text' });
          }
        }
      } catch (e) {
        console.error('[Manager] Erro ao processar mensagem recebida:', e.message, e.stack);
      }
    }
  });
  
  console.log(`[MESSAGES.UPSERT REGISTADO] uid: ${uid}, instanceId: ${socketInstanceId}, timestamp: ${Date.now()}`);

  // ── Inicializar lidMap para este uid ─────────────────────────────────
  if (!_lidMaps.has(uid)) {
    _lidMaps.set(uid, new Map());
  }
  
  console.log(`[CONTACTS.UPSERT AGUARDANDO REGISTO] uid: ${uid}, instanceId: ${socketInstanceId}, timestamp: ${Date.now()}`);

  sock.ev.on('contacts.upsert', (contacts) => {
    console.log(`[LISTENER CALLED] contacts.upsert - uid: ${uid}, instanceId: ${socketInstanceId}, numContacts: ${contacts?.length ?? 0}, timestamp: ${Date.now()}`);
    
    // BUGFIX: mesma guarda de instância usada em connection.update e
    // messages.upsert — sem isto, um socket antigo ainda vivo também
    // popula o lidMap e despacha a fila LID, duplicando trabalho.
    const _ce1 = sessions.get(uid);
    if (!_ce1 || _ce1.socketInstanceId !== socketInstanceId) return;

    const lidMap = _lidMaps.get(uid);
    if (!lidMap) return;

    for (const contact of (contacts || [])) {
      try {
        const contactJid = contact.id || '';
        const contactLid = contact.lid || '';

        // Caso mais comum: contact.id = "258841234567@s.whatsapp.net" + contact.lid = "123456@lid"
        if (contactJid.endsWith('@s.whatsapp.net') && contactLid) {
          const rawDigits = contactJid.replace('@s.whatsapp.net', '').replace(/[^0-9]/g, '');
          if (rawDigits && rawDigits.length >= 7) {
            const phone = '+' + rawDigits.replace(/^0+/, '');
            const lid = contactLid.endsWith('@lid') ? contactLid : `${contactLid}@lid`;
            lidMap.set(lid, phone);
            console.info(`[Manager][LID] contacts.upsert mapeado: LID=${lid} PHONE=${phone} (uid: ${uid})`);
            // Despachar mensagens retidas para este LID
            _flushLidQueue(lid, phone).catch(e =>
              console.error('[Manager][LID] Erro ao despachar fila LID após contacts.upsert:', e.message)
            );
          }
        }
      } catch (e) {
        console.error('[Manager] Erro ao processar contacts.upsert:', e.message);
      }
    }
  });


  sock.ev.on('messaging-history.set', (data) => {
  });
  
  console.log(`[MESSAGING-HISTORY.SET REGISTADO] uid: ${uid}, instanceId: ${socketInstanceId}, timestamp: ${Date.now()}`);

  // ── contacts.update — preencher lidMap com mapeamentos LID → número ──
  // O Baileys emite este evento quando recebe informações sobre contactos,
  // incluindo — em alguns casos — a associação entre um LID e o número de
  // telefone real. Nem todos os contactos têm LID; e nem todos os LIDs são
  // resolvidos por este evento (limitação do protocolo WhatsApp Web).
  sock.ev.on('contacts.update', (contacts) => {
    console.log(`[LISTENER CALLED] contacts.update - uid: ${uid}, instanceId: ${socketInstanceId}, timestamp: ${Date.now()}`);
    
    // BUGFIX: mesma guarda de instância — ver comentário em contacts.upsert.
    const _ce2 = sessions.get(uid);
    if (!_ce2 || _ce2.socketInstanceId !== socketInstanceId) return;

    const lidMap = _lidMaps.get(uid);
    if (!lidMap) return;

    for (const contact of (contacts || [])) {
      console.dir(contact, { depth: 10 });
      try {
        // contact.id pode ser @s.whatsapp.net ou @lid.
        // contact.lid (se presente) é o LID associado ao número.
        // Queremos construir: lid → phone (número normalizado).

        const contactJid = contact.id || '';
        const contactLid = contact.lid || '';

        let phone = null;
        let lid   = null;

        if (contactJid.endsWith('@s.whatsapp.net') && contactLid) {
          // Temos número real + LID associado — o caso mais útil.
          const rawDigits = contactJid.replace('@s.whatsapp.net', '').replace(/[^0-9]/g, '');
          if (rawDigits && rawDigits.length >= 7) {
            phone = '+' + rawDigits.replace(/^0+/, '');
            // lid pode vir como "1234567890@lid" ou só o número "1234567890"
            lid = contactLid.endsWith('@lid') ? contactLid : `${contactLid}@lid`;
          }
        } else if (contactJid.endsWith('@lid')) {
          // contact.id é o LID. O Baileys 6.7.x coloca o número real em contact.phoneNumber
          // (formato "258841234567@s.whatsapp.net"). Ler esse campo e popular o lidMap.
          lid = contactJid;
          const rawPn = (contact.phoneNumber || '').replace('@s.whatsapp.net', '').replace(/\D/g, '');
          if (rawPn && rawPn.length >= 7) {
            phone = '+' + rawPn.replace(/^0+/, '');
            console.info(`[Manager][LID] Mapeado: LID=${lid} PHONE=${phone} (uid: ${uid})`);
          } else {
            // phoneNumber ausente ou inválido — aviso mantido para diagnóstico.
            console.warn(`[Manager] contacts.update: LID ${lid} sem número associado (uid: ${uid}) — não resolvível ainda.`);
          }
        }

        if (lid && phone) {
          lidMap.set(lid, phone);
          // Despachar mensagens retidas para este LID
          _flushLidQueue(lid, phone).catch(e =>
            console.error('[Manager][LID] Erro ao despachar fila LID após contacts.update:', e.message)
          );
        }
      } catch (e) {
        console.error('[Manager] Erro ao processar contacts.update:', e.message);
      }
    }
  });

  sock.ev.on('connection.update', async update => {
    console.log(`[LISTENER CALLED] connection.update - uid: ${uid}, instanceId: ${socketInstanceId}, timestamp: ${Date.now()}`);
    
    // [INSTRUMENTAÇÃO QR] Evento connection.update recebido
    const { connection, lastDisconnect, qr, receivedPendingNotifications } = update;
    
    // [BAILEYS UPDATE] — Evento connection.update
    console.log(`
[BAILEYS UPDATE]
┌─ timestamp: ${Date.now()}
├─ uid: ${uid}
├─ slot: ${uid.includes('_') ? uid.split('_')[1] : 'whatsapp_1'}
├─ instanceId: ${socketInstanceId}
├─ connection: ${connection}
├─ qrExiste: ${!!qr}
├─ lastDisconnect: ${!!lastDisconnect}
├─ receivedPendingNotifications: ${!!receivedPendingNotifications}
└─ updateKeys: ${Object.keys(update).join(', ')}
    `);
    
    console.log(`[BAILEYS UPDATE] uid: ${uid}, instanceId: ${socketInstanceId}, connection: ${connection}, hasQR: ${!!qr}, timestamp: ${Date.now()}`);

    // ── Guarda de autoridade de socket ───────────────────────────────
    // Verifica se este socket ainda é o socket autorizado para este uid.
    // Se não for (uid foi substituído por startSession mais recente, ou
    // closeSession já limpou a sessão), ignorar completamente o evento.
    // Isto elimina a classe de bugs "ghost socket": sockets antigos que
    // ainda emitem eventos (ex.: connection.update 'close' disparado por
    // sock.end() dentro de closeSession) não conseguem alterar sessions,
    // Firestore, nem agendar reconexões.
    const _currentSession = sessions.get(uid);
    if (!_currentSession || _currentSession.socketInstanceId !== socketInstanceId) {
      console.info(`[Manager] connection.update ignorado — socket obsoleto (uid: ${uid}, instância: ${socketInstanceId}, actual: ${_currentSession?.socketInstanceId ?? 'none'})`);
      return;
    }

    // ── QR Code recebido ──────────────────────────────────────────────
    if (qr) {
      // [QR RECEIVED] — QR recebido do Baileys
      const qrOriginalSize = qr.length;
      console.log(`
[QR RECEIVED]
┌─ timestamp: ${Date.now()}
├─ uid: ${uid}
├─ slot: ${uid}
├─ instanceId: ${socketInstanceId}
├─ tamanhoQROriginal: ${qrOriginalSize} bytes
└─ tipo: Buffer
      `);

      // [INSTRUMENTAÇÃO QR] QR recebido do Baileys
      console.log(`[QR RECEBIDO PELO MANAGER] uid: ${uid}, instanceId: ${socketInstanceId}, tamanho QR: ${qr.length} bytes, timestamp: ${Date.now()}`);
      try {
        const qrDataURI = await qrUtil.toDataURI(qr);
        const now = Date.now();
        
        // [QR STORED] — QR guardado em memória
        console.log(`
[QR STORED]
┌─ timestamp: ${now}
├─ uid: ${uid}
├─ slot: ${uid}
├─ instanceId: ${socketInstanceId}
├─ qrExiste: true
├─ tamanhoBase64: ${qrDataURI.length} bytes
├─ estado: connecting
└─ armazenamento: sessions_map
        `);
        
        sessions.set(uid, {
          ...sessions.get(uid),
          qr:            qrDataURI,
          qrGeneratedAt: now,
          status:        'connecting',
        });
        // [DIAGNÓSTICO QR] Verificar estado do armazenamento logo após guardar
        const storedSession = sessions.get(uid);
        console.log(`[QR STORAGE AFTER RECEIVE] uid: ${uid}, slot: ${uid.includes('_') ? uid.split('_')[1] : 'whatsapp_1'}, instanceId: ${socketInstanceId}, qrExiste: ${!!storedSession.qr}, tamanhoQR: ${storedSession.qr ? storedSession.qr.length : 0}, status: ${storedSession.status}, timestamp: ${Date.now()}`);
        
        await _syncFirestore(uid, {
          status:        'connecting',
          qrGeneratedAt: now,
          sessionId:     uid,
        });
        _logStructured('Manager', 'info', uid, 'QR Code gerado', {
          qrGeneratedAt: now,
          sessionState: 'connecting',
        });
      } catch (e) {
        console.error('[Manager] Erro ao gerar QR:', e.message);
      }
    }

    // ── Ligação aberta (QR lido com sucesso) ──────────────────────────
    // CAMADA 1.1 — Resetar retry após conexão bem-sucedida
    if (connection === 'open') {
      _clearConnectTimeout(uid);
      _clearWatchdogConnecting(uid); // NOVO: cancelar watchdog

      const jid   = sock.user?.id || '';
      // Normalizar número: 258841234567@s.whatsapp.net → +258841234567
      const phone = jid
        ? '+' + jid.split(':')[0].replace(/[^0-9]/g, '').replace(/^0+/, '')
        : null;
      const now   = Date.now();

      // CAMADA 1.1 — Resetar contador de retry após sucesso
      resetRetry(uid);

      sessions.set(uid, {
        ...sessions.get(uid),
        state:       'connected',  // NOVO
        status:      'connected',  // compatibilidade
        phone,
        qr:          null,   // limpar QR após conexão
        connectedAt: now,
      });

      await _syncFirestore(uid, {
        status:      'connected',
        phone,
        connectedAt: now,
        sessionId:   uid,
        qrGeneratedAt: null,
      });

      // Resetar contador de backoff (compatibilidade com código antigo)
      _reconnectAttempts.delete(uid);
      
      _logStructured('Manager', 'info', uid, 'WhatsApp conectado com sucesso', {
        phone,
        retryCount: 0,
      });

      // Marcar sessao como "available" para que composing/paused funcionem.
      // Sem isto o Baileys ignora o sendPresenceUpdate silenciosamente.
      try { await withTimeout(sock.sendPresenceUpdate('available'), 5000, 'sock.sendPresenceUpdate'); } catch (_) {}
    }

    // ── Ligação fechada ───────────────────────────────────────────────
    // CAMADA 1.1 — Tratamento melhorado com State Machine
    if (connection === 'close') {
      _clearConnectTimeout(uid);
      _clearWatchdogConnecting(uid); // NOVO: cancelar watchdog

      const code   = lastDisconnect?.error?.output?.statusCode;
      const reason = DisconnectReason;
      const errorMessage = lastDisconnect?.error?.message || 'Desconexão sem mensagem';

      // 401 = Logout pelo telemóvel → não reconectar, apagar auth
      const loggedOut = code === reason.loggedOut;
      
      // CAMADA 1.1 — Tratamento especial para erro 408 (timeout)
      const isTimeout408 = code === 408;

      _logStructured('Manager', 'info', uid, 'Ligação fechada', {
        errorCode: code,
        errorMessage,
        loggedOut,
        isTimeout408,
      });

      // Marcar como disconnected
      sessions.set(uid, {
        ...sessions.get(uid),
        state: 'disconnected',  // NOVO
        status: 'disconnected', // manter compatibilidade
        phone:  null,
        qr:     null,
      });

      await _syncFirestore(uid, {
        status:    'disconnected',
        phone:     null,
        sessionId: null,
      });

      if (loggedOut) {
        // 401 = Logout → credenciais revogadas, não reconectar
        _logStructured('Manager', 'warn', uid, 'Logout detectado — limpando credenciais', {});
        if (typeof clearAuthFn === 'function') await clearAuthFn().catch(() => {});
        else _clearAuthFiles(uid);
        sessions.remove(uid);
        
      } else if (code === 428) {
        // 428 = connection replaced → novo QR pedido, não reconectar automaticamente
        _logStructured('Manager', 'info', uid, 'Connection replaced (428) — aguardando novo QR manual', {});
        
      } else {
        // CAMADA 1.1 — Retry controlado com limite de 5 tentativas
        // Usar novo sistema de retry em sessions.js
        
        if (!canReconnect(uid)) {
          _logStructured('Manager', 'warn', uid, 
            'Não pode reconectar — sessão em estado FAILED', {});
          sessions.remove(uid);
          return;
        }
        
        // Incrementar retry e verificar se ainda pode tentar
        const canContinue = incrementRetry(uid);
        const sess = sessions.get(uid);
        
        if (!canContinue) {
          // Atingiu limite de 5 tentativas
          _logStructured('Manager', 'error', uid,
            `Limite de ${DEFAULT_MAX_RETRIES} tentativas atingido — marcando como FAILED`,
            { errorCode: code, finalRetryCount: sess.retryCount });
          
          setFailed(uid, {
            code: String(code),
            message: `Limite de ${DEFAULT_MAX_RETRIES} tentativas de reconexão atingido`
          });
          
          // Limpar credenciais
          if (typeof clearAuthFn === 'function') await clearAuthFn().catch(() => {});
          else _clearAuthFiles(uid);
          
          sessions.remove(uid);
          await _syncFirestore(uid, {
            status:    'disconnected',
            phone:     null,
            sessionId: null,
            qrGeneratedAt: null,
          });
          return;
        }
        
        // Ainda pode tentar — agendar reconexão com backoff
        sessions.set(uid, { state: 'reconnecting', status: 'reconnecting' });
        
        // NOVO: Backoff progressivo (2s, 4s, 8s, 16s, 32s)
        const baseDelay = 2000;
        const delayMs = Math.min(baseDelay * Math.pow(2, sess.retryCount - 1), 32000);
        const jitter = 1 + (Math.random() * 0.4 - 0.2); // ±20%
        const delay = delayMs * jitter;
        
        _logStructured('Manager', 'info', uid,
          'Reconexão agendada',
          { 
            retryCount: sess.retryCount,
            maxRetries: DEFAULT_MAX_RETRIES,
            delayMs: Math.round(delay),
            errorCode: code,
          });
        
        const timer = setTimeout(() => {
          _reconnectTimers.delete(uid);
          startSession(uid, { fresh: false }).catch(e => {
            _logStructured('Manager', 'error', uid, 
              'Erro na reconexão automática',
              { error: e.message });
          });
        }, delay);
        _reconnectTimers.set(uid, timer);
      }
    }
  });
  
  // [START SESSION EXIT]
  const startSessionExitTime = Date.now();
  const totalDuration = startSessionExitTime - startSessionEnterTime;
  const finalSession = sessions.get(uid);
  const sessionCreated = !!finalSession;
  const socketCreated = !!finalSession?.socket;
  const finalInstanceId = finalSession?.socketInstanceId ?? 'none';
  const finalState = finalSession?.state ?? 'unknown';
  
  console.log(`
[START SESSION EXIT]
┌─ timestamp: ${startSessionExitTime}
├─ uid: ${uid}
├─ slot: ${uid.includes('_') ? uid.split('_')[1] : 'whatsapp_1'}
├─ tempoTotal: ${totalDuration}ms
├─ estadoFinal: ${finalState}
├─ sessaoCriada: ${sessionCreated ? 'sim' : 'não'}
├─ socketCriado: ${socketCreated ? 'sim' : 'não'}
├─ instanceId: ${finalInstanceId}
├─ socketListeners: [creds.update, messages.upsert, contacts.upsert, messaging-history.set, contacts.update, connection.update]
├─ sucesso: ${socketCreated && sessionCreated ? 'sim' : 'não'}
└─ proximaPasso: aguardando_connection.update_ou_erro
  `);
}

// ══════════════════════════════════════════════════════════════════════
// closeSession(uid) — encerrar sessão de forma limpa
// ══════════════════════════════════════════════════════════════════════

/**
 * Encerra a sessão WhatsApp de um utilizador.
 * @param {string} uid
 * @param {boolean} [clearAuth=true]  Se true, apaga os ficheiros de autenticação
 * @returns {Promise<void>}
 */
async function closeSession(uid, clearAuth = true) {
  const destroyStartTime = Date.now();
  const sess = sessions.get(uid);
  const instanceId = sess?.socketInstanceId ?? 'unknown';
  const estadoAntes = sess?.status ?? 'unknown';
  
  // [DESTROY START] — Início da destruição de sessão
  console.log(`
[DESTROY START]
┌─ timestamp: ${destroyStartTime}
├─ uid: ${uid}
├─ instanceId: ${instanceId}
├─ clearAuth: ${clearAuth}
├─ motivo: closeSession_called
└─ estadoAtual: ${estadoAntes}
  `);

  _clearConnectTimeout(uid);
  _clearWatchdogConnecting(uid);  // NOVO: cancelar watchdog
  _cancelPendingReconnect(uid);
  
  // [INSTRUMENTAÇÃO QR] Sessão a ser destruída
  console.log(`[DESTROY SESSION] uid: ${uid}, instanceId: ${instanceId}, clearAuth: ${clearAuth}, timestamp: ${Date.now()}`);
  
  _logStructured('Manager', 'info', uid, 'Encerrando sessão', { clearAuth });

  if (sess?.socket) {
    try {
      await withTimeout(sess.socket.logout(), 8000, 'sock.logout');
    } catch (_) {
      // logout pode falhar se já desconectado — silenciar
      try { sess.socket.end(undefined); } catch (__) { /* silenciar */ }
    }
  }

  sessions.remove(uid);

  if (clearAuth) {
    _clearAuthFiles(uid);
  }

  // Limpar lidMap desta sessão — será reconstruído quando a sessão reconectar.
  _lidMaps.delete(uid);

  await _syncFirestore(uid, {
    status:    'disconnected',
    phone:     null,
    sessionId: null,
    qrGeneratedAt: null,
  });

  _logStructured('Manager', 'info', uid, 'Sessão encerrada', { clearAuth });

  // [DESTROY END] — Fim da destruição de sessão
  const destroyEndTime = Date.now();
  console.log(`
[DESTROY END]
┌─ timestamp: ${destroyEndTime}
├─ uid: ${uid}
├─ instanceIdDestruido: ${instanceId}
├─ tempoGasto: ${destroyEndTime - destroyStartTime}ms
└─ clearAuth: ${clearAuth}
  `);
}

// ══════════════════════════════════════════════════════════════════════
// getStatus(uid) — estado actual
// ══════════════════════════════════════════════════════════════════════

/**
 * Devolve o estado actual de uma sessão.
 * @param {string} uid
 * @returns {{ status: string, phone: string|null, qr: string|null, qrGeneratedAt: number|null }}
 */
function getStatus(uid) {
  const sess = sessions.get(uid);
  if (!sess) {
    return { 
      status: 'disconnected', 
      state: 'disconnected',  // NOVO
      phone: null, 
      qr: null, 
      qrGeneratedAt: null 
    };
  }
  return {
    status:        sess.status || sess.state,  // compatibilidade
    state:         sess.state || 'disconnected',  // NOVO
    phone:         sess.phone || null,
    qr:            sess.qr   || null,
    qrGeneratedAt: sess.qrGeneratedAt || null,
    sessionId:     sess.sessionId || uid,
    retryCount:    sess.retryCount || 0,  // NOVO
    lastError:     sess.lastError || null,  // NOVO
  };
}

// ══════════════════════════════════════════════════════════════════════
// sendMessage(uid, phone, text) — FASE 3.2.6
// Envia uma mensagem de texto simples através da sessão activa de um
// workspace. Usado exclusivamente pelo motor de fluxos (workflowEngine.js)
// para responder a mensagens recebidas — não está ligado a nenhum botão
// nem fluxo de UI existente.
// ══════════════════════════════════════════════════════════════════════

/**
 * @param {string} uid    workspace dono da sessão WhatsApp
 * @param {string} phone  número de destino, formato '+258...'
 * @param {string} text   texto a enviar
 * @returns {Promise<void>}
 */
async function sendMessage(uid, phone, text) {
  const _tSend0 = Date.now();
  console.info(`[SENDMSG][1] sendMessage() INÍCIO | phone=${phone} | t=${_tSend0} | text="${text.slice(0,40)}"`);

  const sess = sessions.get(uid);

  if (!sess || sess.status !== 'connected' || !sess.socket) {
    throw new Error(`Sessão não está conectada (uid: ${uid}, status: ${sess?.status || 'inexistente'}) — mensagem não enviada.`);
  }

  const digits = String(phone).replace(/[^0-9]/g, '');
  if (!digits) {
    throw new Error(`Número inválido para envio: "${phone}" — nenhum dígito encontrado. Mensagem não enviada.`);
  }
  const jid = `${digits}@s.whatsapp.net`;

  console.info(`[SENDMSG][2] A chamar socket.sendMessage | jid=${jid} | t=${Date.now()}`);
  await sess.socket.sendMessage(jid, { text });
  console.info(`[SENDMSG][3] socket.sendMessage OK | duração=${Date.now()-_tSend0}ms | t=${Date.now()}`);
}

// ── Helpers ──────────────────────────────────────────────────────────

/** @type {Map<string, NodeJS.Timeout>} */
const _connectTimeouts = new Map();

// CAMADA 1.1 — Watchdog para sessões "connecting preso"
// Se uma sessão ficar mais de 2 minutos em estado 'connecting',
// força FAILED automaticamente
/** @type {Map<string, NodeJS.Timeout>} */
const _watchdogTimers = new Map();

/** @type {Map<string, NodeJS.Timeout>} */
const _reconnectTimers   = new Map();
const _reconnectAttempts = new Map(); // uid → número de tentativas consecutivas

// Número máximo de tentativas de reconexão consecutivas antes de desistir
// e limpar as credenciais. Sem isto, uma sessão com auth inválida (ex.:
// w0/w1 vindos do Firestore após o WhatsApp ter revogado a sessão do lado
// dele) entra num loop infinito de reconexão → "Channel closed" repetido
// para sempre, que é o spam visto no terminal ao correr `npm start`.
const MAX_RECONNECT_ATTEMPTS = 8;

// Backoff exponencial: 3s, 6s, 12s, 24s, 48s, máx 120s
// Evita que 100 sessões caídas ao mesmo tempo disparem todas ao fim de 3s
// e derrubar o servidor novamente (thundering herd de reconexões).
function _backoffMs(uid) {
  const attempts = _reconnectAttempts.get(uid) || 0;
  const base     = 3000;
  const max      = 120000;
  // Jitter de ±20% para não sincronizar reconexões de contas diferentes
  const jitter   = 1 + (Math.random() * 0.4 - 0.2);
  return Math.min(base * Math.pow(2, attempts) * jitter, max);
}

/**
 * Cancela uma reconexão automática agendada (setTimeout de 3s) para um
 * uid, se existir. Chamado sempre que se inicia uma sessão nova, para
 * evitar duas sessões Baileys a competir pelo mesmo uid em simultâneo
 * — que era a causa de QR Codes gerados por uma tentativa serem
 * imediatamente substituídos/destruídos por outra tentativa concorrente.
 * @param {string} uid
 */
function _cancelPendingReconnect(uid) {
  _reconnectAttempts.delete(uid); // resetar backoff ao cancelar manualmente
  const timer = _reconnectTimers.get(uid);
  if (timer) {
    clearTimeout(timer);
    _reconnectTimers.delete(uid);
  }
}

/**
 * Arma o timeout de segurança para uma sessão "connecting".
 * Se a sessão não confirmar ligação (connection.update → 'open') dentro
 * de CONNECT_TIMEOUT_MS, a sessão é destruída e marcada "disconnected".
 * @param {string} uid
 */
function _armConnectTimeout(uid) {
  _clearConnectTimeout(uid);
  const timer = setTimeout(async () => {
    const sess = sessions.get(uid);
    // Só actua se a sessão ainda estiver presa em "connecting"
    if (sess && sess.status === 'connecting') {
      console.warn(`[Manager] Timeout de ligação atingido — uid: ${uid}. A encerrar sessão.`);
      await closeSession(uid, false); // não apagar credenciais — pode ter sido só lentidão de rede
    }
  }, CONNECT_TIMEOUT_MS);
  _connectTimeouts.set(uid, timer);
}

/**
 * Cancela o timeout de segurança de uma sessão (ligação confirmada,
 * sessão fechada manualmente, ou erro).
 * @param {string} uid
 */

// CAMALA 1.1 — Watchdog para "Connecting Preso"
/**
 * Arma o watchdog (2 minutos) para uma sessão em "connecting".
 * Se a sessão não conectar dentro de 2 minutos, força FAILED.
 * 
 * @param {string} uid
 */
function _armWatchdogConnecting(uid) {
  _clearWatchdogConnecting(uid);
  
  const timer = setTimeout(() => {
    const sess = sessions.get(uid);
    if (sess && sess.state === 'connecting') {
      _logStructured('Manager', 'error', uid, 
        'Watchdog acionado — sessão presa em connecting por 2min', 
        { timeout: WATCHDOG_CONNECTING_TIMEOUT_MS });
      
      // Forçar FAILED
      setFailed(uid, { 
        code: 'WATCHDOG_TIMEOUT',
        message: 'Sessão presa em estado connecting por mais de 2 minutos' 
      });
      
      // Encerrar socket se existir
      const sess2 = sessions.get(uid);
      if (sess2?.socket) {
        try {
          sess2.socket.end(undefined);
        } catch (e) {
          _logStructured('Manager', 'warn', uid, 
            'Erro ao forçar fim do socket no watchdog', 
            { error: e.message });
        }
      }
    }
  }, WATCHDOG_CONNECTING_TIMEOUT_MS);
  
  _watchdogTimers.set(uid, timer);
}

/**
 * Cancela o watchdog de uma sessão.
 * 
 * @param {string} uid
 */
function _clearWatchdogConnecting(uid) {
  const timer = _watchdogTimers.get(uid);
  if (timer) {
    clearTimeout(timer);
    _watchdogTimers.delete(uid);
  }
}

function _clearConnectTimeout(uid) {
  const timer = _connectTimeouts.get(uid);
  if (timer) {
    clearTimeout(timer);
    _connectTimeouts.delete(uid);
  }
}

function _clearAuthFiles(uid) {
  const authDir = path.join(AUTH_BASE, uid);
  try {
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
      console.info(`[Manager] Auth files removidos — uid: ${uid}`);
    }
  } catch (e) {
    console.warn('[Manager] Erro ao remover auth files:', e.message);
  }
}

/**
 * Envia indicador de presença (composing/paused) para um número.
 * Usado pelo delay executor para mostrar "a digitar..." durante o delay.
 * @param {string} uid
 * @param {string} phone  — ex: '+258845580705'
 * @param {'composing'|'paused'} state
 */
async function sendPresence(uid, phone, state) {
  const _t0 = Date.now();


  const sess = sessions.get(uid);

  // sock.user contém o JID do próprio número ligado — útil para comparar
  // com o JID da conversa e confirmar se estamos a enviar para o sítio certo.
  if (sess?.socket?.user) {
  } else {
  }

  // CORRECÇÃO: o estado válido de sessão conectada é 'connected', não 'open'.
  // A verificação anterior (status !== 'open') era SEMPRE verdadeira porque
  // 'open' nunca é atribuído — a sessão passa de 'connecting' para 'connected'
  // quando a ligação abre. Isso fazia sendPresence() retornar imediatamente
  // sem nunca chamar presenceSubscribe() nem sendPresenceUpdate().
  if (!sess || !sess.socket || sess.status !== 'connected') {
    return;
  }

  try {
    // CORRECÇÃO: passar o JID original directamente para sendPresenceUpdate.
    // Se o phone já é um JID completo (@lid ou @s.whatsapp.net), usar tal-qual.
    // O Baileys lê o server do JID — se for @lid usa me.lid como from,
    // se for @s.whatsapp.net usa me.id. Ambos existem nas credenciais.
    // Converter @lid para @s.whatsapp.net estava a enviar o chatstate
    // para um JID que o WhatsApp não reconhecia como a conversa activa.
    let jid;
    if (typeof phone === 'string' && phone.includes('@')) {
      // Já é um JID completo — usar directamente
      jid = phone;
    } else {
      // É um número de telefone — construir JID normal
      const digits = String(phone).replace(/[^0-9]/g, '');
      jid = `${digits}@s.whatsapp.net`;
    }


    const _t1 = Date.now();
    try {
      await sess.socket.presenceSubscribe(jid);
    } catch (eSubscribe) {
    }

    const _t2 = Date.now();
    await sess.socket.sendPresenceUpdate(state, jid);
    const _t3 = Date.now();

  } catch (e) {
    console.error(`[PRESENCE][ERRO] Excepção: ${e.message} | stack: ${e.stack}`);
  }
}

module.exports = {
  setFirestore, startSession, closeSession, getStatus,
  sendMessage, sendPresence, setOnIncomingMessage,
};





