const FlowPublisher = (() => {

  /* ── Abrir editor com um fluxo específico ── */
  async function openFlow(flowId) {
    const result = await FlowRepository.loadFlow(flowId);
    if (!result) { toast('Erro ao abrir fluxo', 'err'); return; }

    nodes = result.nodes;
    edges = result.edges;
    _rebuildIndex();
    _syncCounters();
    push();

    const meta = FlowRepository.getMeta();
    const nameEl = document.getElementById('fb-name');
    if (nameEl) nameEl.value = meta.name;

    const navFlows = document.querySelector('.nav-item[onclick*="flows-list"]');
    setView('flows', navFlows);
    requestAnimationFrame(() => {
      render(); updateTransform(); drawMini();
      _canvasReady = true;
    });
    toast('A editar: ' + meta.name, 'ok');
  }

  /* ── Criar novo fluxo em branco ── */
  function newFlow() {
    // FASE 3.2 — Guard de subscrição
    if (!SubscriptionService.canAccess()) {
      console.warn('[FlowPublisher] newFlow() bloqueado — subscrição inactiva');
      return;
    }
    // Reset completo do estado do editor
    nodes = []; edges = [];
    sel.clear(); activeId = null; connecting = null; selEdge = null;
    undoStack = []; redoStack = [];
    _nodeIdCounter = 0; _edgeIdCounter = 0;
    NodeMap.clear(); _edgeIdSet.clear();

    // Novo meta
    const flowId    = 'flow_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const createdAt = new Date().toISOString();
    FlowRepository.resetMeta({
      flowId,
      createdAt,
      name:        'Novo fluxo',
      userId:      AuthService.getUserId(), // FASE 3.0.7
      workspaceId: AuthService.getUserId(), // FASE 3.0.7
    });

    const nameEl = document.getElementById('fb-name');
    if (nameEl) nameEl.value = 'Novo fluxo';

    push();

    const navFlows = document.querySelector('.nav-item[onclick*="flows-list"]');
    setView('flows', navFlows);
    requestAnimationFrame(() => {
      render(); updateTransform(); drawMini();
      _canvasReady = true;
    });
    toast('Novo fluxo criado', 'ok');
  }

  /* ── Duplicar fluxo activo (da toolbar) ── */
  function duplicate() {
    const meta    = FlowRepository.getMeta();
    const nameEl  = document.getElementById('fb-name');
    const srcName = nameEl?.value || meta.name;

    const newId  = 'flow_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const now    = new Date().toISOString();

    // FASE 3.2.1 — já não há conceito de status (draft/published/archived)
    const cloneMeta = {
      ...meta,
      flowId:      newId,
      name:        'Cópia de ' + srcName,
      version:     0,
      createdAt:   now,
    };
    const doc = FlowSerializer.serialize(
      JSON.parse(JSON.stringify(nodes)),
      JSON.parse(JSON.stringify(edges)),
      cloneMeta
    );
    FlowStorage.save(doc).then(() => {
      toast('Fluxo duplicado — "Cópia de ' + srcName + '" guardado', 'ok');
    });
  }

  /* ── Duplicar fluxo da lista ── */
  async function duplicateFromList(flowId) {
    const doc = await FlowStorage.load(flowId);
    if (!doc) { toast('Erro ao duplicar', 'err'); return; }
    const newId = 'flow_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const now   = new Date().toISOString();
    const clone = {
      ...doc,
      flowId:      newId,
      name:        'Cópia de ' + doc.name,
      version:     1,
      createdAt:   now,
      updatedAt:   now,
    };
    await FlowStorage.save(clone);
    toast('Fluxo duplicado', 'ok');
    FlowListView.render();
  }

  /* ── Apagar fluxo da lista ── */
  async function deleteFlow(flowId) {
    // BUGFIX — cancelar qualquer save pendente ANTES de apagar do Firestore.
    // Sem isto, o _saveTimer de 1400ms dispararia após o delete e
    // ressuscitaria o flow apagado (race condition confirmada na investigação).
    FlowRepository.cancelPendingSave();

    await FlowStorage.remove(flowId);
    toast('Fluxo eliminado');
    FlowListView.render();
  }

  /* ══════════════════════════════════════════════════════════════════
     FASE 3.2.1 — Apagar fluxo a partir do editor
     ──────────────────────────────────────────────────────────────────
     Substitui o antigo botão "Arquivar" da toolbar do Flow Builder.
     Já não existe "arquivar" — o utilizador só tem Salvar ou Apagar.
     Pede confirmação (mesmo padrão do diálogo de publicar/arquivar
     usado anteriormente) antes de eliminar definitivamente.
     ══════════════════════════════════════════════════════════════════ */
  function deleteFlowFromEditor() {
    const meta = FlowRepository.getMeta();
    const name = document.getElementById('fb-name')?.value || meta.name;
    const flowId = FlowRepository.getFlowId();

    if (!flowId) {
      // Fluxo ainda nunca foi guardado — nada para apagar no Firestore,
      // apenas voltar à lista.
      FlowListView.backToList();
      return;
    }

    const body   = document.getElementById('pub-modal-body');
    const footer = document.getElementById('pub-modal-footer');
    const title  = document.getElementById('pub-modal-title');

    title.innerHTML = '<i class="ti ti-trash" style="color:#f87171;font-size:14px"></i> Apagar fluxo';

    body.innerHTML = `
      <div style="text-align:center;padding:10px 0 16px">
        <div style="font-size:28px;color:#f87171;margin-bottom:8px"><i class="ti ti-trash"></i></div>
        <div style="font-size:13px;font-weight:500;margin-bottom:6px">${name}</div>
        <p style="font-size:11px;color:var(--k-muted);line-height:1.6">
          Esta acção é definitiva e não pode ser desfeita.<br>
          Se este fluxo estiver associado a algum número de WhatsApp como
          Fluxo Ativo, esse número deixará de responder automaticamente
          até escolher outro fluxo em "Gerir Canal".
        </p>
      </div>
    `;

    footer.innerHTML = '';
    const btnCancel = document.createElement('button');
    btnCancel.className = 'btn btn-sm';
    btnCancel.textContent = 'Cancelar';
    btnCancel.onclick = closePubModal;
    const btnConfirm = document.createElement('button');
    btnConfirm.className = 'btn btn-sm btn-danger';
    btnConfirm.innerHTML = '<i class="ti ti-trash"></i> Apagar definitivamente';
    btnConfirm.onclick = async () => {
      FlowRepository.cancelPendingSave(); // ← 2.º cancelamento: anula qualquer timer criado durante o modal
      closePubModal();
      await deleteFlow(flowId);
      FlowListView.backToList();
    };
    footer.appendChild(btnCancel);
    footer.appendChild(btnConfirm);

    // FASE 3.2.2 — BUG CRÍTICO #2 CORRIGIDO
    // Antes: cancelPendingSave() só era chamado dentro de deleteFlow(), que é
    // async e aguardado com await no btnConfirm.onclick. Entre a abertura do modal
    // e o clique em confirmar, o listener 'input' em fb-name continuava activo.
    // Se o utilizador tocasse no campo de nome durante o modal, schedSave() disparava
    // um novo _saveTimer (1400ms). Ao confirmar: closePubModal() → await deleteFlow()
    // → cancelPendingSave() → remove(). O cancelPendingSave() chegava cedo,
    // mas o timer que foi criado DURANTE o modal já podia ter disparado entretanto,
    // ressuscitando o documento imediatamente após a remoção.
    //
    // Correcção: cancelar o autosave em dois momentos:
    //   1. Imediatamente ao abrir o modal (antes de qualquer await ou interacção).
    //   2. Novamente no btnConfirm.onclick antes do await deleteFlow(), para anular
    //      qualquer timer que o utilizador pudesse ter criado enquanto o modal estava aberto.
    // Com isto, nenhum timer sobrevive ao fluxo de apagar.
    FlowRepository.cancelPendingSave(); // ← cancelamento antecipado ao abrir o modal

    document.getElementById('pub-overlay').classList.add('open');
  }

  return {
    openFlow, newFlow,
    duplicate, duplicateFromList, deleteFlow, deleteFlowFromEditor,
  };
})();

/* ── Fechar modal de publicação ── */
function closePubModal() {
  document.getElementById('pub-overlay').classList.remove('open');
}

/* ══════════════════════════════════════════════════════════════════════
   FASE 3.2.1 — FlowListView
   ────────────────────────────────────────────────────────────────────
   Renderiza a lista de fluxos. Já não existe conceito de status
   (draft/published/archived) — cada card mostra apenas nome e data de
   última actualização, e as acções Editar / Duplicar / Apagar.
   Lê do FlowStorage. Toda a lógica de mudança de estado passa pelo
   FlowPublisher.
   ══════════════════════════════════════════════════════════════════════ */
const FlowListView = (() => {

  function _fmtDate(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      return d.toLocaleDateString('pt-MZ', { day:'2-digit', month:'short', year:'numeric' });
    } catch { return iso; }
  }

  // ── Renderiza os cards a partir de um array de flows já ordenado ──
  function _renderCards(body, flows) {
    body.innerHTML = '';

    if (!flows.length) {
      const empty = document.createElement('div');
      empty.className = 'flist-empty';
      empty.innerHTML = `
        <div class="flist-empty-icon"><i class="ti ti-hierarchy"></i></div>
        <div class="flist-empty-title">Ainda não tem fluxos</div>
        <div class="flist-empty-sub">Crie o seu primeiro fluxo de automação WhatsApp</div>
        <button class="btn btn-primary btn-sm" style="margin-top:12px" onclick="FlowPublisher.newFlow()">
          <i class="ti ti-plus"></i> Criar primeiro fluxo
        </button>
      `;
      body.appendChild(empty);
      return;
    }

    flows.forEach(f => {
      const card = document.createElement('div');
      card.className = 'flow-card';

      // Icon
      const icon = document.createElement('div');
      icon.className = 'flow-card-icon';
      icon.innerHTML = `<i class="ti ti-hierarchy"></i>`;

      // Info
      const info = document.createElement('div');
      info.className = 'flow-card-info';

      const nameLine = document.createElement('div');
      nameLine.className = 'flow-card-name';
      nameLine.title = f.name;
      nameLine.textContent = f.name || 'Sem título';

      const meta = document.createElement('div');
      meta.className = 'flow-card-meta';
      meta.innerHTML = `
        <span class="flow-card-meta-item"><i class="ti ti-clock" style="font-size:10px"></i> ${_fmtDate(f.updatedAt)}</span>
      `;

      info.appendChild(nameLine);
      info.appendChild(meta);

      // Actions
      const actions = document.createElement('div');
      actions.className = 'flow-card-actions';

      const btnOpen = document.createElement('button');
      btnOpen.className = 'btn btn-sm btn-primary';
      btnOpen.innerHTML = '<i class="ti ti-pencil"></i> Editar';
      btnOpen.onclick = () => FlowPublisher.openFlow(f.flowId);

      const btnDup = document.createElement('button');
      btnDup.className = 'btn btn-sm btn-icon';
      btnDup.title = 'Duplicar';
      btnDup.innerHTML = '<i class="ti ti-copy"></i>';
      btnDup.onclick = () => FlowPublisher.duplicateFromList(f.flowId);

      const btnDel = document.createElement('button');
      btnDel.className = 'btn btn-sm btn-icon';
      btnDel.title = 'Apagar fluxo';
      btnDel.style.cssText = 'color:#f87171;border-color:rgba(239,68,68,.3)';
      btnDel.innerHTML = '<i class="ti ti-trash"></i>';
      btnDel.onclick = () => {
        if (confirm(`Apagar "${f.name}" permanentemente?`)) {
          FlowPublisher.deleteFlow(f.flowId);
        }
      };

      actions.appendChild(btnOpen);
      actions.appendChild(btnDup);
      actions.appendChild(btnDel);

      card.appendChild(icon);
      card.appendChild(info);
      card.appendChild(actions);
      body.appendChild(card);
    });
  }

  async function render() {
    const body = document.getElementById('flist-body');
    if (!body) return;

    // FASE 3.2.3 BUGFIX — render em duas fases:
    // 1. Imediato: dados do índice local (localStorage) → sem espera
    // 2. Background: Firestore refresca o índice e re-renderiza se a
    //    view de fluxos ainda estiver activa (utilizador não navegou)
    const flows = await FlowStorage.list(freshEntries => {
      // Callback chamado pelo background refresh do Firestore.
      // Só re-renderiza se a lista de fluxos ainda estiver visível.
      const currentBody = document.getElementById('flist-body');
      const listView    = document.getElementById('view-flows-list');
      if (!currentBody || !listView || !listView.classList.contains('active')) return;
      const sorted = [...freshEntries].sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
      _renderCards(currentBody, sorted);
    });

    // Render imediato com cache local
    flows.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    _renderCards(body, flows);
  }

  function backToList() {
    const navFlows = document.querySelector('.nav-item[onclick*="flows-list"]');
    setView('flows-list', navFlows);
  }

  return { render, backToList };
})();

/* ══════════════════════════════════════════════════════════════════════
   FASE 3.0.2 — Auth Screen Controller
   ────────────────────────────────────────────────────────────────────
   Controla a tela de login/registo e a visibilidade do editor.
   Usa AuthService (definido na fase 3.0.1).
   Não altera nenhum módulo do Flow Builder.
   ══════════════════════════════════════════════════════════════════════ */
