/* ══════════════════════════════════════════════════════════════════════
   FASE 5 — engine/workflowEngine.js (Sistema de Sessões e Controlo de Fluxos)
   ────────────────────────────────────────────────────────────────────
   Motor central: recebe uma mensagem do WhatsApp, identifica o
   workspace e o FLUXO ATIVO associado ao número que recebeu a
   mensagem, percorre o fluxo a partir do ponto onde a conversa estava,
   e envia as respostas correspondentes.

       WhatsApp → manager.js (messages.upsert)
                       │
                       ▼
              workflowEngine.handleIncoming(uid, { phone, text, timestamp })
                       │
            ┌──────────┴───────────┐
            │ 1. sessions/          → gestão de sessões (NOVO)
            │ 2. flows.js           → activeFlowId de connections/whatsapp
            │ 3. conversations.js   → estado actual desta conversa
            │ 4. graph.js           → navegação entre nós
            │ 5. executors/*.js     → ação de cada nó
            └──────────┬───────────┘
                       ▼
              manager.sendMessage(uid, phone, texto)

   SISTEMA DE SESSÕES (FASE 5):
     Cada conversa tem uma sessão persistente no Firestore (colecção
     "sessions", documento "{accountId}_{phoneNumber}") com dois estados:

     'active'  — o fluxo está a ser executado; continua exactamente
                 do current_node_id independentemente do tempo passado.
     'ai_mode' — o fluxo terminou; a IA responde a todas as mensagens.
                 NUNCA volta para o fluxo sem reset manual do admin.

   REGRAS IMUTÁVEIS:
     - Sem sessão → criar nova sessão + iniciar fluxo do início
     - Sessão 'active' → continuar do current_node_id guardado
     - Sessão 'ai_mode' → getAiContext() + _tryAiFallback() (nunca fluxo)
     - Fluxo terminado → completeSession() → estado 'ai_mode'
     - O fluxo NUNCA reinicia automaticamente por nenhum motivo

   ALTERAÇÃO CRÍTICA (FASE 3.2.1): este módulo NUNCA MAIS procura
   published/draft/publishedFlow/currentPublishedFlow. O fluxo a
   executar é sempre o activeFlowId do número que recebeu a mensagem
   (ver server/engine/flows.js → getActiveFlowForChannel). Se não
   houver activeFlowId definido, a mensagem é ignorada (decisão de
   produto: o utilizador deve escolher um fluxo em "Gerir Canal" antes
   do número responder automaticamente).

   Este módulo NÃO conhece detalhes do Baileys — fala apenas com
   manager.js através da função sendMessage injectada em init().
   ══════════════════════════════════════════════════════════════════════ */

const flows         = require('./flows');
const conversations = require('./conversations');
const graph          = require('./graph');
const executors      = require('./executors');
const logger         = require('./logger');
const inbox          = require('./inbox'); // FASE 4.0 — observador da Inbox (não participa na execução)
const delayExecutor  = require('./executors/delay'); // FASE 5 — injectar callback após init()
const ai             = require('./ai');        // FASE IA — fallback Gemini Flash
const aiHistory      = require('./aiHistory'); // FASE IA — histórico de conversa
const { checkPlanAccess, FEATURES } = require('../plans'); // Controlo de acesso por plano
const { checkCredits, consumeCredits, logAiUsage, checkRateLimit } = require('../credits'); // Sistema de créditos IA
const {
  getSession,
  createSession,
  updateSessionNode,
  completeSession,
  getAiContext,
  saveMessage,
} = require('../sessions'); // FASE 5 — Sistema de sessões

let _sendMessageFn = null; // injectado: (uid, phone, text) => Promise<void>

/**
 * Inicializa o motor com as dependências externas necessárias.
 * Chamado uma vez a partir de server/index.js, depois do Firebase Admin
 * e do manager.js estarem prontos.
 * @param {import('firebase-admin').firestore.Firestore} db
 * @param {(uid: string, phone: string, text: string) => Promise<void>} sendMessageFn
 */
function init(db, sendMessageFn) {
  flows.setFirestore(db);
  conversations.setFirestore(db);
  inbox.setFirestore(db); // FASE 4.0
  ai.setFirestore(db);        // FASE IA
  aiHistory.setFirestore(db); // FASE IA
  _sendMessageFn = sendMessageFn;

  // Módulo de créditos IA — inicializar com Firestore
  const credits = require('../credits');
  credits.setFirestore(db);

  // FASE 5 — inicializar módulo de sessões
  const sessions = require('../sessions');
  sessions.setFirestore(db);

  // FASE 5 — injectar callback no delay executor para evitar dependência circular
  delayExecutor.setFirestore(db);
  delayExecutor.setResumeCallback(_resumeFromDelay);
  // Injectar sendPresence para indicador "a digitar" durante delays.
  // BUGFIX: antes apontava para manager.js no processo principal, cuja
  // tabela de sessões está sempre vazia — as ligações reais vivem nos
  // workers subprocess geridos por workerPool.js. Isto fazia o indicador
  // "a digitar" nunca aparecer, sem erro nenhum (falha silenciosa).
  const workerPool = require('../whatsapp/workerPool');
  delayExecutor.setSendPresence(workerPool.sendPresence);

  console.info('[Engine] WorkflowEngine inicializado.');
}

// Limite de segurança: nunca executar mais que N nós num único turno,
// para nunca entrar em loop infinito por um fluxo mal desenhado (ex.:
// ciclo entre dois nós de saída única sem nenhum nó de espera entre eles).
const MAX_STEPS_PER_TURN = 25;

/**
 * Ponto de entrada principal — chamado pelo manager.js sempre que uma
 * mensagem de texto é recebida no WhatsApp.
 * @param {string} uid    workspace (Firebase UID do dono da conexão)
 * @param {{phone: string, text: string, timestamp: number}} message
 */
async function handleIncoming(sessionId, message) {
  // sessionId pode ser "uid" (legado) ou "uid_whatsapp_1"/"uid_whatsapp_2" (multi-slot)
  let uid  = sessionId;
  let slot = 'whatsapp_1';
  const slotMatch = sessionId.match(/^(.+)_(whatsapp_[12])$/);
  if (slotMatch) { uid = slotMatch[1]; slot = slotMatch[2]; }

  const { phone, remoteJid, text, timestamp, type, mediaUrl, mediaMime, pushName, isGroup, groupJid, participantPhone, participantPushName } = message;

  if (!phone) return;

  // ── FASE 4 — Grupos: gravar sempre na Inbox, executar só se configurado ──
  if (isGroup) {
    console.info(`[GROUP] Grupo detectado — jid: ${phone} | participante: ${participantPhone || 'desconhecido'}`);

    // Gravar na Inbox (sempre, independentemente da config do fluxo)
    inbox.recordIncoming(uid, {
      phone, text, type, mediaUrl, mediaMime, pushName, timestamp,
      isGroup: true, groupJid: phone,
      participantPhone, participantPushName,
    }).catch(e => logger.error(uid, phone, `[Inbox][GROUP] Erro em recordIncoming: ${e.message}`));

    // Verificar se o fluxo activo permite responder a grupos
    const groupFlow = await flows.getActiveFlowForChannel(uid, 'whatsapp');
    if (!groupFlow) {
      console.info(`[GROUP] Fluxo bloqueado — nenhum fluxo ativo (uid: ${uid})`);
      return;
    }

    // Ler a configuração allowGroups do nó INÍCIO do fluxo
    const triggerNode = (groupFlow.nodes || []).find(n => n.type === 'inicio');
    const allowGroups = triggerNode?.data?.allowGroups === true;

    if (!allowGroups) {
      console.info(`[GROUP] Fluxo bloqueado — "Responder em grupos" = Não (uid: ${uid}, grupo: ${phone})`);
      return;
    }

    console.info(`[GROUP] Fluxo permitido — a executar fluxo para grupo: ${phone} (uid: ${uid})`);
    // Executar o fluxo normalmente (phone = groupJid, mensagem vai para o grupo)
    // A execução continua abaixo como se fosse uma conversa privada
  } else {
    // ── Conversa privada — comportamento original ──────────────────────
    // Inbox é OBSERVADORA: regista antes de qualquer decisão do motor.
    inbox.recordIncoming(uid, { phone, text, type, mediaUrl, mediaMime, pushName, timestamp })
      .catch(e => logger.error(uid, phone, `[Inbox] Erro em recordIncoming: ${e.message}`));
  }

  if (typeof text !== 'string') return; // mensagens não-texto — fora do âmbito do motor nesta fase

  logger.received(uid, phone, text);

  // ── FASE 5 — Guardar mensagem do utilizador no histórico da sessão ───
  // Feito antes de qualquer decisão de routing, para garantir que a
  // mensagem é sempre registada independentemente do estado da sessão
  // ou do plano — mesmo contas suspensas têm as mensagens gravadas.
  saveMessage(uid, phone, 'user', text).catch(e => {
    logger.error(uid, phone, `[Sessions] Erro ao guardar mensagem user: ${e.message}`);
  });

  // ── Verificação de plano: execução de fluxos ─────────────────────────
  // Contas suspensas não recebem respostas automáticas (nem fluxos nem IA).
  // Contas Trial podem executar fluxos mas não têm acesso à IA.
  // Esta verificação é APÓS o saveMessage — a mensagem fica sempre gravada.
  const { allowed: canExecuteFlow, plan: currentPlan } = await checkPlanAccess(uid, FEATURES.WORKFLOW_EXECUTION);
  if (!canExecuteFlow) {
    logger.info(uid, phone,
      `[Plans] Execução bloqueada — conta suspensa (plano: ${currentPlan}). Mensagem gravada.`);
    return;
  }

  // ── FASE 5 — Verificar estado da sessão ──────────────────────────────
  // Esta verificação é ANTERIOR à busca do fluxo activo.
  // Se a sessão estiver em 'ai_mode', a IA responde directamente
  // sem nunca consultar o fluxo — regra imutável.
  const existingSession = await getSession(uid, phone);

  if (existingSession && existingSession.state === 'ai_mode') {
    logger.info(uid, phone,
      '[Sessions] Sessão em ai_mode — a encaminhar directamente para a IA.');

    const sendMsgFn = async (msgText) => {
      if (!_sendMessageFn) return;
      await _sendMessageFn(uid, phone, msgText);
      logger.sent(uid, phone, msgText);
      inbox.recordOutgoing(uid, phone, { type: 'text', text: msgText }).catch(() => {});
      // Guardar resposta da IA no histórico da sessão
      saveMessage(uid, phone, 'assistant', msgText).catch(e => {
        logger.error(uid, phone, `[Sessions] Erro ao guardar mensagem assistant: ${e.message}`);
      });
    };

    // Obter contexto da sessão para a IA (business description, nome do cliente, últimas mensagens)
    const aiContext = await getAiContext(uid, phone);
    await _tryAiFallback(uid, phone, text, sendMsgFn, aiContext);
    return;
  }

  // ── Buscar fluxo activo ───────────────────────────────────────────────
  // FASE 3.2.1 — ALTERAÇÃO CRÍTICA: já não se procura "fluxo publicado".
  // Lê-se directamente o activeFlowId associado a este número (canal
  // 'whatsapp' — preparado para múltiplos números no futuro, Parte 8).
  const activeFlow = await flows.getActiveFlowForChannel(uid, 'whatsapp');
  if (!activeFlow) {
    logger.info(uid, phone, 'Nenhum fluxo ativo — a tentar fallback IA.');
    const sendMsgFn = async (msgText) => {
      if (!_sendMessageFn) return;
      await _sendMessageFn(uid, phone, msgText);
      logger.sent(uid, phone, msgText);
      inbox.recordOutgoing(uid, phone, { type: 'text', text: msgText }).catch(() => {});
      saveMessage(uid, phone, 'assistant', msgText).catch(e => {
        logger.error(uid, phone, `[Sessions] Erro ao guardar mensagem assistant: ${e.message}`);
      });
    };
    await _tryAiFallback(uid, phone, text, sendMsgFn);
    return;
  }

  // FASE 4.0 — manter a coluna "Fluxo activo" da Inbox sincronizada.
  // Puramente informativo para a UI; não influencia qual fluxo é executado.
  inbox.setActiveFlow(uid, phone, activeFlow.flowId || null).catch(e => {
    logger.error(uid, phone, `[Inbox] Erro em setActiveFlow: ${e.message}`);
  });

  const flowDoc = { nodes: activeFlow.nodes || [], connections: activeFlow.connections || [] };
  // ─────────────────────────────────────────────────────────────────

  let conv = await conversations.getOrCreate(uid, phone);

  // ── FASE 5 — Gerir sessão activa ────────────────────────────────────
  // Se não existe sessão (ou foi resetada pelo admin), criar uma nova.
  // Se já existe sessão 'active', continuar do current_node_id guardado.
  let session = existingSession;

  if (!session) {
    // Sessão nova: encontrar o nó inicial do fluxo
    const firstNode = graph.findTriggerNode(flowDoc);
    const firstNodeId = firstNode ? String(firstNode.nodeId) : null;

    if (!firstNodeId) {
      logger.warn(uid, phone, '[Sessions] Fluxo ativo não tem nó de Início — sessão não criada.');
    } else {
      session = await createSession(uid, phone, activeFlow.flowId, firstNodeId);
      logger.info(uid, phone,
        `[Sessions] Nova sessão criada — flow: ${activeFlow.flowId} | nó inicial: ${firstNodeId}`);
    }
  } else {
    logger.info(uid, phone,
      `[Sessions] Sessão existente (state: ${session.state}) — a continuar do nó ${session.current_node_id}`);
  }

  const sendMessage = async (msgText) => {
    if (!_sendMessageFn) {
      logger.error(uid, phone, 'sendMessage não disponível (manager.js não injectou a função).');
      return;
    }
    logger.info(uid, phone, `[SEQ][H] sendMessage() chamado no engine | t=${Date.now()} | text="${msgText.slice(0,40)}"`);
    await _sendMessageFn(uid, phone, msgText);
    logger.info(uid, phone, `[SEQ][I] sendMessage() concluído | t=${Date.now()}`);
    logger.sent(uid, phone, msgText);
    // FASE 4.0 — Inbox observa também a resposta do bot, sem alterar
    // em nada o comportamento de envio em si.
    inbox.recordOutgoing(uid, phone, { type: 'text', text: msgText }).catch(e => {
      logger.error(uid, phone, `[Inbox] Erro em recordOutgoing (wrapper): ${e.message}`);
    });
    // FASE 5 — Guardar resposta no histórico da sessão
    saveMessage(uid, phone, 'assistant', msgText).catch(e => {
      logger.error(uid, phone, `[Sessions] Erro ao guardar mensagem assistant: ${e.message}`);
    });
  };

  // ── Conversa pendente de resposta a uma 'pergunta' ──────────────────
  // FASE 3.2.7: a mensagem actual é a resposta do utilizador, não um
  // novo turno. Guarda-se automaticamente na variável certa e o fluxo
  // avança a partir do nó SEGUINTE à pergunta — sem o utilizador final
  // do Korvex (quem desenha o fluxo) ter de configurar nada extra.
  let resumeNode = null;
  if (conv.awaitingInput) {
    const waitingNode = flowDoc.nodes.find(n => String(n.nodeId) === String(conv.awaitingInput));

    if (waitingNode && waitingNode.type === 'pergunta') {
      // ── PERGUNTA: guardar variável + avançar ────────────────────────
      const askQuestion = require('./executors/ask_question');
      const varName = askQuestion.variableNameFor(waitingNode);
      conv.variables = await conversations.setVariable(uid, phone, conv.variables, varName, text);
      await conversations.setAwaitingInput(uid, phone, null);
      conv.awaitingInput = null;

      resumeNode = graph.getNextNode(waitingNode.nodeId, flowDoc);
      if (!resumeNode) {
        logger.info(uid, phone, `Pergunta ${waitingNode.nodeId} respondida mas sem nó seguinte conectado — turno terminado.`);
        // FASE 5 — actualizar sessão com variáveis actualizadas
        await updateSessionNode(uid, phone, String(waitingNode.nodeId), conv.variables);
        return;
      }

    } else if (waitingNode && waitingNode.type === 'salvar') {
      // ── SALVAR: guardar variável automaticamente + avançar ─────────
      const existing = Object.keys(conv.variables || {}).filter(k => /^resposta_\d+$/.test(k));
      const key = 'resposta_' + (existing.length + 1);
      conv.variables = await conversations.setVariable(uid, phone, conv.variables, key, text);
      await conversations.setAwaitingInput(uid, phone, null);
      conv.awaitingInput = null;
      logger.info(uid, phone, `[SALVAR] Resposta guardada em {{${key}}} = "${text.slice(0,60)}"`);

      resumeNode = graph.getNextNode(waitingNode.nodeId, flowDoc);
      if (!resumeNode) {
        logger.info(uid, phone, `[SALVAR] Nó sem saída — turno terminado.`);
        // FASE 5 — actualizar sessão com variáveis actualizadas
        await updateSessionNode(uid, phone, String(waitingNode.nodeId), conv.variables);
        return;
      }
      logger.info(uid, phone, `[SALVAR] Fluxo retomado a partir do nó ${resumeNode.nodeId}.`);

    } else if (waitingNode && waitingNode.type === 'aguardar') {
      // ── AGUARDAR: resposta recebida — avançar sem guardar variável ──
      logger.info(uid, phone, `[WAIT] Resposta recebida para nó ${waitingNode.nodeId}.`);
      await conversations.setAwaitingInput(uid, phone, null);
      conv.awaitingInput = null;

      resumeNode = graph.getNextNode(waitingNode.nodeId, flowDoc);
      if (!resumeNode) {
        logger.info(uid, phone, `[WAIT] Fluxo retomado mas sem nó seguinte conectado — turno terminado.`);
        // FASE 5 — actualizar sessão
        await updateSessionNode(uid, phone, String(waitingNode.nodeId), conv.variables || {});
        return;
      }
      logger.info(uid, phone, `[WAIT] Fluxo retomado a partir do nó ${resumeNode.nodeId}.`);

    }
    // Se o nó referenciado já não existir (fluxo editado entretanto),
    // cai-se naturalmente para o fluxo normal abaixo.
  }

  // ── Determinar o nó de partida deste turno ──────────────────────────
  let currentNode = resumeNode;

  if (!currentNode && session && session.state === 'active' && session.current_node_id) {
    // FASE 5 — usar o nó guardado na SESSÃO (não em conversations.js).
    // Continua exactamente do último nó, independentemente do tempo passado.
    // Verifica que o nó ainda existe no fluxo (pode ter sido apagado numa edição).
    const sessionNode = flowDoc.nodes.find(
      n => String(n.nodeId) === String(session.current_node_id)
    );
    if (sessionNode) {
      currentNode = sessionNode;
      logger.info(uid, phone,
        `[Sessions] A continuar sessão do nó ${session.current_node_id} (guardado na sessão).`);
    } else {
      logger.warn(uid, phone,
        `[Sessions] Nó ${session.current_node_id} da sessão não encontrado no fluxo — a recomeçar do início.`);
    }
  }

  if (!currentNode && conv.currentNode && conv.flowId === activeFlow.flowId) {
    // Fallback para conversations.js (compatibilidade com sessões anteriores
    // à Fase 5 que ainda não têm o campo session.current_node_id).
    currentNode = flowDoc.nodes.find(n => String(n.nodeId) === String(conv.currentNode));
  }

  if (!currentNode) {
    // Conversa nova, fluxo activo trocado, ou nó guardado já não existe
    // (FASE 3.2.5 — executar automaticamente o nó Início).
    currentNode = graph.findTriggerNode(flowDoc);
    if (!currentNode) {
      logger.warn(uid, phone, 'Fluxo ativo não tem nó de Início — abortado.');
      return;
    }
  }

  // Se há um delay activo para este contacto, ignorar a mensagem.
  // O delay é intransponível — mensagens recebidas durante um delay não reiniciam o fluxo.
  if (delayExecutor.hasActiveDeley(uid, phone)) {
    logger.info(uid, phone, '[DELAY] Mensagem recebida durante delay activo — ignorada.');
    return;
  }

  await _runFromNode({
    uid, phone, remoteJid: remoteJid || null,
    flow: flowDoc, flowId: activeFlow.flowId,
    conv, session,
    startNode: currentNode, incomingText: text, sendMessage,
  });
}

/**
 * Executa nós em sequência a partir de startNode, seguindo as conexões,
 * até parar num ponto seguro: nó 'pergunta' (espera resposta), nó
 * 'encerrar' (fim), ou nó terminal sem saída.
 * @param {object} params
 */
async function _runFromNode({ uid, phone, remoteJid, flow, flowId, conv, session, startNode, incomingText, sendMessage }) {
  let node = startNode;
  let steps = 0;
  let lastPort; // porta de saída a usar na próxima navegação (ex.: 'Sim'/'Não' — preparado para a condição da fase seguinte)

  while (node && steps < MAX_STEPS_PER_TURN) {
    steps++;

    const _hint = _executorHintFor(node);
    const executor = executors.get(_hint);
    logger.info(uid, phone, `[RUN][1] step=${steps} | nodeId=${node.nodeId} | type=${node.type} | hint=${_hint} | executor=${executor ? 'OK' : 'NULL'}`);

    if (!executor) {
      logger.error(uid, phone, `[RUN][ERR] Executor NULL para hint="${_hint}" (type="${node.type}") — a parar loop.`);
      break;
    }

    const ctx = {
      uid, phone, remoteJid, node, flow, flowId,
      variables: conv.variables || {},
      incomingText,
      sendMessage,
    };

    let result;
    logger.info(uid, phone, `[RUN][2] A chamar executor.execute() | nodeId=${node.nodeId} | t=${Date.now()}`);
    try {
      result = await executor.execute(ctx);
      logger.info(uid, phone, `[RUN][3] executor.execute() retornou | nodeId=${node.nodeId} | result=${JSON.stringify(result)} | t=${Date.now()}`);
    } catch (e) {
      logger.error(uid, phone, `[RUN][ERR] Excepção em executor.execute() | nodeId=${node.nodeId} | ${e.message}`);
      logger.error(uid, phone, `Erro ao executar nó ${node.nodeId} (${node.type}): ${e.message}`);
      break;
    }

    // Se o executor atualizou variáveis (ex.: save_var), propagar em memória
    if (result?.updatedVariables) conv.variables = result.updatedVariables;

    // Persistir sempre o nó actual após executar (mesmo antes de saber o próximo,
    // para nunca perder a posição se o processo cair entre passos).

    // FASE 5 — sincronizar sessão com o nó actual e variáveis actualizadas
    await updateSessionNode(uid, phone, String(node.nodeId), conv.variables || {});

    if (result?.isEnd) {
      logger.info(uid, phone, `[RUN][4] result.isEnd=true → a encerrar fluxo`);
      await conversations.reset(uid, phone);
      // FASE 5 — transitar sessão para ai_mode (NUNCA volta ao fluxo sem reset manual)
      await completeSession(uid, phone);
      logger.info(uid, phone,
        '[Sessions] Fluxo encerrado — sessão transitou para ai_mode. A IA responde a partir de agora.');
      return;
    }

    if (result?.awaitingInput) {
      logger.info(uid, phone, `[RUN][4] result.awaitingInput=true → a suspender fluxo`);
      logger.info(uid, phone, `[WAIT] Fluxo suspenso no nó ${node.nodeId} — aguardando resposta.`);
      return;
    }

    if (result?.isDelay) {
      logger.info(uid, phone, `[RUN][4] result.isDelay=true → a pausar para delay`);
      logger.info(uid, phone, `[DELAY] Motor pausado no nó ${node.nodeId} — delay agendado.`);
      return;
    }

    logger.info(uid, phone, `[RUN][5] A chamar getNextNode | nodeId=${node.nodeId} | lastPort=${lastPort}`);
    const next = graph.getNextNode(node.nodeId, flow, lastPort);
    lastPort = undefined;
    logger.info(uid, phone, `[RUN][6] getNextNode retornou | next=${next ? next.nodeId + ' (' + next.type + ')' : 'NULL'}`);

    if (!next) {
      await conversations.reset(uid, phone);
      // FASE 5 — sem nó seguinte = fluxo terminou → ai_mode
      await completeSession(uid, phone);
      logger.info(uid, phone,
        `[Sessions] Nó ${node.nodeId} sem saída conectada — sessão transitou para ai_mode.`);
      return;
    }

    node = next;
    logger.info(uid, phone, `[RUN][7] Próxima iteração → nodeId=${node.nodeId} | type=${node.type}`);
  }

  if (steps >= MAX_STEPS_PER_TURN) {
    logger.warn(uid, phone, `Limite de ${MAX_STEPS_PER_TURN} passos atingido neste turno — possível ciclo no fluxo. A parar por segurança.`);
  }
}

/**
 * Resolve o executorHint de um nó. Tenta usar node.executorHint se já
 * vier no documento; caso contrário, mapeia a partir do node.type com
 * a mesma tabela usada por NodeTypeRegistry no frontend (js/repository.js),
 * para não depender de um campo que pode não existir em documentos
 * gravados antes desta fase.
 * @param {object} node
 * @returns {string}
 */
const _TYPE_TO_HINT = {
  inicio:      'trigger',
  mensagem:    'send_text',
  imagem:      'send_image',
  video:       'send_video',
  audio:       'send_audio',
  documento:   'send_document',
  pergunta:    'ask_question',
  aguardar:    'wait_reply',
  delay:       'delay',      // FASE 5.4 — estava em falta no mapa de tipos
  salvar:      'save_var',
  botao:       'send_buttons',
  lista:       'send_list',
  condicao:    'condition',
  webhook:     'http_request',
  api:         'api_call',
  tag:         'crm_tag_add',
  removertag:  'crm_tag_remove',
  encerrar:    'end_flow',
};

function _executorHintFor(node) {
  // Se o nó tem _items com sub-tipos (bloco composto), usar executor composite.
  // Um bloco é composto se tem _items com pelo menos um item não-mensagem,
  // ou se tem mais do que um item (texto + delay, texto + texto, etc.).
  const items = node.settings && node.settings._items;
  if (Array.isArray(items) && items.length > 0) {
    const hasNonText = items.some(it => it.type !== 'mensagem');
    if (hasNonText || items.length > 1) return 'composite';
  }
  return node.executorHint || _TYPE_TO_HINT[node.type] || null;
}

/**
 * Invalida a cache do fluxo ativo de um canal — chamado via rota
 * POST /whatsapp/flow-changed sempre que o utilizador troca o Fluxo
 * Ativo de um número em "Gerir Canal", para a mudança ter efeito
 * imediato na próxima mensagem em vez de esperar pelo TTL da cache.
 * @param {string} uid
 * @param {string} [channelDoc='whatsapp']
 */

/**
 * FASE IA — Fallback inteligente com Gemini Flash.
 * Chamado quando não há fluxo activo para responder à mensagem,
 * ou quando a sessão está em estado 'ai_mode'.
 * Se o cliente não tiver IA configurada ou a chave não existir, não faz nada.
 *
 * BLOQUEIO DE PLANO: se a conta for Trial, a IA é interceptada AQUI,
 * ao nível do middleware, antes de qualquer chamada ao modelo.
 * Esta verificação é server-side e não pode ser contornada pelo cliente.
 *
 * SISTEMA DE CRÉDITOS: antes de chamar o modelo, verifica saldo disponível.
 * Após resposta, consome créditos reais (tokens da API) e regista o uso.
 *
 * RATE LIMIT: controla requests/minuto por conta em memória.
 *
 * FASE 5 — CONTEXTO DA SESSÃO: quando chamado em ai_mode, recebe o
 * contexto da sessão (businessDescription, clientName, lastMessages)
 * para enriquecer o system prompt da IA com informação relevante.
 *
 * @param {string}   uid
 * @param {string}   phone
 * @param {string}   incomingText
 * @param {Function} sendMessage
 * @param {object}   [sessionContext]  { businessDescription, clientName, lastMessages }
 */
async function _tryAiFallback(uid, phone, incomingText, sendMessage, sessionContext) {
  // ── 0. Verificação de bloqueio de IA por cliente (admin) ─────────────
  // Se o administrador bloqueou a IA para este cliente específico,
  // retornar silenciosamente sem consumir créditos nem chamar o modelo.
  // Esta verificação é feita ANTES de qualquer outra — tem precedência
  // sobre planos, créditos e rate limit.
  try {
    // BUGFIX: antes fazia 2 leituras de getSession() sempre que
    // sessionContext já vinha preenchido (o caso mais comum — toda
    // mensagem em ai_mode passa por aqui), apesar do comentário dizer
    // que evitava a leitura redundante. Agora há sempre só uma leitura,
    // reaproveitada tanto para a verificação de ai_blocked como, mais
    // abaixo, implicitamente coberta pelo sessionContext já carregado.
    const sessionData = await getSession(uid, phone);
    if (sessionData && sessionData.ai_blocked === true) {
      logger.info(uid, phone,
        '[AI] Bloqueado pelo administrador (ai_blocked=true) — IA silenciada para este cliente.');
      return;
    }
  } catch (e) {
    logger.error(uid, phone, `[AI] Erro ao verificar ai_blocked: ${e.message}`);
    // Em caso de erro na verificação, prosseguir normalmente (fail-open)
  }

  // ── 1. Verificação de plano — intercepção antes de chegar ao modelo ──
  const { allowed: planAllowed, plan } = await checkPlanAccess(uid, FEATURES.AI);
  if (!planAllowed) {
    logger.info(
      uid, phone,
      `[AI] Bloqueado pelo middleware de planos — plano "${plan}" não inclui IA.`
    );
    return; // Silencioso: o utilizador Trial não recebe qualquer mensagem de erro
  }

  // ── 2. Verificação de créditos (saldo mensal + diário) ───────────────
  const { allowed: creditsAllowed, reason: creditsReason } = await checkCredits(uid);
  if (!creditsAllowed) {
    logger.info(uid, phone, `[AI] Bloqueado por créditos insuficientes — ${creditsReason}`);
    return; // Silencioso: não enviar mensagem de erro ao utilizador final
  }

  // ── 3. Rate limit persistente no Firestore (requests por minuto) ─────
  const { allowed: rateAllowed, reason: rateReason } = await checkRateLimit(uid);
  if (!rateAllowed) {
    logger.info(uid, phone, `[AI] Rate limit atingido — ${rateReason}`);
    return;
  }

  // ── 4. Chamar o modelo Gemini ─────────────────────────────────────────
  try {
    // FASE 5 — Quando em ai_mode, usar o histórico da sessão (últimas 5 mensagens)
    // em vez do histórico completo do aiHistory. Isto dá contexto mais relevante.
    let history;
    if (sessionContext && sessionContext.lastMessages && sessionContext.lastMessages.length > 0) {
      // Converter mensagens da sessão para o formato esperado pelo ai.js
      history = sessionContext.lastMessages.map(m => ({
        role: m.role === 'user' ? 'incoming' : 'outgoing',
        text: m.content,
      }));
      logger.info(uid, phone,
        `[AI] Contexto da sessão carregado — ${history.length} mensagens recentes.`);
    } else {
      history = await aiHistory.getRecentHistory(uid, phone);
    }

    const callStartMs = Date.now();
    const result = await ai.generateReplyWithUsage(uid, phone, incomingText, history);
    const durationMs = Date.now() - callStartMs;

    if (!result) {
      logger.info(uid, phone, '[AI] Fallback sem resposta — mensagem ignorada silenciosamente.');
      return;
    }

    const { reply, inputTokens, outputTokens, model } = result;

    if (reply) {
      await sendMessage(reply);
      logger.info(uid, phone, '[AI] Fallback respondeu com sucesso.');
    } else {
      logger.info(uid, phone, '[AI] Fallback sem resposta — mensagem ignorada silenciosamente.');
      return;
    }

    // ── 5. Consumir créditos com tokens reais da API ───────────────────
    try {
      await consumeCredits(uid, inputTokens || 0, outputTokens || 0);
    } catch (e) {
      logger.error(uid, phone, `[AI] Erro ao consumir créditos: ${e.message}`);
    }

    // ── 6. Registar uso na subcolecção ai_usage_logs ───────────────────
    try {
      await logAiUsage(uid, phone, inputTokens || 0, outputTokens || 0, model || 'gemini-2.5-flash', durationMs);
    } catch (e) {
      logger.error(uid, phone, `[AI] Erro ao registar uso: ${e.message}`);
    }

  } catch (e) {
    logger.error(uid, phone, `[AI] Erro no fallback: ${e.message}`);
  }
}

function invalidateFlowCache(uid, channelDoc) {
  flows.invalidate(uid, channelDoc);
}

/**
 * FASE 5 — Retomar fluxo após um delay expirar.
 * Chamado pelo delay.js quando o setTimeout dispara (ou na recuperação
 * após restart). Carrega o fluxo e a conversa e executa a partir de nextNodeId.
 * @param {string} uid
 * @param {string} phone
 * @param {string} flowId
 * @param {string} nextNodeId
 */
async function _resumeFromDelay(uid, phone, flowId, nextNodeId, remoteJid) {
  logger.info(uid, phone, `[DELAY] Executado — a retomar fluxo a partir do nó ${nextNodeId}`);

  const activeFlow = await flows.getActiveFlowForChannel(uid, 'whatsapp');
  if (!activeFlow) {
    logger.warn(uid, phone, '[DELAY] Nenhum fluxo ativo ao retomar — delay abandonado.');
    return;
  }

  const flowDoc = { nodes: activeFlow.nodes || [], connections: activeFlow.connections || [] };
  const startNode = flowDoc.nodes.find(n => String(n.nodeId) === String(nextNodeId));
  if (!startNode) {
    logger.warn(uid, phone, `[DELAY] Nó ${nextNodeId} não encontrado no fluxo — delay abandonado.`);
    return;
  }

  const conv = await conversations.getOrCreate(uid, phone);
  // FASE 5 — carregar sessão actual para passar ao _runFromNode
  const session = await getSession(uid, phone);

  const sendMessage = async (msgText) => {
    if (!_sendMessageFn) return;
    await _sendMessageFn(uid, phone, msgText);
    logger.sent(uid, phone, msgText);
    inbox.recordOutgoing(uid, phone, { type: 'text', text: msgText }).catch(() => {});
    // FASE 5 — guardar resposta no histórico da sessão
    saveMessage(uid, phone, 'assistant', msgText).catch(e => {
      logger.error(uid, phone, `[Sessions] Erro ao guardar mensagem assistant (delay): ${e.message}`);
    });
  };

  await _runFromNode({
    uid, phone,
    remoteJid: remoteJid || null,
    flow:   flowDoc,
    flowId: activeFlow.flowId,
    conv,
    session,
    startNode,
    incomingText: '',
    sendMessage,
  });
}

module.exports = { init, handleIncoming, invalidateFlowCache, _resumeFromDelay };
