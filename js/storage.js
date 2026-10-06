const FlowSerializer = (() => {

  function _nodeToSchema(n) {
    const now = new Date().toISOString();
    return {
      nodeId:    String(n.id),
      type:      n.t,
      name:      n.lbl || n.t,
      settings:  n.data ? { ...n.data } : {},
      position:  { x: n.x, y: n.y },
      createdAt: n._createdAt || now,
      updatedAt: now,
    };
  }

  function _nodeFromSchema(s) {
    return {
      id:         parseInt(s.nodeId, 10),
      t:          s.type,
      lbl:        s.name,
      x:          s.position.x,
      y:          s.position.y,
      data:       s.settings ? { ...s.settings } : {},
      _createdAt: s.createdAt,
    };
  }

  function _connToSchema(e) {
    return {
      connectionId:   String(e.id),
      sourceNodeId:   String(e.fr),
      targetNodeId:   String(e.to),
      sourcePort:     e.fp || 'out',
      createdAt:      e._createdAt || new Date().toISOString(),
    };
  }

  function _connFromSchema(s) {
    return {
      id:         parseInt(s.connectionId, 10),
      fr:         parseInt(s.sourceNodeId, 10),
      to:         parseInt(s.targetNodeId, 10),
      fp:         s.sourcePort || 'out',
      _createdAt: s.createdAt,
    };
  }

  /**
   * Serializa o estado interno (nodes[], edges[], meta) numa estrutura
   * canónica pronta para guardar / enviar ao Firebase.
   * FASE 3.2.1 — já não inclui status/publishedAt/archivedAt: não existe
   * mais o conceito de fluxo publicado. Todos os fluxos são apenas
   * guardados (Auto Save / Salvar) e ficam disponíveis para serem
   * escolhidos como "Fluxo Ativo" de um número de WhatsApp (ver
   * js/connections.js).
   */
  function serialize(nodes, edges, meta) {
    const now = new Date().toISOString();
    return {
      flowId:      meta.flowId      || _generateId('flow'),
      workspaceId: meta.workspaceId || AuthService.getUserId(), // FASE 3.0.7
      userId:      meta.userId      || AuthService.getUserId(), // FASE 3.0.7
      name:        meta.name        || 'Sem título',
      description: meta.description || '',
      nodes:       nodes.map(_nodeToSchema),
      connections: edges.map(_connToSchema),
      createdAt:   meta.createdAt   || now,
      updatedAt:   now,
      version:     (meta.version    || 0) + 1,
    };
  }

  /**
   * Deserializa uma estrutura canónica para arrays internos nodes[], edges[].
   */
  function deserialize(doc) {
    const nodes = (doc.nodes       || []).map(_nodeFromSchema);
    const edges = (doc.connections || []).map(_connFromSchema);
    const meta  = {
      flowId:      doc.flowId,
      workspaceId: doc.workspaceId,
      userId:      doc.userId,
      name:        doc.name,
      description: doc.description,
      createdAt:   doc.createdAt,
      version:     doc.version,
    };
    return { nodes, edges, meta };
  }

  function _generateId(prefix) {
    return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  return { serialize, deserialize };
})();


/* ══════════════════════════════════════════════════════════
   FlowValidator
   Verifica integridade antes de guardar.
   Não lança excepções — devolve { valid, errors[] }.
   ══════════════════════════════════════════════════════════ */
const FlowValidator = (() => {

  function validate(doc) {
    const errors = [];

    // ── Campos obrigatórios do fluxo ──
    if (!doc.flowId)      errors.push('flowId em falta');
    if (!doc.workspaceId) errors.push('workspaceId em falta');
    if (!doc.userId)      errors.push('userId em falta');
    if (!doc.name || !doc.name.trim()) errors.push('name não pode estar vazio');

    // ── FASE 3.0.7 — Rejeitar valores placeholder (nunca devem chegar a produção)
    if (doc.userId      === 'local')   errors.push('userId inválido: utilizador não autenticado');
    if (doc.workspaceId === 'default') errors.push('workspaceId inválido: workspace não inicializado');

    // ── Nós ──
    const nodeIds = new Set();
    // FASE 5.3 — Detectar múltiplos nós inicio (bloqueio de save)
    const inicioNodes = (doc.nodes || []).filter(n => n.type === 'inicio');
    console.log(`[FLOW VALIDATION] Inicios encontrados: ${inicioNodes.length}`);
    if (inicioNodes.length > 1) {
      errors.push('Este fluxo possui múltiplos blocos Início. Remova os duplicados.');
    }

    (doc.nodes || []).forEach((n, i) => {
      if (!n.nodeId) {
        errors.push(`Nó [${i}] sem nodeId`);
        return;
      }
      if (nodeIds.has(n.nodeId)) {
        errors.push(`nodeId duplicado: ${n.nodeId}`);
      }
      nodeIds.add(n.nodeId);

      if (!n.type)                       errors.push(`Nó ${n.nodeId} sem type`);
      if (!n.position || n.position.x == null || n.position.y == null) {
        errors.push(`Nó ${n.nodeId} com posição inválida`);
      }
    });

    // ── Conexões ──
    const connIds = new Set();
    (doc.connections || []).forEach((c, i) => {
      if (!c.connectionId) {
        errors.push(`Conexão [${i}] sem connectionId`);
        return;
      }
      if (connIds.has(c.connectionId)) {
        errors.push(`connectionId duplicado: ${c.connectionId}`);
      }
      connIds.add(c.connectionId);

      // Conexões órfãs
      if (!nodeIds.has(c.sourceNodeId)) {
        errors.push(`Conexão ${c.connectionId}: sourceNodeId ${c.sourceNodeId} não existe`);
      }
      if (!nodeIds.has(c.targetNodeId)) {
        errors.push(`Conexão ${c.connectionId}: targetNodeId ${c.targetNodeId} não existe`);
      }

      // Auto-loop
      if (c.sourceNodeId === c.targetNodeId) {
        errors.push(`Conexão ${c.connectionId}: auto-conexão não permitida`);
      }
    });

    return { valid: errors.length === 0, errors };
  }

  return { validate };
})();


/* ══════════════════════════════════════════════════════════
   FlowStorage  —  FASE 3.0.7
   Persistência dupla: localStorage (cache local) + Firestore (fonte de verdade).
   O caminho Firestore usa SEMPRE AuthService.getUserId() como uid,
   nunca doc.workspaceId. Garante isolamento total por utilizador.

   Estrutura Firestore:
     workspaces/{uid}/flows/{flowId}

   API pública (inalterada):
     save(doc)      → Promise<void>
     load(flowId)   → Promise<doc | null>
     loadLatest()   → Promise<doc | null>
     list()         → Promise<[{ flowId, name, updatedAt }]>
     remove(flowId) → Promise<void>
   ══════════════════════════════════════════════════════════ */
const FlowStorage = (() => {

  const NAMESPACE  = 'korvex_v2';
  const INDEX_KEY  = `${NAMESPACE}:index`;

  // ── Helpers localStorage ──────────────────────────────────────────

  function _key(flowId) {
    return `${NAMESPACE}:flow:${flowId}`;
  }

  function _readIndex() {
    try {
      return JSON.parse(localStorage.getItem(INDEX_KEY) || '[]');
    } catch { return []; }
  }

  function _writeIndex(index) {
    try { localStorage.setItem(INDEX_KEY, JSON.stringify(index)); } catch(e) {
      console.error('[FlowStorage] Erro ao escrever índice:', e);
    }
  }

  function _updateIndex(doc) {
    const index = _readIndex();
    const entry = {
      flowId:    doc.flowId,
      name:      doc.name,
      version:   doc.version   || 1,
      updatedAt: doc.updatedAt,
    };
    const pos = index.findIndex(i => i.flowId === doc.flowId);
    if (pos >= 0) index[pos] = entry; else index.push(entry);
    _writeIndex(index);
  }

  // ── Helper Firestore ──────────────────────────────────────────────
  // Devolve referência ao documento do fluxo no Firestore.
  // uid vem SEMPRE de AuthService.getUserId() — nunca de doc.workspaceId.

  function _fsRef(flowId) {
    const db  = FirebaseCore.getDb();
    const uid = AuthService.getUserId();
    if (!db || !uid || uid === 'local') return null;
    return db
      .collection('workspaces').doc(uid)
      .collection('flows').doc(flowId);
  }

  function _fsColRef() {
    const db  = FirebaseCore.getDb();
    const uid = AuthService.getUserId();
    if (!db || !uid || uid === 'local') return null;
    return db.collection('workspaces').doc(uid).collection('flows');
  }

  // ── save ──────────────────────────────────────────────────────────

  async function save(doc) {
    // FASE 3.2 — Guard de subscrição
    if (!SubscriptionService.canAccess()) {
      console.warn('[FlowStorage] Acesso bloqueado — subscrição inactiva');
      return;
    }
    try {
      // 1. Cache local — sempre (funciona offline)
      localStorage.setItem(_key(doc.flowId), JSON.stringify(doc));
      _updateIndex(doc);

      // 2. Firestore — quando autenticado
      const ref = _fsRef(doc.flowId);
      if (ref) {
        await ref.set(doc);
        console.info('[FlowStorage] Guardado no Firestore:', doc.flowId);
      }
    } catch(e) {
      console.error('[FlowStorage] Erro ao guardar:', e);
      throw e;
    }
  }

  // ── load ──────────────────────────────────────────────────────────

  async function load(flowId) {
    // FASE 3.2 — Guard de subscrição
    if (!SubscriptionService.canAccess()) {
      console.warn('[FlowStorage] load() bloqueado — subscrição inactiva');
      return null;
    }
    try {
      // Tentar Firestore primeiro (fonte de verdade)
      const ref = _fsRef(flowId);
      if (ref) {
        const snap = await ref.get();
        if (snap.exists) {
          const data = snap.data();
          // Sincronizar cache local
          localStorage.setItem(_key(flowId), JSON.stringify(data));
          _updateIndex(data);
          return data;
        }
      }
      // Fallback: localStorage (modo offline)
      const raw = localStorage.getItem(_key(flowId));
      return raw ? JSON.parse(raw) : null;
    } catch(e) {
      console.error('[FlowStorage] Erro ao carregar:', e);
      // Fallback offline
      try {
        const raw = localStorage.getItem(_key(flowId));
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    }
  }

  // ── loadLatest ────────────────────────────────────────────────────
  // FASE 3.2.1 — já não filtra/prefere por status (não existe mais
  // 'archived'/'published'/'draft'); devolve sempre o fluxo mais
  // recentemente actualizado.

  async function loadLatest() {
    try {
      // Tentar Firestore: buscar fluxos do utilizador ordenados
      const col = _fsColRef();
      if (col) {
        const snap = await col.orderBy('updatedAt', 'desc').limit(20).get();
        if (!snap.empty) {
          // FASE 3.2.2 — BUG CRÍTICO #1 CORRIGIDO
          // Antes: snap.docs.map(d => d.data()) — usava data.flowId (campo do documento)
          // como flowId canónico. Se esse campo divergisse de d.id (ID real do doc
          // Firestore, e.g. dados legacy ou corrupção anterior), _meta.flowId ficava
          // com o valor errado e o próximo save() chamava _fsRef(valor_errado),
          // criando um segundo documento em /flows/{valor_errado}. O original ficava
          // órfão e nunca mais era actualizado.
          //
          // Agora: d.id é a única fonte de verdade. Todos os documentos são
          // normalizados com { ...data, flowId: d.id } antes de qualquer uso.
          // Isto garante que flowId no documento em memória, no localStorage e em
          // _meta é sempre idêntico ao ID do documento Firestore — mesmo que o
          // campo flowId no documento esteja errado ou ausente.
          const docs = snap.docs.map(d => ({ ...d.data(), flowId: d.id }));
          // Sincronizar índice local com o flowId canónico (d.id)
          const index = docs.map(d => ({
            flowId:     d.flowId,
            name:       d.name,
            version:    d.version    || 1,
            updatedAt:  d.updatedAt,
          }));
          _writeIndex(index);
          // Guardar no localStorage com a chave baseada no flowId canónico (d.id)
          docs.forEach(d => localStorage.setItem(_key(d.flowId), JSON.stringify(d)));

          return docs[0]; // já ordenado por updatedAt desc
        }
        // BUG FIX 3.3.6 — Firestore está acessível mas sem fluxos para este utilizador.
        // Limpar localStorage para garantir que não há fluxos de outra sessão/utilizador.
        _writeIndex([]);
        return null;
      }
    } catch(e) {
      console.error('[FlowStorage] Erro Firestore em loadLatest:', e);
    }

    // Fallback: localStorage (apenas quando Firestore inacessível — modo offline)
    // NUNCA usar como fonte principal quando Firestore está disponível.
    const col = _fsColRef();
    if (col) {
      // Firestore acessível mas falhou acima — não usar localStorage de outra sessão
      _writeIndex([]);
      return null;
    }
    const index = _readIndex();
    if (!index.length) return null;
    const sorted = [...index].sort((a, b) =>
      new Date(b.updatedAt) - new Date(a.updatedAt)
    );
    return load(sorted[0].flowId);
  }

  // ── list ──────────────────────────────────────────────────────────
  // FASE 3.2.3 BUGFIX — dois bugs corrigidos:
  //
  // BUG 1 (LENTIDÃO): a query anterior fazia .get() sem limite sobre
  // a colecção completa, carregando TODOS os documentos com nodes e
  // connections incluídos — centenas de KB por cada fluxo. Agora
  // serve imediatamente o índice do localStorage (já mantido actualizado
  // por save/loadLatest) e refresca do Firestore em background com
  // limit(200) apenas dos campos de metadados necessários.
  //
  // BUG 2 (FLUXOS REPETIDOS): a query anterior usava data.flowId (campo
  // dentro do documento) em vez do ID real do documento Firestore (d.id).
  // Se algum documento foi gravado com flowId inconsistente, aparecia
  // como entrada duplicada ou com flowId undefined. Corrigido usando d.id
  // como chave canónica e deduplicando por flowId antes de devolver.

  async function list(onRefresh) {
    // FASE 3.2 — Guard de subscrição
    if (!SubscriptionService.canAccess()) {
      console.warn('[FlowStorage] list() bloqueado — subscrição inactiva');
      return [];
    }

    // ── Resposta imediata: índice local ──────────────────────────────
    // O índice é mantido actualizado por _updateIndex() (chamado em cada
    // save) e por _writeIndex() (chamado em loadLatest e aqui em background).
    // Serve a lista instantaneamente sem esperar pelo Firestore.
    const cached = _readIndex();

    // ── Refresh em background: Firestore com limite ──────────────────
    // Não bloqueia o render — actualiza o índice e chama onRefresh() se o
    // caller quiser re-renderizar com os dados mais recentes do servidor.
    // Usa limit(200) para evitar leituras ilimitadas.
    const col = _fsColRef();
    if (col) {
      col.orderBy('updatedAt', 'desc').limit(200).get().then(snap => {
        if (snap.empty) {
          _writeIndex([]);
          if (onRefresh) onRefresh([]);
          return;
        }
        // Usar d.id (ID real do documento Firestore) como flowId canónico.
        // Se data.flowId existir e for consistente, usa-o; caso contrário
        // usa d.id para evitar entradas com flowId undefined ou duplicado.
        const seen = new Set();
        const entries = [];
        snap.docs.forEach(d => {
          const data  = d.data();
          const fid   = (data.flowId && data.flowId === d.id) ? data.flowId : d.id;
          if (seen.has(fid)) return; // deduplicar
          seen.add(fid);
          entries.push({
            flowId:    fid,
            name:      data.name      || 'Sem título',
            version:   data.version   || 1,
            updatedAt: data.updatedAt || data.createdAt || null,
          });
        });
        _writeIndex(entries);
        if (onRefresh) onRefresh(entries); // notificar caller para re-render
      }).catch(e => {
        console.error('[FlowStorage] Erro Firestore em list (background):', e);
      });
    }

    // Devolver imediatamente o cache local (pode ser [] na primeira visita)
    return cached;
  }

  // ── remove ────────────────────────────────────────────────────────
  // FASE 3.0.7 — remove tanto do localStorage como do Firestore

  async function remove(flowId) {
    // FASE 3.2 — Guard de subscrição
    if (!SubscriptionService.canAccess()) {
      console.warn('[FlowStorage] remove() bloqueado — subscrição inactiva');
      return;
    }
    try {
      // BUGFIX — apagar Firestore PRIMEIRO, localStorage depois.
      // Ordem anterior (localStorage → Firestore) criava uma race condition:
      // se a aba fechasse entre os dois passos, o Firestore ficava com o flow
      // e no próximo login loadLatest() encontrava-o e ressuscitava-o.
      // Com a ordem invertida, a fonte de verdade (Firestore) é limpa antes
      // de qualquer feedback local.

      // 1. Firestore (fonte de verdade)
      const ref = _fsRef(flowId);
      if (ref) {
        await ref.delete();
        console.info('[FlowStorage] Eliminado do Firestore:', flowId);
      }

      // 2. localStorage (cache local) — só após Firestore confirmado
      localStorage.removeItem(_key(flowId));
      const index = _readIndex().filter(i => i.flowId !== flowId);
      _writeIndex(index);
    } catch(e) {
      console.error('[FlowStorage] Erro ao remover:', e);
      // Tentar limpar localStorage mesmo se Firestore falhou
      try {
        localStorage.removeItem(_key(flowId));
        const index = _readIndex().filter(i => i.flowId !== flowId);
        _writeIndex(index);
      } catch(e2) {}
    }
  }

  return { save, load, loadLatest, list, remove };
})();


/* ══════════════════════════════════════════════════════════
   FlowRepository
   Fonte única de verdade para o fluxo activo.
   O motor do Flow Builder só fala com este módulo.

   API:
     init()                  — carrega estado persistido ou inicia demo
     getNodes()              — devolve array de nós
     getEdges()              — devolve array de conexões
     getMeta()               — devolve metadados do fluxo
     setName(name)           — atualiza nome
     commitState(nodes, edges) — persiste estado após qualquer mutação
   ══════════════════════════════════════════════════════════ */