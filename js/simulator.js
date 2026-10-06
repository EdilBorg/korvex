const FlowSimulator = (() => {

  /* ── Estado interno ─────────────────────────────────────────────── */
  let _state = 'idle';   // idle | running | paused | done | error
  let _history   = [];   // [{node, port}] — percurso percorrido
  let _histIdx   = -1;   // posição actual no histórico (step mode)
  let _flow      = null; // snapshot {nodes, edges} no momento de start
  let _graph     = null; // grafo construído pelo WE
  let _speed     = 1;    // 1 | 2 | 4
  let _autoTimer = null; // timer do modo automático
  let _pendingCondition = null; // {node, trueEdge, falseEdge} — aguardando escolha
  let _simEdgeEl = null; // elemento SVG para animação de aresta activa

  /* ── Constantes ─────────────────────────────────────────────────── */
  const SPEED_MS = { 1: 1200, 2: 600, 4: 250 };

  /* ── Tipos que exigem escolha de condição ───────────────────────── */
  const CONDITION_TYPES = new Set(['condicao']);

  /* ── Tipos cujo conteúdo é "simulado" (não executado) ───────────── */
  const SIMULATED_TYPES = {
    webhook:   '🔗 Webhook simulado',
    api:       '🔌 API simulada',
    transferir:'👤 Transferência simulada',
  };

  /* ── Helpers ────────────────────────────────────────────────────── */

  function _buildGraph(flow) {
    const ns = flow.nodes || [];
    const es = flow.edges || [];
    const nodeById  = new Map(ns.map(n => [n.id, n]));
    const outEdges  = new Map(ns.map(n => [n.id, []]));
    const inEdges   = new Map(ns.map(n => [n.id, []]));
    es.forEach(e => {
      if (outEdges.has(e.fr)) outEdges.get(e.fr).push(e);
      if (inEdges.has(e.to))  inEdges.get(e.to).push(e);
    });
    return { ns, es, nodeById, outEdges, inEdges };
  }

  function _badge(text, cls) {
    const el = document.getElementById('sim-badge');
    if (!el) return;
    el.textContent = text;
    el.className = 'sim-badge' + (cls ? ' ' + cls : '');
  }

  function _setState(s) {
    _state = s;
    const btnStart = document.getElementById('sim-btn-start');
    const btnStop  = document.getElementById('sim-btn-stop');
    const btnPrev  = document.getElementById('sim-btn-prev');
    const btnNext  = document.getElementById('sim-btn-next');
    if (!btnStart) return;

    if (s === 'running') {
      btnStart.style.display = 'none';
      btnStop.style.display  = '';
      btnPrev.disabled = true;
      btnNext.disabled = true;
      _badge('A correr…', 'running');
    } else if (s === 'paused') {
      btnStart.style.display  = '';
      btnStart.innerHTML = '<i class="ti ti-player-play"></i> Continuar';
      btnStop.style.display   = 'none';
      btnPrev.disabled = false;
      btnNext.disabled = false;
      _badge('Pausado', '');
    } else if (s === 'done') {
      btnStart.style.display  = '';
      btnStart.innerHTML = '<i class="ti ti-refresh"></i> Reiniciar';
      btnStart.onclick   = () => FlowSimulator.reset();
      btnStop.style.display   = 'none';
      btnPrev.disabled = false;
      btnNext.disabled = true;
      _badge('Concluído', 'done');
    } else if (s === 'error') {
      btnStart.style.display  = 'none';
      btnStop.style.display   = 'none';
      btnPrev.disabled = true;
      btnNext.disabled = true;
      _badge('Erro', 'error');
    } else {
      // idle
      btnStart.style.display  = '';
      btnStart.innerHTML = '<i class="ti ti-player-play"></i> Iniciar';
      btnStart.onclick   = () => FlowSimulator.start();
      btnStop.style.display   = 'none';
      btnPrev.disabled = false;
      btnNext.disabled = false;
      _badge('Pronto', '');
    }
  }

  /* ── Canvas: realce dos nós ─────────────────────────────────────── */

  function _clearCanvasHighlights() {
    document.querySelectorAll('.fb-node').forEach(el => {
      el.classList.remove('sim-active', 'sim-visited', 'sim-dimmed');
    });
    _clearSimEdge();
  }

  function _applyCanvasHighlights() {
    const visitedIds = new Set(_history.map(h => h.node.id));
    const currentId  = _histIdx >= 0 ? _history[_histIdx].node.id : null;

    document.querySelectorAll('.fb-node').forEach(el => {
      el.classList.remove('sim-active', 'sim-visited', 'sim-dimmed');
      const nid = parseInt(el.dataset.nid);
      if (nid === currentId) {
        el.classList.add('sim-active');
      } else if (visitedIds.has(nid)) {
        el.classList.add('sim-visited');
      } else {
        el.classList.add('sim-dimmed');
      }
    });

    // Animar aresta de entrada do nó actual
    if (_histIdx > 0 && _flow) {
      const fromNode = _history[_histIdx - 1].node;
      const toNode   = _history[_histIdx].node;
      const port     = _history[_histIdx - 1].exitPort;
      _animateEdge(fromNode.id, toNode.id, port);
    }

    // Foca o nó actual no canvas
    if (currentId) {
      const el = document.querySelector(`.fb-node[data-nid="${currentId}"]`);
      if (el) {
        const wrap = document.getElementById('fb-wrap');
        if (wrap) {
          const wr = wrap.getBoundingClientRect();
          const nx = _history[_histIdx].node.x * zoom + panX;
          const ny = _history[_histIdx].node.y * zoom + panY;
          // Soft scroll into view (only if way off-screen)
          if (nx < 60 || nx > wr.width - 300 || ny < 60 || ny > wr.height - 200) {
            panX = wr.width  / 2 - _history[_histIdx].node.x * zoom - 110;
            panY = wr.height / 2 - _history[_histIdx].node.y * zoom - 80;
            updateTransform();
          }
        }
      }
    }
  }

  function _animateEdge(fromId, toId, port) {
    _clearSimEdge();
    const s = document.getElementById('fb-svg');
    if (!s) return;
    // Find matching edge group in SVG
    const groups = s.querySelectorAll('g[data-eid]');
    groups.forEach(g => {
      const eid2 = parseInt(g.dataset.eid);
      const e = _flow.edges.find(e => e.id === eid2);
      if (e && e.fr === fromId && e.to === toId && (!port || e.fp === port || !e.fp)) {
        const path = g.querySelector('path.edge-visual');
        if (path) {
          path.classList.add('sim-edge-active');
          _simEdgeEl = path;
        }
      }
    });
  }

  function _clearSimEdge() {
    if (_simEdgeEl) {
      _simEdgeEl.classList.remove('sim-edge-active');
      _simEdgeEl = null;
    }
    // Safety: clear all
    document.querySelectorAll('.sim-edge-active').forEach(el => el.classList.remove('sim-edge-active'));
  }

  /* ── Conteúdo de simulação de um nó ────────────────────────────── */

  function _getSimContent(node) {
    const def = DEF[node.t];
    const d   = node.data || {};

    if (SIMULATED_TYPES[node.t]) return { text: SIMULATED_TYPES[node.t], simulated: true };

    if (node.t === 'encerrar') return { text: d.msg || 'Fluxo concluído', simulated: false };
    if (node.t === 'inicio')   return { text: `Gatilho: ${d.trigger || 'Mensagem recebida'}${d.keyword ? '\nPalavra-chave: ' + d.keyword : ''}`, simulated: false };
    if (node.t === 'mensagem') return { text: d.txt || d.text || '(sem mensagem)', simulated: false };
    if (node.t === 'pergunta') return { text: d.txt || d.text || '(sem pergunta)', simulated: false };
    if (node.t === 'botao')    return { text: (d.txt || d.text || '') + (d.btns ? '\n\n' + d.btns : ''), simulated: false };
    if (node.t === 'lista')    return { text: (d.txt || d.text || '') + (d.items ? '\n\n' + d.items : ''), simulated: false };
    if (node.t === 'imagem')   return { text: '🖼️ Imagem' + (d.url ? ': ' + d.url : '') + (d.cap ? '\n' + d.cap : ''), simulated: false };
    if (node.t === 'video')    return { text: '🎬 Vídeo' + (d.url ? ': ' + d.url : ''), simulated: false };
    if (node.t === 'audio')    return { text: '🔊 Áudio' + (d.url ? ': ' + d.url : ''), simulated: false };
    if (node.t === 'documento')return { text: '📄 ' + (d.fn || 'Documento') + (d.url ? ': ' + d.url : ''), simulated: false };
    if (node.t === 'aguardar') return { text: `⏳ Aguardar resposta (timeout: ${d.to || 30} min)\nGuardar em: ${d.var || '{{resposta}}'}`, simulated: false };
    if (node.t === 'delay')    return { text: `⏱️ Delay: ${d.secs || 0} segundo(s)${d.typing === 'Sim' ? '\n[a digitar…]' : ''}`, simulated: false };
    if (node.t === 'condicao') {
      const f = d.var || d.field || '?';
      const o = d.op  || d.operator || '?';
      const v = d.val || d.value || '';
      return { text: `Se ${f} ${o} ${v ? '"' + v + '"' : '(vazio)'}`, simulated: false };
    }
    if (node.t === 'tag')       return { text: `🏷️ Tag: ${d.tags || ''}`, simulated: false };
    if (node.t === 'removertag')return { text: `🏷️ Remover tag: ${d.tags || ''}`, simulated: false };

    // Fallback: use NodeTypeRegistry preview
    const prev = NodeTypeRegistry.getPreview(node);
    return { text: prev || def?.d || node.t, simulated: false };
  }

  /* ── Determinação do próximo nó ─────────────────────────────────── */

  function _getOutEdges(nodeId) {
    if (!_graph) return [];
    return (_graph.outEdges.get(nodeId) || []);
  }

  function _resolveNext(node, conditionResult) {
    const outEdges = _getOutEdges(node.id);
    if (!outEdges.length) return null; // fim do fluxo

    if (CONDITION_TYPES.has(node.t)) {
      // Portas: 'Sim' / 'Verdadeiro' = true, 'Não' / 'Falso' = false
      const trueEdge  = outEdges.find(e => ['Sim','Verdadeiro','sim','verdadeiro'].includes(e.fp)) || outEdges[0];
      const falseEdge = outEdges.find(e => ['Não','Falso','não','falso'].includes(e.fp)) || outEdges[1] || outEdges[0];
      return conditionResult === true ? trueEdge : (conditionResult === false ? falseEdge : null);
    }

    // Nó normal: primeira saída disponível
    return outEdges[0];
  }

  /* ── Adicionar passo ao histórico ───────────────────────────────── */

  function _pushStep(node, entryPort, exitPort) {
    _history.push({ node, entryPort: entryPort || 'in', exitPort: exitPort || null });
    _histIdx = _history.length - 1;
  }

  /* ── Render do painel ───────────────────────────────────────────── */

  function _render() {
    const body = document.getElementById('sim-body');
    if (!body) return;
    body.innerHTML = '';

    if (_state === 'idle') {
      body.innerHTML = '<div style="font-size:12px;color:var(--k-muted);text-align:center;padding:20px 0">Clique <b style="color:var(--k-text)">Iniciar</b> para começar a simulação.</div>';
      return;
    }

    // ── Stats ──────────────────────────────────────────────────────
    const statsRow = document.createElement('div');
    statsRow.className = 'sim-stats-row';
    const stepCount = _history.length;
    const curIdx    = _histIdx + 1;
    statsRow.innerHTML = `
      <div class="sim-stat"><div class="sim-stat-val">${curIdx}</div><div class="sim-stat-lbl">Passo actual</div></div>
      <div class="sim-stat"><div class="sim-stat-val">${stepCount}</div><div class="sim-stat-lbl">Total passos</div></div>
      <div class="sim-stat"><div class="sim-stat-val">${_flow ? _flow.nodes.length : 0}</div><div class="sim-stat-lbl">Blocos</div></div>
    `;
    body.appendChild(statsRow);

    // ── Nó actual ──────────────────────────────────────────────────
    if (_histIdx >= 0) {
      const cur = _history[_histIdx];
      const def = DEF[cur.node.t] || {};
      const content = _getSimContent(cur.node);

      const card = document.createElement('div');
      card.className = 'sim-cur-card';

      const curLabel = document.createElement('div');
      curLabel.className = 'sim-cur-label';
      curLabel.innerHTML = `<i class="ti ti-arrow-right" style="font-size:11px"></i> Bloco actual`;
      card.appendChild(curLabel);

      const curName = document.createElement('div');
      curName.className = 'sim-cur-name';
      curName.textContent = cur.node.lbl || def.n || cur.node.t;
      card.appendChild(curName);

      const curType = document.createElement('div');
      curType.className = 'sim-cur-type';
      curType.innerHTML = `<i class="ti ${def.ic || 'ti-box'}" style="color:${def.c || 'var(--k-accent)'}"></i> ${def.n || cur.node.t}`;
      card.appendChild(curType);

      if (content.text) {
        const curContent = document.createElement('div');
        curContent.className = 'sim-cur-content' + (content.simulated ? ' sim-simulated' : '');
        curContent.textContent = content.text;
        card.appendChild(curContent);
      }

      // Condition chooser
      if (_pendingCondition && _pendingCondition.nodeId === cur.node.id) {
        const condBox = document.createElement('div');
        condBox.className = 'sim-condition-box';
        condBox.innerHTML = `<div class="sim-condition-label"><i class="ti ti-git-branch" style="font-size:11px"></i> Escolha o resultado da condição:</div>`;
        const btns = document.createElement('div');
        btns.className = 'sim-condition-btns';
        const trueBtn = document.createElement('button');
        trueBtn.className = 'sim-cond-btn true-btn';
        trueBtn.innerHTML = '<i class="ti ti-check"></i> Verdadeiro';
        trueBtn.onclick = () => FlowSimulator._resolveCondition(true);
        const falseBtn = document.createElement('button');
        falseBtn.className = 'sim-cond-btn false-btn';
        falseBtn.innerHTML = '<i class="ti ti-x"></i> Falso';
        falseBtn.onclick = () => FlowSimulator._resolveCondition(false);
        btns.appendChild(trueBtn);
        btns.appendChild(falseBtn);
        condBox.appendChild(btns);
        card.appendChild(condBox);
      }

      body.appendChild(card);
    }

    // ── Done card ──────────────────────────────────────────────────
    if (_state === 'done') {
      const doneCard = document.createElement('div');
      doneCard.className = 'sim-done-card';
      doneCard.innerHTML = `
        <div class="sim-done-title"><i class="ti ti-flag-check"></i> Fluxo concluído</div>
        <div class="sim-done-sub">${_history.length} passo(s) percorrido(s)</div>
      `;
      body.appendChild(doneCard);
    }

    // ── Caminho percorrido ─────────────────────────────────────────
    if (_history.length) {
      const secPath = document.createElement('div');
      secPath.className = 'sim-section-title';
      secPath.textContent = 'Caminho percorrido';
      body.appendChild(secPath);

      const hist = document.createElement('div');
      hist.className = 'sim-history';

      _history.forEach((h, i) => {
        const def = DEF[h.node.t] || {};
        const item = document.createElement('div');
        item.className = 'sim-hist-item' + (i === _histIdx ? ' current-hist' : '');
        item.innerHTML = `
          <span class="sim-hist-idx">${i + 1}</span>
          <i class="ti ${def.ic || 'ti-box'} sim-hist-icon" style="color:${def.c || 'var(--k-accent)'}"></i>
          <span class="sim-hist-name">${h.node.lbl || def.n || h.node.t}</span>
          ${h.exitPort && h.exitPort !== 'Próximo' && h.exitPort !== 'Saída' ? `<span class="sim-hist-port">→ ${h.exitPort}</span>` : ''}
        `;
        // Click to navigate to that step
        item.style.cursor = 'pointer';
        item.onclick = () => { _histIdx = i; _applyCanvasHighlights(); _render(); };
        hist.appendChild(item);
      });

      body.appendChild(hist);
    }
  }

  /* ── Avançar um passo ───────────────────────────────────────────── */

  function _advance() {
    if (!_flow || !_graph) return false;

    // Se estamos no modo revisão (histIdx < history.length-1), avança no histórico
    if (_histIdx < _history.length - 1) {
      _histIdx++;
      _applyCanvasHighlights();
      _render();
      return true;
    }

    // Determine o próximo nó a partir do nó actual
    const curEntry = _histIdx >= 0 ? _history[_histIdx] : null;
    const curNode  = curEntry ? curEntry.node : null;

    // Se ainda não começámos, entra no nó inicial
    if (!curNode) {
      const starts = _flow.nodes.filter(n => (_graph.inEdges.get(n.id) || []).length === 0);
      if (!starts.length) {
        _finalize('Nenhum nó de entrada encontrado.');
        return false;
      }
      _pushStep(starts[0]);
      _applyCanvasHighlights();
      _render();
      return true;
    }

    // Verificar se é condição pendente
    if (CONDITION_TYPES.has(curNode.t) && !_pendingCondition) {
      const outEdges = _getOutEdges(curNode.id);
      const trueEdge  = outEdges.find(e => ['Sim','Verdadeiro'].includes(e.fp)) || outEdges[0];
      const falseEdge = outEdges.find(e => ['Não','Falso'].includes(e.fp)) || outEdges[1] || outEdges[0];
      _pendingCondition = { nodeId: curNode.id, trueEdge, falseEdge };
      _render();
      // Parar auto mode enquanto espera
      _pauseAuto();
      return false;
    }

    // Resolver próxima aresta (condição já resolvida → usa exitPort guardado)
    const exitPortFromHist = curEntry.exitPort;
    const outEdges = _getOutEdges(curNode.id);
    let nextEdge;

    if (exitPortFromHist) {
      nextEdge = outEdges.find(e => e.fp === exitPortFromHist) || outEdges[0];
    } else {
      nextEdge = outEdges[0];
    }

    if (!nextEdge) {
      _setState('done');
      _applyCanvasHighlights();
      _render();
      _clearSimEdge();
      return false;
    }

    const nextNode = _graph.nodeById.get(nextEdge.to);
    if (!nextNode) {
      _setState('done');
      _render();
      return false;
    }

    // Verificar ciclo
    const visitedIds = new Set(_history.slice(0, _histIdx + 1).map(h => h.node.id));
    if (visitedIds.has(nextNode.id)) {
      toast('Ciclo detectado — simulação encerrada', 'err');
      _setState('done');
      _applyCanvasHighlights();
      _render();
      return false;
    }

    // Actualizar exitPort do passo anterior
    _history[_histIdx].exitPort = nextEdge.fp || 'Próximo';

    _pushStep(nextNode);
    _applyCanvasHighlights();
    _render();

    // Se é encerrar, termina
    if (nextNode.t === 'encerrar') {
      setTimeout(() => { _setState('done'); _render(); }, 200);
      return false;
    }

    return true;
  }

  /* ── Recuar um passo ────────────────────────────────────────────── */

  function _retreat() {
    if (_histIdx <= 0) return;
    _histIdx--;
    _pendingCondition = null;
    _applyCanvasHighlights();
    _render();
  }

  /* ── Pausar modo automático ─────────────────────────────────────── */

  function _pauseAuto() {
    if (_autoTimer) { clearInterval(_autoTimer); _autoTimer = null; }
    if (_state === 'running') _setState('paused');
  }

  /* ── Terminar simulação ─────────────────────────────────────────── */

  function _finalize(reason) {
    _pauseAuto();
    _setState('done');
    if (reason) toast(reason);
    _render();
  }

  /* ── API Pública ────────────────────────────────────────────────── */

  function open() {
    const overlay = document.getElementById('sim-overlay');
    if (!overlay) return;
    overlay.classList.add('open');
    // Se não está em curso, mostra estado inicial
    if (_state === 'idle') _render();
  }

  function close() {
    const overlay = document.getElementById('sim-overlay');
    if (overlay) overlay.classList.remove('open');
    // Não para a simulação — apenas fecha o painel
  }

  function start() {
    // FASE 3.2 — Guard de subscrição
    if (!SubscriptionService.canAccess()) {
      console.warn('[FlowSimulator] start() bloqueado — subscrição inactiva');
      return;
    }
    // Se já está done, reinicia
    if (_state === 'done') { reset(); return; }

    // Validação prévia via WorkflowEngine
    const flow   = { nodes, edges };
    const report = WorkflowEngine.validate(flow);
    if (!report.valid) {
      const body = document.getElementById('sim-body');
      if (body) {
        body.innerHTML = '';
        const errBox = document.createElement('div');
        errBox.className = 'sim-val-errors';
        errBox.innerHTML = `<div class="sim-val-title"><i class="ti ti-alert-triangle"></i> Erros críticos — simulação bloqueada</div>`;
        const ul = document.createElement('ul');
        ul.className = 'sim-val-list';
        (report.errors || []).forEach(e => {
          const li = document.createElement('li');
          li.innerHTML = `<i class="ti ti-circle-x" style="flex-shrink:0"></i>${e.message}`;
          ul.appendChild(li);
        });
        errBox.appendChild(ul);
        body.appendChild(errBox);
      }
      _setState('error');
      return;
    }

    // Snapshot do estado actual
    _flow  = JSON.parse(JSON.stringify({ nodes, edges }));
    _graph = _buildGraph(_flow);
    _pendingCondition = null;

    if (_state === 'idle') {
      _history = [];
      _histIdx = -1;
    }

    _setState('running');

    // Modo automático: avança um passo a cada SPEED_MS
    _autoTimer = setInterval(() => {
      const canContinue = _advance();
      if (!canContinue) {
        clearInterval(_autoTimer);
        _autoTimer = null;
        if (_state === 'running') _setState('paused');
      }
    }, SPEED_MS[_speed]);
  }

  function stop() {
    _pauseAuto();
  }

  function reset() {
    _pauseAuto();
    _history   = [];
    _histIdx   = -1;
    _flow      = null;
    _graph     = null;
    _pendingCondition = null;
    _clearCanvasHighlights();
    _setState('idle');

    // Restaurar botão start
    const btnStart = document.getElementById('sim-btn-start');
    if (btnStart) {
      btnStart.innerHTML = '<i class="ti ti-player-play"></i> Iniciar';
      btnStart.onclick   = () => FlowSimulator.start();
      btnStart.style.display = '';
    }

    _render();
  }

  function next() {
    if (_state === 'running') return;
    if (_state === 'idle') {
      // Inicializar sem auto
      const flow   = { nodes, edges };
      const report = WorkflowEngine.validate(flow);
      if (!report.valid) { start(); return; }
      _flow  = JSON.parse(JSON.stringify({ nodes, edges }));
      _graph = _buildGraph(_flow);
      _pendingCondition = null;
      _history = [];
      _histIdx = -1;
      _setState('paused');
    }
    _advance();
    if (_state !== 'paused') _setState('paused');
  }

  function prev() {
    if (_state === 'running') return;
    _pendingCondition = null;
    _retreat();
    if (_state !== 'paused' && _state !== 'idle') _setState('paused');
  }

  function setSpeed(s, btn) {
    _speed = s;
    document.querySelectorAll('.sim-speed-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    // Se está a correr, reaplica o intervalo com nova velocidade
    if (_state === 'running' && _autoTimer) {
      clearInterval(_autoTimer);
      _autoTimer = setInterval(() => {
        const canContinue = _advance();
        if (!canContinue) { clearInterval(_autoTimer); _autoTimer = null; if (_state === 'running') _setState('paused'); }
      }, SPEED_MS[s]);
    }
  }

  /* Chamado pelos botões Verdadeiro/Falso na condição */
  function _resolveCondition(result) {
    if (!_pendingCondition) return;
    const edge = result ? _pendingCondition.trueEdge : _pendingCondition.falseEdge;
    if (!edge) { toast('Sem ligação para essa saída'); return; }

    // Guardar o exitPort escolhido no passo actual
    if (_histIdx >= 0) _history[_histIdx].exitPort = edge.fp || (result ? 'Sim' : 'Não');

    _pendingCondition = null;
    _render();

    // Avançar para o próximo nó
    setTimeout(() => {
      const nextNode = _graph.nodeById.get(edge.to);
      if (!nextNode) { _setState('done'); _render(); return; }

      const visitedIds = new Set(_history.slice(0, _histIdx + 1).map(h => h.node.id));
      if (visitedIds.has(nextNode.id)) {
        toast('Ciclo detectado — simulação encerrada', 'err');
        _setState('done');
        _applyCanvasHighlights();
        _render();
        return;
      }

      _pushStep(nextNode);
      _applyCanvasHighlights();
      _render();

      if (nextNode.t === 'encerrar') {
        setTimeout(() => { _setState('done'); _render(); }, 200);
        return;
      }

      // Retomar auto se estava running
      if (_state === 'running') {
        _autoTimer = setInterval(() => {
          const canContinue = _advance();
          if (!canContinue) { clearInterval(_autoTimer); _autoTimer = null; if (_state === 'running') _setState('paused'); }
        }, SPEED_MS[_speed]);
      }
    }, 80);
  }

  return {
    open,
    close,
    start,
    stop,
    reset,
    next,
    prev,
    setSpeed,
    _resolveCondition,
  };
})();

/* fbTest agora abre o simulador */
function fbTest() { FlowSimulator.open(); }


let toastTimer;
function toast(msg, cls) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = 'toast' + (cls ? ' ' + cls : '');
  el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}
