/* ══════════════════════════════════════════════════════════════════════
   sessions/sessionManager.js — Sistema de Sessões e Controlo de Fluxos
   ────────────────────────────────────────────────────────────────────
   Gere o ciclo de vida completo de uma sessão de conversa:
     - Criação quando o cliente contacta pela primeira vez
     - Continuação exacta do último nó guardado (sem reinício automático)
     - Transição para modo IA quando o fluxo termina
     - Histórico das últimas mensagens para contexto da IA

   Colecção Firestore: sessions
   Documento ID: {accountId}_{phoneNumber}

   Documento da sessão:
     {
       account_id:    string,
       phone_number:  string,
       flow_id:       string,
       current_node_id: string,
       state:         'active' | 'ai_mode',
       variables:     object,
       last_activity: Timestamp,
       created_at:    Timestamp,
     }

   Sub-colecção: sessions/{docId}/messages
     {
       role:      'user' | 'assistant',
       content:   string,
       timestamp: Timestamp,
     }

   Regras imutáveis:
     - O fluxo NUNCA reinicia automaticamente por nenhum motivo
     - Quando o fluxo termina, state passa para 'ai_mode'
     - Em 'ai_mode' nunca volta para o fluxo (só reset manual do admin)
     - Histórico mantém máximo 20 mensagens (apaga as mais antigas)
   ══════════════════════════════════════════════════════════════════════ */

const logger = require('../engine/logger');

let _db = null;

function setFirestore(db) {
  _db = db;
}

// ── Limites do histórico ───────────────────────────────────────────────
const MAX_HISTORY_KEPT   = 20; // máximo de mensagens guardadas no Firestore
const MAX_HISTORY_FOR_AI =  5; // últimas N mensagens enviadas ao contexto da IA

// ── Utilitários internos ───────────────────────────────────────────────

/**
 * Normaliza o ID do documento Firestore a partir de accountId e phoneNumber.
 * Caracteres '/' são proibidos em document IDs do Firestore.
 * @param {string} accountId
 * @param {string} phoneNumber
 * @returns {string}
 */
function _docId(accountId, phoneNumber) {
  const safeAccount = String(accountId).replace(/\//g, '_');
  const safePhone   = String(phoneNumber).replace(/\//g, '_');
  return `${safeAccount}_${safePhone}`;
}

/**
 * Devolve a referência do documento da sessão no Firestore.
 * @param {string} accountId
 * @param {string} phoneNumber
 * @returns {FirebaseFirestore.DocumentReference|null}
 */
function _ref(accountId, phoneNumber) {
  if (!_db) return null;
  return _db.collection('sessions').doc(_docId(accountId, phoneNumber));
}

/**
 * Devolve o timestamp actual do servidor (FieldValue.serverTimestamp).
 * @returns {FirebaseFirestore.FieldValue}
 */
function _now() {
  return _db.FieldValue
    ? _db.FieldValue.serverTimestamp()
    : require('firebase-admin').firestore.FieldValue.serverTimestamp();
}

// ── API pública ────────────────────────────────────────────────────────

/**
 * Busca a sessão no Firestore.
 * @param {string} accountId
 * @param {string} phoneNumber
 * @returns {Promise<object|null>} Dados da sessão ou null se não existir
 */
async function getSession(accountId, phoneNumber) {
  const ref = _ref(accountId, phoneNumber);
  if (!ref) {
    logger.warn(accountId, phoneNumber, '[Sessions] Firestore não inicializado — getSession retorna null.');
    return null;
  }

  try {
    const snap = await ref.get();
    if (!snap.exists) return null;
    return snap.data();
  } catch (e) {
    logger.error(accountId, phoneNumber, `[Sessions] Erro em getSession: ${e.message}`);
    return null;
  }
}

/**
 * Cria uma nova sessão com state 'active'.
 * @param {string} accountId
 * @param {string} phoneNumber
 * @param {string} flowId         ID do fluxo a executar
 * @param {string} firstNodeId    ID do nó inicial (trigger/início)
 * @returns {Promise<object>} Dados da sessão criada
 */
async function createSession(accountId, phoneNumber, flowId, firstNodeId) {
  const ref = _ref(accountId, phoneNumber);
  if (!ref) {
    logger.warn(accountId, phoneNumber, '[Sessions] Firestore não inicializado — createSession em memória apenas.');
    return _blankSession(accountId, phoneNumber, flowId, firstNodeId);
  }

  const session = {
    account_id:      accountId,
    phone_number:    phoneNumber,
    flow_id:         flowId,
    current_node_id: firstNodeId,
    state:           'active',
    variables:       {},
    last_activity:   _now(),
    created_at:      _now(),
  };

  try {
    await ref.set(session);
    logger.info(accountId, phoneNumber,
      `[Sessions] Sessão criada — flow: ${flowId} | primeiro nó: ${firstNodeId}`);
  } catch (e) {
    logger.error(accountId, phoneNumber, `[Sessions] Erro em createSession: ${e.message}`);
  }

  return session;
}

/**
 * Actualiza o nó actual e as variáveis da sessão.
 * Preserva o state actual — não altera 'active' nem 'ai_mode'.
 * @param {string} accountId
 * @param {string} phoneNumber
 * @param {string} nodeId       ID do nó onde a conversa está agora
 * @param {object} variables    Variáveis actualizadas da sessão
 * @returns {Promise<void>}
 */
async function updateSessionNode(accountId, phoneNumber, nodeId, variables) {
  const ref = _ref(accountId, phoneNumber);
  if (!ref) return;

  try {
    await ref.set(
      {
        current_node_id: nodeId,
        variables:       variables || {},
        last_activity:   _now(),
      },
      { merge: true }
    );
    logger.info(accountId, phoneNumber, `[Sessions] Nó actualizado → ${nodeId}`);
  } catch (e) {
    logger.error(accountId, phoneNumber, `[Sessions] Erro em updateSessionNode: ${e.message}`);
  }
}

/**
 * Muda o state da sessão para 'ai_mode' quando o fluxo termina.
 * A partir deste momento, todas as mensagens seguintes são respondidas
 * pela IA — o fluxo nunca volta a ser executado sem reset manual.
 * @param {string} accountId
 * @param {string} phoneNumber
 * @returns {Promise<void>}
 */
async function completeSession(accountId, phoneNumber) {
  const ref = _ref(accountId, phoneNumber);
  if (!ref) return;

  try {
    await ref.set(
      {
        state:         'ai_mode',
        last_activity: _now(),
      },
      { merge: true }
    );
    logger.info(accountId, phoneNumber,
      '[Sessions] Fluxo concluído — sessão transitou para ai_mode.');
  } catch (e) {
    logger.error(accountId, phoneNumber, `[Sessions] Erro em completeSession: ${e.message}`);
  }
}

/**
 * Apaga a sessão completamente (usado pelo administrador para reset manual).
 * Após reset, a próxima mensagem do cliente cria uma nova sessão e
 * reinicia o fluxo do início.
 * @param {string} accountId
 * @param {string} phoneNumber
 * @returns {Promise<void>}
 */
async function resetSession(accountId, phoneNumber) {
  const ref = _ref(accountId, phoneNumber);
  if (!ref) return;

  try {
    // Apagar sub-colecção de mensagens antes de apagar o documento principal
    await _deleteMessagesSubcollection(accountId, phoneNumber);
    await ref.delete();
    logger.info(accountId, phoneNumber,
      '[Sessions] Sessão apagada pelo administrador — próxima mensagem reinicia o fluxo.');
  } catch (e) {
    logger.error(accountId, phoneNumber, `[Sessions] Erro em resetSession: ${e.message}`);
  }
}

/**
 * Devolve o contexto necessário para a IA responder em 'ai_mode':
 *   - businessDescription: descrição do negócio da conta
 *   - clientName:          nome do cliente (se guardado nas variáveis)
 *   - lastMessages:        últimas 5 mensagens da conversa
 *
 * @param {string} accountId
 * @param {string} phoneNumber
 * @returns {Promise<{ businessDescription: string|null, clientName: string|null, lastMessages: Array }>}
 */
async function getAiContext(accountId, phoneNumber) {
  const context = {
    businessDescription: null,
    clientName:          null,
    lastMessages:        [],
  };

  if (!_db) return context;

  try {
    // ── 1. Descrição do negócio (campo business_description na conta) ──
    try {
      const accountSnap = await _db.collection('accounts').doc(accountId).get();
      if (accountSnap.exists) {
        const accountData = accountSnap.data();
        context.businessDescription = accountData.business_description || null;
      }
    } catch (e) {
      logger.error(accountId, phoneNumber,
        `[Sessions] Erro ao ler business_description: ${e.message}`);
    }

    // ── 2. Nome do cliente nas variáveis da sessão ─────────────────────
    try {
      const session = await getSession(accountId, phoneNumber);
      if (session && session.variables) {
        // Procura por variáveis comuns para o nome do cliente
        const vars = session.variables;
        context.clientName =
          vars.nome      ||
          vars.name      ||
          vars.cliente   ||
          vars.client    ||
          vars.nome_cliente ||
          null;
      }
    } catch (e) {
      logger.error(accountId, phoneNumber,
        `[Sessions] Erro ao ler variáveis da sessão: ${e.message}`);
    }

    // ── 3. Últimas 5 mensagens da conversa ─────────────────────────────
    try {
      const ref = _ref(accountId, phoneNumber);
      if (ref) {
        const snap = await ref
          .collection('messages')
          .orderBy('timestamp', 'desc')
          .limit(MAX_HISTORY_FOR_AI)
          .get();

        if (!snap.empty) {
          const msgs = [];
          snap.forEach(doc => msgs.unshift(doc.data())); // ordem cronológica
          context.lastMessages = msgs;
        }
      }
    } catch (e) {
      logger.error(accountId, phoneNumber,
        `[Sessions] Erro ao ler últimas mensagens: ${e.message}`);
    }

  } catch (e) {
    logger.error(accountId, phoneNumber,
      `[Sessions] Erro geral em getAiContext: ${e.message}`);
  }

  return context;
}

/**
 * Guarda uma mensagem na sub-colecção messages da sessão.
 * Mantém automaticamente o limite de MAX_HISTORY_KEPT mensagens,
 * apagando as mais antigas quando o total ultrapassa esse valor.
 *
 * @param {string} accountId
 * @param {string} phoneNumber
 * @param {'user'|'assistant'} role
 * @param {string} content
 * @returns {Promise<void>}
 */
async function saveMessage(accountId, phoneNumber, role, content) {
  const ref = _ref(accountId, phoneNumber);
  if (!ref || !content) return;

  try {
    const messagesRef = ref.collection('messages');

    // Guardar a nova mensagem
    await messagesRef.add({
      role,
      content,
      timestamp: _now(),
    });

    // Verificar se o total ultrapassa MAX_HISTORY_KEPT e apagar as mais antigas
    _pruneMessages(accountId, phoneNumber, messagesRef).catch(e => {
      logger.error(accountId, phoneNumber,
        `[Sessions] Erro ao fazer pruning do histórico: ${e.message}`);
    });

  } catch (e) {
    logger.error(accountId, phoneNumber,
      `[Sessions] Erro em saveMessage: ${e.message}`);
  }
}

// ── Funções auxiliares internas ────────────────────────────────────────

/**
 * Devolve um objecto de sessão em branco (para quando o Firestore não está disponível).
 */
function _blankSession(accountId, phoneNumber, flowId, firstNodeId) {
  return {
    account_id:      accountId,
    phone_number:    phoneNumber,
    flow_id:         flowId,
    current_node_id: firstNodeId,
    state:           'active',
    variables:       {},
    last_activity:   Date.now(),
    created_at:      Date.now(),
  };
}

/**
 * Remove as mensagens mais antigas quando o total ultrapassa MAX_HISTORY_KEPT.
 * Executado de forma assíncrona — não bloqueia o fluxo principal.
 * @param {string} accountId
 * @param {string} phoneNumber
 * @param {FirebaseFirestore.CollectionReference} messagesRef
 */
async function _pruneMessages(accountId, phoneNumber, messagesRef) {
  try {
    const countSnap = await messagesRef.orderBy('timestamp', 'asc').get();
    const total = countSnap.size;

    if (total <= MAX_HISTORY_KEPT) return;

    const toDelete = total - MAX_HISTORY_KEPT;
    const docs = countSnap.docs.slice(0, toDelete);

    // Apagar em batch para eficiência
    const batch = _db.batch();
    docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    logger.info(accountId, phoneNumber,
      `[Sessions] Histórico podado — apagadas ${toDelete} mensagens antigas (total era ${total}).`);
  } catch (e) {
    logger.error(accountId, phoneNumber,
      `[Sessions] Erro em _pruneMessages: ${e.message}`);
  }
}

/**
 * Apaga toda a sub-colecção messages antes de apagar a sessão.
 * Firestore não apaga sub-colecções automaticamente.
 * @param {string} accountId
 * @param {string} phoneNumber
 */
async function _deleteMessagesSubcollection(accountId, phoneNumber) {
  const ref = _ref(accountId, phoneNumber);
  if (!ref) return;

  try {
    const snap = await ref.collection('messages').get();
    if (snap.empty) return;

    const batch = _db.batch();
    snap.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    logger.info(accountId, phoneNumber,
      `[Sessions] Sub-colecção messages apagada (${snap.size} documentos).`);
  } catch (e) {
    logger.error(accountId, phoneNumber,
      `[Sessions] Erro em _deleteMessagesSubcollection: ${e.message}`);
  }
}

// ── Ferramentas do administrador ───────────────────────────────────────

/**
 * Apaga apenas a sub-colecção messages da sessão.
 * A sessão em si continua intacta: current_node_id, state e variables
 * são preservados. Útil quando o administrador quer limpar o histórico
 * sem reiniciar a conversa.
 * @param {string} accountId
 * @param {string} phoneNumber
 * @returns {Promise<void>}
 */
async function clearMessageHistory(accountId, phoneNumber) {
  const ref = _ref(accountId, phoneNumber);
  if (!ref) return;

  try {
    await _deleteMessagesSubcollection(accountId, phoneNumber);
    logger.info(accountId, phoneNumber,
      '[Sessions][Admin] Histórico de mensagens apagado — sessão preservada.');
  } catch (e) {
    logger.error(accountId, phoneNumber,
      `[Sessions][Admin] Erro em clearMessageHistory: ${e.message}`);
  }
}

/**
 * Bloqueia a IA para este cliente específico.
 * Define ai_blocked: true no documento da sessão.
 * Enquanto este campo for true, a IA não responde mesmo que state === 'ai_mode'.
 * Os fluxos continuam a funcionar normalmente.
 * @param {string} accountId
 * @param {string} phoneNumber
 * @returns {Promise<void>}
 */
async function blockAi(accountId, phoneNumber) {
  const ref = _ref(accountId, phoneNumber);
  if (!ref) return;

  try {
    await ref.set(
      {
        ai_blocked:    true,
        last_activity: _now(),
      },
      { merge: true }
    );
    logger.info(accountId, phoneNumber,
      '[Sessions][Admin] IA bloqueada para este cliente.');
  } catch (e) {
    logger.error(accountId, phoneNumber,
      `[Sessions][Admin] Erro em blockAi: ${e.message}`);
    throw e;
  }
}

/**
 * Desbloqueia a IA para este cliente.
 * Define ai_blocked: false no documento da sessão.
 * @param {string} accountId
 * @param {string} phoneNumber
 * @returns {Promise<void>}
 */
async function unblockAi(accountId, phoneNumber) {
  const ref = _ref(accountId, phoneNumber);
  if (!ref) return;

  try {
    await ref.set(
      {
        ai_blocked:    false,
        last_activity: _now(),
      },
      { merge: true }
    );
    logger.info(accountId, phoneNumber,
      '[Sessions][Admin] IA desbloqueada para este cliente.');
  } catch (e) {
    logger.error(accountId, phoneNumber,
      `[Sessions][Admin] Erro em unblockAi: ${e.message}`);
    throw e;
  }
}

/**
 * Exporta todas as mensagens da conversa para JSON.
 * Devolve o objecto completo com metadados e histórico ordenado por timestamp.
 * @param {string} accountId
 * @param {string} phoneNumber
 * @returns {Promise<{
 *   phone_number: string,
 *   account_id:   string,
 *   exported_at:  string,
 *   messages:     Array<{role: string, content: string, timestamp: any}>
 * }>}
 */
async function exportConversation(accountId, phoneNumber) {
  const result = {
    phone_number: phoneNumber,
    account_id:   accountId,
    exported_at:  new Date().toISOString(),
    messages:     [],
  };

  const ref = _ref(accountId, phoneNumber);
  if (!ref) return result;

  try {
    const snap = await ref
      .collection('messages')
      .orderBy('timestamp', 'asc')
      .get();

    if (!snap.empty) {
      snap.forEach(doc => {
        const data = doc.data();
        result.messages.push({
          role:      data.role      || 'unknown',
          content:   data.content   || '',
          timestamp: data.timestamp || null,
        });
      });
    }

    logger.info(accountId, phoneNumber,
      `[Sessions][Admin] Conversa exportada — ${result.messages.length} mensagens.`);
  } catch (e) {
    logger.error(accountId, phoneNumber,
      `[Sessions][Admin] Erro em exportConversation: ${e.message}`);
    throw e;
  }

  return result;
}

module.exports = {
  setFirestore,
  getSession,
  createSession,
  updateSessionNode,
  completeSession,
  resetSession,
  getAiContext,
  saveMessage,
  // Ferramentas do administrador
  clearMessageHistory,
  blockAi,
  unblockAi,
  exportConversation,
};
