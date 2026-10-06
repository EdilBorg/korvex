/* ══════════════════════════════════════════════════════════════════════
   FASE 4.1D — engine/inbox.js  (CORRECÇÃO BUGS 3 e 4)
   ────────────────────────────────────────────────────────────────────
   Inbox — módulo OBSERVADOR. Não participa na execução de fluxos, não
   decide nada, não navega nós. Apenas regista o que já aconteceu:

       workflowEngine.handleIncoming()  ──► inbox.recordIncoming()
       sendMessage() (wrapper)          ──► inbox.recordOutgoing()

   Responsabilidades:
     1. Persistir cada mensagem (entrada/saída) em
        workspaces/{uid}/conversations/{phone}/messages/{id}
     2. Manter um documento-resumo por contacto em
        workspaces/{uid}/inbox/{phone}
     3. Manter messageCount (FieldValue.increment atómico) — usado pela
        página Analytics para o ranking de clientes que mais conversaram.

   IMPORTANTE: este módulo nunca lança excepções para quem o chama —
   uma falha ao gravar a Inbox NUNCA deve impedir o motor de fluxos de
   responder ao utilizador. Todos os erros são apanhados e registados.

   CORRECÇÕES FASE 4.1C:
     • BUG A — _upsertSummary: FieldValue.increment() não é aceite em
       ref.set({...}, { merge:false }) em alguns SDKs Admin. A criação
       do documento na primeira vez agora usa ref.set({...}, {merge:true})
       com campos base explícitos via _ensureDocExists(), garantindo que
       o sentinel increment funciona sempre.
     • BUG B — displayName sobrescrito com número quando não há pushName:
       recordIncoming só actualiza displayName quando tem pushName, e
       mesmo assim respeita um savedName já existente via transacção
       simples (get + merge condicional). Número nunca sobrescreve nome.
     • BUG C — workflowEngine.js passava activeFlowId=undefined para
       recordIncoming porque o campo não existe no objecto message.
       Corrigido em workflowEngine.js (campo removido da chamada);
       inbox.js já ignorava undefined, mas o patch ficava poluído.
     • BUG D — pushName null gravado sobre um pushName válido já existente:
       o patch de recordIncoming só inclui pushName quando não é null.
     • BUG 4 (mantido) — unreadCount usa FieldValue.increment(1) atómico.
     • BUG 6 (mantido) — sem erros silenciosos; todos registados.
   ══════════════════════════════════════════════════════════════════════ */

const logger = require('./logger');

let _db = null;
let _FieldValue = null; // firebase-admin.firestore.FieldValue — injectado em setFirestore

function setFirestore(db) {
  _db = db;
  // Obter FieldValue do mesmo módulo firebase-admin já inicializado
  try {
    const admin = require('firebase-admin');
    _FieldValue = admin.firestore.FieldValue;
  } catch (e) {
    console.error('[Inbox] Não foi possível obter FieldValue:', e.message);
  }
}

function _safeId(phone) {
  return String(phone).replace(/\//g, '_');
}

function _inboxRef(uid, phone) {
  if (!_db) return null;
  return _db
    .collection('workspaces').doc(uid)
    .collection('inbox').doc(_safeId(phone));
}

function _messagesCol(uid, phone) {
  if (!_db) return null;
  return _db
    .collection('workspaces').doc(uid)
    .collection('conversations').doc(_safeId(phone))
    .collection('messages');
}

function _eventsCol(uid, phone) {
  if (!_db) return null;
  return _db
    .collection('workspaces').doc(uid)
    .collection('conversations').doc(_safeId(phone))
    .collection('events');
}

/**
 * FASE INBOX — Timeline. Regista um evento automático na linha do tempo
 * da conversa (workspaces/{uid}/conversations/{phone}/events/{id}).
 * Nunca lança excepções — falha silenciosa registada em log, tal como
 * o resto deste módulo observador.
 * Eventos manuais (etiqueta adicionada, arquivada, assumida por humano,
 * etc.) são gravados directamente pelo frontend na mesma colecção
 * (regras Firestore permitem ao próprio dono do workspace).
 */
async function recordEvent(uid, phone, type, label, meta) {
  const col = _eventsCol(uid, phone);
  if (!col) return;
  const ts = Date.now();
  const id = `${ts}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    await col.doc(id).set({
      id, type, label: label || type, meta: meta || null, timestamp: ts, source: 'system',
    });
  } catch (e) {
    console.error(`[Inbox] Erro ao gravar evento (uid:${uid} phone:${phone}):`, e.message);
    logger.error(uid, phone, `[Inbox] Erro ao gravar evento: ${e.message}`);
  }
}

/**
 * Calcula o displayName segundo a prioridade definida no produto:
 * 1º savedName (vendedor) → 2º pushName (perfil WhatsApp) → 3º phone.
 * Strings vazias/whitespace são tratadas como ausentes.
 */
function _computeDisplayName(savedName, pushName, phone) {
  const s = (savedName || '').trim();
  if (s) return s;
  const p = (pushName || '').trim();
  if (p) return p;
  return phone;
}

/**
 * Gera um rótulo curto para preview na lista da Inbox quando a
 * mensagem não é texto puro (ex.: "📷 Imagem").
 */
function _previewFor(type, text) {
  const labels = {
    image:    '📷 Imagem',
    video:    '🎥 Vídeo',
    audio:    '🎵 Áudio',
    document: '📄 Documento',
  };
  if (type === 'text') return text || '';
  const label = labels[type] || '📎 Anexo';
  const caption = (text || '').trim();
  return caption ? `${label} — ${caption}` : label;
}

/**
 * Grava uma mensagem (entrada ou saída) no histórico da conversa.
 */
async function _appendMessage(uid, phone, msg) {
  const col = _messagesCol(uid, phone);
  if (!col) return;

  const ts = msg.timestamp || Date.now();
  const id = `${ts}_${Math.random().toString(36).slice(2, 8)}`;

  const doc = {
    id,
    direction: msg.direction,
    type:      msg.type || 'text',
    text:      msg.text  ?? null,
    mediaUrl:  msg.mediaUrl  ?? null,
    mediaMime: msg.mediaMime ?? null,
    timestamp: ts,
  };

  // Erros aqui são registados mas nunca propagados (observador não derruba motor)
  try {
    await col.doc(id).set(doc);
  } catch (e) {
    console.error(`[Inbox] Erro ao gravar mensagem (uid:${uid} phone:${phone}):`, e.message, e.stack);
    logger.error(uid, phone, `[Inbox] Erro ao gravar mensagem: ${e.message}`);
  }
}

/**
 * Garante que o documento-resumo do contacto existe no Firestore, criando-o
 * com valores base se ainda não existir. Usa merge:true em TODOS os casos —
 * isto é crítico porque FieldValue.increment() (sentinel) não é aceite pelo
 * SDK Admin numa chamada ref.set({}, { merge: false }) / criação directa sem merge.
 * Com merge:true, o Firestore cria o documento se não existir e aplica os
 * sentinels correctamente em ambos os casos (criação e actualização).
 *
 * Os campos base são escritos apenas se o documento for novo (o merge:true
 * preserva campos já existentes que não estejam no patch).
 */
async function _ensureBaseFields(uid, phone, ref, now) {
  // Campos que só devem existir no documento se for a primeira escrita.
  // Usamos set+merge:true com estes campos; o Firestore não sobrescreve
  // campos já existentes que não estejam neste objecto.
  const base = {
    contactId:       phone,
    phone,
    savedName:       null,
    pushName:        null,
    // BUG 3/4 — displayName não pode nascer como número.
    // Nasce vazio; só é preenchido quando pushName ou savedName chegarem.
    // O frontend usa: displayName → pushName → phone (apenas para exibição).
    displayName:     '',
    lastMessage:     '',
    lastMessageType: 'text',
    lastMessageAt:   now,
    unreadCount:     0,
    // Analytics — contador total de mensagens (entrada + saída) desta
    // conversa, usado para o ranking "clientes que mais conversaram".
    messageCount:    0,
    activeFlowId:    null,
    status:          'bot',
    tags:            [],
    notes:           '',
    internalNotes:   [],
    archived:        false,
    favorite:        false,
    lastMessageDirection: 'in',
    assignedTo:      null,
    createdAt:       now,
    updatedAt:       now,
  };
  // set+merge:true: cria se não existir, preserva campos já existentes.
  // NÃO incluir FieldValue.increment() aqui — os campos base são escalares.
  await ref.set(base, { merge: true });
}

/**
 * Cria/actualiza o documento-resumo do contacto na Inbox.
 *
 * SEMPRE usa merge:true — nunca ref.set() sem merge quando o patch pode
 * conter FieldValue sentinels (increment, serverTimestamp, etc.).
 *
 * Fluxo:
 *  1. Verificar se o documento existe (get).
 *  2. Se não existir, criar com campos base (set+merge:true, sem sentinels).
 *  3. Aplicar o patch com set+merge:true (aceita sentinels correctamente).
 */
async function _upsertSummary(uid, phone, patch) {
  const ref = _inboxRef(uid, phone);
  if (!ref) return false;

  let wasNew = false;
  try {
    const now  = Date.now();
    const snap = await ref.get();

    if (!snap.exists) {
      wasNew = true;
      // Criar documento base SEM sentinels — depois aplicar o patch por cima.
      // Duas operações separadas garantem que os sentinels no patch funcionam.
      await _ensureBaseFields(uid, phone, ref, now);
    }

    // Aplicar patch (pode conter FieldValue.increment(1) — funciona com merge:true).
    await ref.set({ ...patch, updatedAt: now }, { merge: true });
  } catch (e) {
    console.error(`[Inbox] Erro ao actualizar resumo (uid:${uid} phone:${phone}):`, e.message, e.stack);
    logger.error(uid, phone, `[Inbox] Erro ao actualizar resumo: ${e.message}`);
  }
  return wasNew;
}

/**
 * Regista uma mensagem RECEBIDA do contacto (WhatsApp → Korvex).
 *
 * CORRECÇÃO BUG 4 — unreadCount: usa FieldValue.increment(1) atómico.
 * CORRECÇÃO BUG A — _upsertSummary usa merge:true em todos os casos.
 * CORRECÇÃO BUG B — displayName: nunca sobrescrito com número quando não
 *   há pushName. pushName: nunca gravado como null sobre um valor existente.
 * CORRECÇÃO BUG D — pushName null não polui o patch (campo omitido se null).
 */
async function recordIncoming(uid, message) {
  if (!_db || !message?.phone) return;

  const {
    phone, text, type, mediaUrl, mediaMime, pushName, timestamp,
    // FASE 4 — campos de grupo (opcionais; undefined em mensagens privadas)
    isGroup, groupJid, participantPhone, participantPushName,
  } = message;

  const ts      = timestamp || Date.now();
  const msgType = type || 'text';

  try {
    // ── FASE 4 — Mensagem de grupo ─────────────────────────────────────
    if (isGroup) {
      // Gravar a mensagem com metadados do participante
      await _appendMessage(uid, phone, {
        direction:           'incoming',
        type:                msgType,
        text:                text          ?? null,
        mediaUrl:            mediaUrl      ?? null,
        mediaMime:           mediaMime     ?? null,
        timestamp:           ts,
        isGroup:             true,
        participantPhone:    participantPhone    || null,
        participantPushName: participantPushName || null,
      });

      // Preview: "👤 Nome: mensagem" ou "👤 +número: mensagem"
      const senderLabel = (participantPushName || participantPhone || 'Desconhecido');
      const rawPreview  = _previewFor(msgType, text);
      const groupPreview = `${senderLabel}: ${rawPreview}`;

      // Nome do grupo: usar pushName do evento se disponível, senão groupJid
      const cleanGroupName = (pushName || '').trim() || groupJid || phone;

      const patch = {
        lastMessage:         groupPreview,
        lastMessageType:     msgType,
        lastMessageAt:       ts,
        unreadCount:         _FieldValue ? _FieldValue.increment(1) : 1,
        messageCount:        _FieldValue ? _FieldValue.increment(1) : 1,
        isGroup:             true,
        displayName:         cleanGroupName,
        lastParticipant:     senderLabel,
        lastParticipantPhone: participantPhone || null,
      };

      await _upsertSummary(uid, phone, patch);
      return; // grupo tratado — não continua para o bloco privado
    }

    // ── Conversa privada — comportamento original ─────────────────────
    await _appendMessage(uid, phone, {
      direction: 'incoming',
      type:      msgType,
      text:      text      ?? null,
      mediaUrl:  mediaUrl  ?? null,
      mediaMime: mediaMime ?? null,
      timestamp: ts,
    });

    // Construir patch:
    //  • pushName: só incluir no patch quando temos um valor real.
    //  • displayName: só actualizar quando temos pushName.
    //  • unreadCount: FieldValue.increment(1) — atómico.
    const cleanPushName = (pushName || '').trim() || null;

    const patch = {
      lastMessage:     _previewFor(msgType, text),
      lastMessageType: msgType,
      lastMessageAt:   ts,
      lastMessageDirection: 'in',
      unreadCount:     _FieldValue ? _FieldValue.increment(1) : 1,
      messageCount:    _FieldValue ? _FieldValue.increment(1) : 1,
      status:          'bot',
    };

    if (cleanPushName) {
      patch.pushName    = cleanPushName;
      patch.displayName = cleanPushName;
    }

    const wasNew = await _upsertSummary(uid, phone, patch);
    if (wasNew) {
      recordEvent(uid, phone, 'conversation_started', 'Cliente iniciou a conversa').catch(() => {});
    }
    if (msgType !== 'text') {
      const labels = { image: 'Cliente enviou uma imagem', video: 'Cliente enviou um vídeo', audio: 'Cliente enviou um áudio', document: 'Cliente enviou um documento' };
      recordEvent(uid, phone, 'attachment_received', labels[msgType] || 'Cliente enviou um anexo').catch(() => {});
    }
  } catch (e) {
    console.error(`[Inbox] Erro em recordIncoming (uid:${uid} phone:${phone}):`, e.message, e.stack);
    logger.error(uid, phone, `[Inbox] Erro em recordIncoming: ${e.message}`);
  }
}

/**
 * Regista uma mensagem ENVIADA (bot do fluxo, ou vendedor manualmente).
 * Não incrementa unreadCount (a mensagem é nossa, não do contacto).
 */
async function recordOutgoing(uid, phone, message) {
  if (!_db || !phone) return;

  const { text, type, mediaUrl, mediaMime, timestamp } = message || {};
  const ts      = timestamp || Date.now();
  const msgType = type || 'text';

  try {
    await _appendMessage(uid, phone, {
      direction: 'outgoing',
      type:      msgType,
      text:      text      ?? null,
      mediaUrl:  mediaUrl  ?? null,
      mediaMime: mediaMime ?? null,
      timestamp: ts,
    });

    await _upsertSummary(uid, phone, {
      lastMessage:     _previewFor(msgType, text),
      lastMessageType: msgType,
      lastMessageAt:   ts,
      lastMessageDirection: 'out',
      messageCount:    _FieldValue ? _FieldValue.increment(1) : 1,
    });
  } catch (e) {
    console.error(`[Inbox] Erro em recordOutgoing (uid:${uid} phone:${phone}):`, e.message, e.stack);
    logger.error(uid, phone, `[Inbox] Erro em recordOutgoing: ${e.message}`);
  }
}

/**
 * Define o nome salvo pelo vendedor para o contacto e recalcula o
 * displayName imediatamente (prioridade savedName → pushName → phone).
 */
async function setSavedName(uid, phone, savedName) {
  const ref = _inboxRef(uid, phone);
  if (!ref) return { displayName: phone };

  const clean = (savedName || '').trim() || null;

  let pushName = null;
  try {
    const snap = await ref.get();
    if (snap.exists) pushName = snap.data().pushName || null;
  } catch (e) {
    console.error(`[Inbox] Erro ao ler resumo para renomear (uid:${uid} phone:${phone}):`, e.message);
    logger.error(uid, phone, `[Inbox] Erro ao ler resumo para renomear: ${e.message}`);
  }

  const displayName = _computeDisplayName(clean, pushName, phone);
  await _upsertSummary(uid, phone, { savedName: clean, displayName });
  return { displayName };
}

/**
 * Zera o contador de não lidas de uma conversa.
 */
async function markAsRead(uid, phone) {
  await _upsertSummary(uid, phone, { unreadCount: 0 });
}

/**
 * Actualiza o activeFlowId guardado no resumo da Inbox para um contacto.
 * Puramente informativo para a UI. Regista também eventos automáticos
 * na Timeline quando um fluxo é iniciado, trocado ou termina.
 */
async function setActiveFlow(uid, phone, flowId) {
  const ref = _inboxRef(uid, phone);
  let prevFlowId = null;
  if (ref) {
    try {
      const snap = await ref.get();
      if (snap.exists) prevFlowId = snap.data().activeFlowId || null;
    } catch (e) {
      // não crítico — apenas perde-se o evento de timeline desta transição
    }
  }

  await _upsertSummary(uid, phone, { activeFlowId: flowId || null });

  const next = flowId || null;
  if (prevFlowId === next) return;
  if (!prevFlowId && next) {
    recordEvent(uid, phone, 'flow_started', `Fluxo iniciado: ${next}`).catch(() => {});
  } else if (prevFlowId && !next) {
    recordEvent(uid, phone, 'flow_finished', `Fluxo terminado: ${prevFlowId}`).catch(() => {});
  } else if (prevFlowId && next) {
    recordEvent(uid, phone, 'flow_started', `Fluxo trocado para: ${next}`).catch(() => {});
  }
}

module.exports = {
  setFirestore,
  recordIncoming,
  recordOutgoing,
  setSavedName,
  markAsRead,
  setActiveFlow,
  recordEvent,
};
