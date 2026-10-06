const FlowRepository = (() => {

  // FASE 3.2.1 — Removido o conceito de status (draft/published/archived).
  // Os fluxos passam a ser apenas guardados (Auto Save / Salvar). A
  // execução por WhatsApp deixa de depender de "fluxo publicado" e passa
  // a depender de qual fluxo está associado a cada número de WhatsApp
  // (activeFlowId em connections/whatsapp — ver js/connections.js).
  let _meta = {
    flowId:      null,
    workspaceId: AuthService.getUserId(), // FASE 3.0.7 — UID real
    userId:      AuthService.getUserId(), // FASE 3.0.7 — UID real
    name:        'Novo fluxo',
    description: '',
    createdAt:   null,
    version:     0,
  };

  let _saveTimer = null;

  function getMeta()    { return { ..._meta }; }
  function getFlowId()  { return _meta.flowId; }

  function setName(name)     { _meta.name   = name || 'Sem título'; }

  /**
   * Carrega um fluxo específico pelo flowId — usado ao abrir da lista.
   */
  async function loadFlow(flowId) {
    const doc = await FlowStorage.load(flowId);
    if (!doc) return null;
    const { nodes, edges, meta } = FlowSerializer.deserialize(doc);
    Object.assign(_meta, meta);
    return { nodes, edges };
  }

  /**
   * Persiste com meta status actualizado — para publish/archive.
   * immediate=true salta o debounce.
   */
  function commitState(nodes, edges, immediate) {
    clearTimeout(_saveTimer);
    const delay = immediate ? 0 : 1400;
    _saveTimer = setTimeout(() => _persist(nodes, edges), delay);
  }

  // BUGFIX — cancelPendingSave()
  // Cancela qualquer timer de save pendente.
  // Deve ser chamado em deleteFlow e no logout para evitar que
  // um _persist() agendado ressuscite um flow já apagado.
  function cancelPendingSave() {
    clearTimeout(_saveTimer);
    _saveTimer = null;
    console.info('[FlowRepository] Timer de save cancelado.');
  }

  async function _persist(nodes, edges) {
    // FASE 4.3.1 — Nunca guardar um fluxo vazio automaticamente.
    // O utilizador só deve ter fluxos no Firestore após interação explícita.
    if (!nodes || nodes.length === 0) {
      console.info('[FlowRepository] _persist ignorado — fluxo vazio (sem nós).');
      return;
    }

    const doc = FlowSerializer.serialize(nodes, edges, _meta);

    const check = FlowValidator.validate(doc);
    if (!check.valid) {
      console.warn('[FlowRepository] Aviso de integridade:', check.errors);
    }

    await FlowStorage.save(doc);

    _meta.flowId    = doc.flowId;
    _meta.version   = doc.version;
    _meta.updatedAt = doc.updatedAt;
    if (!_meta.createdAt) _meta.createdAt = doc.createdAt;
  }

  async function init() {
    // FASE 3.2 — Guard de subscrição
    if (!SubscriptionService.canAccess()) {
      // [FLIGHT RECORDER]
      if (typeof korvexFlightRecorder !== 'undefined') {
        korvexFlightRecorder.recordFlow('init', {
          blocked: true,
          reason: 'subscription_inactive'
        });
      }
      console.warn('[FlowRepository] init() bloqueado — subscrição inactiva');
      return { nodes: [], edges: [], restored: false };
    }
    // FASE 3.0.7 — Actualizar userId/workspaceId com o UID real no momento do init
    // (o módulo pode ter sido inicializado antes do login estar resolvido)
    const uid = AuthService.getUserId();
    _meta.userId      = uid;
    _meta.workspaceId = uid;

    const doc = await FlowStorage.loadLatest();

    if (doc) {
      const { nodes, edges, meta } = FlowSerializer.deserialize(doc);
      Object.assign(_meta, meta);
      const nameEl = document.getElementById('fb-name');
      if (nameEl) nameEl.value = _meta.name;
      // [FLIGHT RECORDER]
      if (typeof korvexFlightRecorder !== 'undefined') {
        korvexFlightRecorder.recordFlow('init', {
          uid,
          flowId: meta.flowId,
          restored: true
        });
      }
      return { nodes, edges, restored: true };
    }

    _meta.flowId    = _generateFlowId();
    _meta.createdAt = new Date().toISOString();
    // [FLIGHT RECORDER]
    if (typeof korvexFlightRecorder !== 'undefined') {
      korvexFlightRecorder.recordFlow('init', {
        uid,
        restored: false,
        reason: 'new_flow'
      });
    }
    return { nodes: null, edges: null, restored: false };
  }

  function _generateFlowId() {
    return 'flow_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  }

  function resetMeta(overrides) {
    Object.assign(_meta, {
      flowId:      null,
      workspaceId: AuthService.getUserId(), // FASE 3.0.7 — UID real
      userId:      AuthService.getUserId(), // FASE 3.0.7 — UID real
      name:        'Novo fluxo',
      description: '',
      createdAt:   null,
      version:     0,
    }, overrides || {});
  }

  return {
    init, getMeta, getFlowId,
    setName,
    resetMeta, loadFlow, commitState, cancelPendingSave,
  };
})();


// ─── Navigation ──────────────────────────────
let _canvasReady = false; // set true after DOMContentLoaded init

function goToFlows() {
  const nav = document.querySelector('.nav-item[onclick*="flows-list"]');
  setView('flows-list', nav);
}

function setView(name, nav) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const el = document.getElementById('view-' + name);
  if (el) el.classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (nav) nav.classList.add('active');
  const titles = {
    dashboard:    'Dashboard',
    inbox:        'Inbox',
    'flows-list': 'Fluxos',
    flows:        'Flow Builder',
    connections:  'Conexões',
    settings:     'Configurações',
    legal:        'Legal',
    clients:      'Clientes',
    analytics:    'Analytics',
    ia:           'Inteligência Artificial',
  };
  document.getElementById('topbar-title').textContent = titles[name] || name;

  if (name === 'flows-list') {
    FlowListView.render();
  }
  // Dashboard premium — refrescar ao voltar ao dashboard
  if (name === 'dashboard' && typeof DashboardMain !== 'undefined') {
    DashboardMain.refresh();
  }
  // FASE 4.0 — Inbox: renderizar/ligar listeners apenas quando a view abre
  if (name === 'inbox' && typeof InboxView !== 'undefined') {
    InboxView.render();
  }
  if (name === 'flows' && _canvasReady) {
    requestAnimationFrame(() => { render(); updateTransform(); drawMini(); });
  }
  // FASE 2.7 — Carregar secção legal quando a vista é activada
  if (name === 'clients') {
    if (typeof ClientsView !== 'undefined') ClientsView.render();
  }
  if (name === 'analytics') {
    if (typeof AnalyticsView !== 'undefined') AnalyticsView.render();
  }
  // IA — renderizar quando a vista é activada
  if (name === 'ia') {
    if (typeof IAView !== 'undefined') {
      const user = typeof AuthService !== 'undefined' ? AuthService.currentUser() : null;
      if (user) IAView.init(user.uid);
    }
  }
  if (name === 'settings') {
    if (typeof SettingsView !== 'undefined') SettingsView.render();
  if (typeof CreditsView  !== 'undefined') CreditsView.render();
  }
  if (name === 'legal') {
    const u = typeof AuthService !== 'undefined' ? AuthService.currentUser() : null;
    if (typeof loadLegalSettings === 'function') loadLegalSettings(u);
  }
}
function openChat(el) {
  document.querySelectorAll('.inbox-item').forEach(i => i.classList.remove('active'));
  el.classList.add('active');
  const d = el.querySelector('.unread-dot'); if (d) d.remove();
}

// ─── Block definitions ────────────────────────
// ── FASE 3.5 — cores refinadas: tons suaves para tema escuro ──
// Paleta dessaturada e elegante. Sem saturação excessiva.
// Cada cor funciona como accent suave, não como destaque berrante.
const DEFS = [
  { t:'inicio',    n:'Início',           ic:'ti-player-play',    c:'#34d399', cat:'Gatilho',   d:'Ponto de entrada do fluxo',          outs:['Saída'],       fs:[{id:'trigger',l:'Gatilho',tp:'sel',o:['Mensagem recebida','Palavra-chave','Horário']},{id:'kw',l:'Palavra-chave',tp:'text',ph:'oi, olá'}] },
  { t:'mensagem',  n:'Mensagem',         ic:'ti-message',        c:'#00c8f0', cat:'Conteúdo',  d:'Enviar texto ao contacto',           outs:['Próximo'],     fs:[{id:'txt',l:'Mensagem',tp:'area',ph:'Escreva aqui...'},{id:'delay',l:'Atraso (seg)',tp:'num',ph:'1'}] },
  { t:'pergunta',  n:'Pergunta',         ic:'ti-help-circle',    c:'#a78bfa', cat:'Interação', d:'Aguardar resposta do cliente',       outs:['Próximo'],     fs:[{id:'txt',l:'Pergunta',tp:'area',ph:'Qual é o seu nome?'},{id:'var',l:'Guardar em variável',tp:'text',ph:'{{nome}}'}] },
  { t:'condicao',  n:'Condição (Em breve)',         ic:'ti-git-fork',       c:'#fb923c', cat:'Lógica',    d:'Bifurcar fluxo por condição — execução ainda não implementada',        outs:['Sim','Não'],   fs:[{id:'var',l:'Variável',tp:'text',ph:'{{resposta}}'},{id:'op',l:'Operador',tp:'sel',o:['igual a','contém','começa com','é número','não vazio']},{id:'val',l:'Valor',tp:'text',ph:'1'}] },
  { t:'aguardar',  n:'Aguardar Resposta',ic:'ti-clock',          c:'#a78bfa', cat:'Interação', d:'Esperar resposta do utilizador',     outs:['Recebida','Timeout'], fs:[{id:'to',l:'Timeout (min)',tp:'num',ph:'30'},{id:'var',l:'Guardar em',tp:'text',ph:'{{resposta}}'}] },
  { t:'imagem',    n:'Imagem (Em breve)',           ic:'ti-photo',          c:'#00c8f0', cat:'Média',     d:'Enviar imagem — execução ainda não implementada',                      outs:['Próximo'],     fs:[{id:'url',l:'URL da imagem',tp:'text',ph:'https://...'},{id:'cap',l:'Legenda',tp:'text',ph:'(opcional)'}] },
  { t:'video',     n:'Vídeo (Em breve)',            ic:'ti-video',          c:'#00c8f0', cat:'Média',     d:'Enviar vídeo — execução ainda não implementada',                       outs:['Próximo'],     fs:[{id:'url',l:'URL do vídeo',tp:'text',ph:'https://...'},{id:'cap',l:'Legenda',tp:'text',ph:''}] },
  { t:'audio',     n:'Áudio (Em breve)',            ic:'ti-microphone',     c:'#00c8f0', cat:'Média',     d:'Enviar mensagem de voz ou áudio — execução ainda não implementada',    outs:['Próximo'],     fs:[{id:'url',l:'URL do áudio',tp:'text',ph:'https://...'}] },
  { t:'documento', n:'Documento (Em breve)',        ic:'ti-file',           c:'#94a3b8', cat:'Média',     d:'Enviar ficheiro / PDF — execução ainda não implementada',              outs:['Próximo'],     fs:[{id:'url',l:'URL do ficheiro',tp:'text',ph:'https://...'},{id:'fn',l:'Nome do ficheiro',tp:'text',ph:'catalogo.pdf'}] },
  { t:'botao',     n:'Botão (Em breve)',            ic:'ti-layout-grid',    c:'#00c8f0', cat:'Interação', d:'Menu de botões interactivos — execução ainda não implementada',        outs:['Btn 1','Btn 2','Btn 3'], fs:[{id:'txt',l:'Texto',tp:'area',ph:'Escolha uma opção:'},{id:'btns',l:'Botões (um por linha)',tp:'area',ph:'Opção 1\nOpção 2\nOpção 3'}] },
  { t:'lista',     n:'Lista (Em breve)',            ic:'ti-list',           c:'#00c8f0', cat:'Interação', d:'Lista de opções interactiva — execução ainda não implementada',        outs:['Seleccionado'],fs:[{id:'txt',l:'Texto',tp:'area',ph:'Escolha:'},{id:'bl',l:'Rótulo do botão',tp:'text',ph:'Ver opções'},{id:'items',l:'Itens (um por linha)',tp:'area',ph:'Item 1\nItem 2'}] },
  { t:'tag',       n:'Etiqueta (Em breve)',              ic:'ti-tag',            c:'#a78bfa', cat:'CRM',       d:'Adicionar tag ao contacto — execução ainda não implementada',          outs:['Próximo'],     fs:[{id:'tags',l:'Tags (vírgula)',tp:'text',ph:'cliente, vip'}] },
  { t:'removertag',n:'Remover Etiqueta (Em breve)',      ic:'ti-tag-off',        c:'#f472b6', cat:'CRM',       d:'Remover tag do contacto — execução ainda não implementada',            outs:['Próximo'],     fs:[{id:'tags',l:'Tags a remover',tp:'text',ph:'lead'}] },
  { t:'salvar',    n:'Salvar Resposta',   ic:'ti-device-floppy', c:'#34d399', cat:'CRM',       d:'Guardar resposta em variável',       outs:['Próximo'],     fs:[{id:'src',l:'Guardar',tp:'sel',o:['Última mensagem recebida']}] },
  { t:'transferir',n:'Departamentos (Em breve)',       ic:'ti-user-share',     c:'#34d399', cat:'Acção',     d:'Enviar para atendente humano — execução ainda não implementada',       outs:['Transferido'], fs:[{id:'agent',l:'Agente / Equipa',tp:'text',ph:'Vendas'},{id:'msg',l:'Mensagem ao agente',tp:'area',ph:'Novo cliente...'}] },
  { t:'delay',     n:'Atraso Inteligente',            ic:'ti-hourglass',      c:'#fbbf24', cat:'Controlo',  d:'Aguardar antes de continuar',        outs:['Próximo'],     fs:[{id:'secs',l:'Tempo (segundos)',tp:'num',ph:'3'}] },
  { t:'encerrar',    n:'Conexão de Fluxo',   ic:'ti-square-x',       c:'#f87171', cat:'Controlo',  d:'Terminar o fluxo',                             outs:[],                  fs:[{id:'msg',l:'Mensagem final',tp:'area',ph:'Obrigado! 👋'}] },
  { t:'atraso',       n:'Atraso Inteligente', ic:'ti-clock',          c:'#00c8f0', cat:'Controlo',  d:'Aguardar antes de continuar',                  outs:['Próximo'],          fs:[{id:'secs',l:'Tempo (segundos)',tp:'num',ph:'10'}] },
  { t:'randomizador', n:'Randomizador',       ic:'ti-arrows-shuffle', c:'#fbbf24', cat:'Lógica',    d:'Enviar uma mensagem aleatória entre as opções', outs:['Saída'],            fs:[{id:'msgs',l:'Mensagens (uma por linha)',tp:'area',ph:'Olá!\nOi, tudo bem?\nBom dia!'}] },
  { t:'remarketing',  n:'Remarketing',        ic:'ti-speakerphone',   c:'#fbbf24', cat:'Marketing', d:'Reengajar contacto após inactividade',          outs:['Enviado','Ignorado'],fs:[{id:'msg',l:'Mensagem de reengajamento',tp:'area',ph:'Sentimos a sua falta! Posso ajudar?'},{id:'delayHours',l:'Horas sem resposta',tp:'num',ph:'24'},{id:'maxRetries',l:'Máx. tentativas',tp:'num',ph:'3'}] },
];
const DEF = {};
DEFS.forEach(d => DEF[d.t] = d);

/* ══════════════════════════════════════════════════════════════════
   FASE 2.6 — NodeTypeRegistry
   ──────────────────────────────────────────────────────────────────
   Registo central de todos os tipos de blocos.
   Cada tipo define:
     • schema     — estrutura canónica dos dados (Firebase-ready)
     • defaults   — valores iniciais para novos blocos
     • validate() — validação própria; devolve { valid, errors[] }
     • buildEditor(node, body) — constrói o painel de edição
     • getPreview(data) — texto de pré-visualização no canvas
     • executorHint — metadado para o futuro ExecutorEngine
   ══════════════════════════════════════════════════════════════════ */
const NodeTypeRegistry = (() => {

  // ── Utilitários de edição ────────────────────────────────────────

  function _field(body, id, label, type, value, placeholder, opts) {
    const wrap = document.createElement('div');
    wrap.className = 'pf';
    let inner = `<label>${label}</label>`;
    if (type === 'area') {
      inner += `<textarea id="pf-${id}" placeholder="${placeholder||''}" rows="4">${value||''}</textarea>`;
    } else if (type === 'select') {
      const o = (opts||[]).map(op => `<option${op===value?' selected':''}>${op}</option>`).join('');
      inner += `<select id="pf-${id}">${o}</select>`;
    } else if (type === 'info') {
      inner += `<div style="font-size:11px;color:var(--k-muted);padding:4px 0">${label}</div>`;
      wrap.innerHTML = inner; body.appendChild(wrap); return;
    } else {
      inner += `<input id="pf-${id}" type="${type==='number'?'number':'text'}" value="${value||''}" placeholder="${placeholder||''}">`;
    }
    wrap.innerHTML = inner;
    body.appendChild(wrap);
  }

  function _heading(body, text) {
    const h = document.createElement('div');
    h.style.cssText = 'font-size:10px;color:var(--k-muted);text-transform:uppercase;letter-spacing:.8px;padding:10px 0 4px;border-top:0.5px solid var(--k-border);margin-top:4px';
    h.textContent = text;
    body.appendChild(h);
  }

  // ── Tipo: inicio ────────────────────────────────────────────────
  const inicio = {
    type: 'inicio',
    executorHint: 'trigger',
    schema: { trigger: '', keyword: '', schedule: '' },
    defaults: { trigger: 'Mensagem recebida', keyword: '', schedule: '' },
    validate(data) {
      const errors = [];
      if (!data.trigger) errors.push('Gatilho obrigatório');
      if (data.trigger === 'Palavra-chave' && !data.keyword) errors.push('Palavra-chave obrigatória');
      return { valid: errors.length === 0, errors };
    },
    getPreview(data) { return data.trigger || ''; },
    buildEditor(node, body) {
      _field(body,'trigger','Gatilho','select',node.data.trigger,'',['Mensagem recebida','Palavra-chave','Horário']);
      _field(body,'keyword','Palavra-chave','text',node.data.keyword,'oi, olá, menu');
      _field(body,'schedule','Agendamento (cron)','text',node.data.schedule,'0 9 * * 1-5');
    },
  };

  // ── Tipo: mensagem ──────────────────────────────────────────────
  const mensagem = {
    type: 'mensagem',
    executorHint: 'send_text',
    schema: { text: '', variables: [], delay: 0 },
    defaults: { text: '', variables: [], delay: 1 },
    validate(data) {
      const errors = [];
      if (!data.txt && !data.text) errors.push('Mensagem obrigatória');
      return { valid: errors.length === 0, errors };
    },
    getPreview(data) { return data.txt || data.text || ''; },
    buildEditor(node, body) {
      _field(body,'txt','Mensagem','area',node.data.txt,'Escreva aqui...\n\nUse {{variavel}} para personalizar');
      _field(body,'delay','Atraso antes de enviar (seg)','number',node.data.delay,'1');
      _heading(body,'Variáveis disponíveis');
      _field(body,'vars_hint','','info','','','');
      const hint = document.createElement('div');
      hint.style.cssText='font-size:10px;color:var(--k-muted);padding:0 0 4px;line-height:1.8';
      hint.innerHTML = '{{nome}} &nbsp;{{telefone}} &nbsp;{{email}}<br>{{resposta}} &nbsp;{{opcao}}';
      body.appendChild(hint);
    },
  };

  // ── Tipo: imagem ────────────────────────────────────────────────
  const imagem = {
    type: 'imagem',
    executorHint: 'send_image',
    schema: { imageUrl: '', caption: '' },
    defaults: { imageUrl: '', caption: '' },
    validate(data) {
      const errors = [];
      const url = data.url || data.imageUrl;
      if (!url) errors.push('URL da imagem obrigatório');
      else if (!/^https?:\/\/.+/.test(url)) errors.push('URL inválido (deve começar com https://)');
      return { valid: errors.length === 0, errors };
    },
    getPreview(data) { return data.url || data.imageUrl || ''; },
    buildEditor(node, body) {
      _field(body,'url','URL da imagem','text',node.data.url,'https://exemplo.com/imagem.jpg');
      _field(body,'cap','Legenda (opcional)','text',node.data.cap,'');
      _heading(body,'Pré-visualização');
      const prev = document.createElement('div');
      prev.id = 'img-prev';
      prev.style.cssText = 'margin-top:4px;border-radius:6px;overflow:hidden;max-height:100px;background:var(--k-surface2);display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--k-muted)';
      const url = node.data.url || node.data.imageUrl;
      if (url) {
        const img = document.createElement('img');
        img.src = url; img.style.cssText = 'max-width:100%;max-height:100px;display:block';
        img.onerror = () => { prev.textContent = 'Imagem não encontrada'; };
        prev.appendChild(img);
      } else {
        prev.textContent = 'Sem imagem';
      }
      body.appendChild(prev);
      // Live preview on URL change
      setTimeout(() => {
        const inp = document.getElementById('pf-url');
        if (inp) inp.addEventListener('input', () => {
          const p = document.getElementById('img-prev'); if (!p) return;
          p.innerHTML = '';
          if (inp.value) {
            const img = document.createElement('img');
            img.src = inp.value; img.style.cssText = 'max-width:100%;max-height:100px;display:block';
            img.onerror = () => { p.textContent = 'Imagem não encontrada'; };
            p.appendChild(img);
          } else { p.textContent = 'Sem imagem'; }
        });
      }, 0);
    },
  };

  // ── Tipo: video ─────────────────────────────────────────────────
  const video = {
    type: 'video',
    executorHint: 'send_video',
    schema: { videoUrl: '', caption: '' },
    defaults: { videoUrl: '', caption: '' },
    validate(data) {
      const errors = [];
      const url = data.url || data.videoUrl;
      if (!url) errors.push('URL do vídeo obrigatório');
      return { valid: errors.length === 0, errors };
    },
    getPreview(data) { return data.url || data.videoUrl || ''; },
    buildEditor(node, body) {
      _field(body,'url','URL do vídeo','text',node.data.url,'https://exemplo.com/video.mp4');
      _field(body,'cap','Legenda (opcional)','text',node.data.cap,'');
    },
  };

  // ── Tipo: audio ─────────────────────────────────────────────────
  const audio = {
    type: 'audio',
    executorHint: 'send_audio',
    schema: { audioUrl: '' },
    defaults: { audioUrl: '' },
    validate(data) {
      const errors = [];
      if (!data.url && !data.audioUrl) errors.push('URL do áudio obrigatório');
      return { valid: errors.length === 0, errors };
    },
    getPreview(data) { return data.url || data.audioUrl || ''; },
    buildEditor(node, body) {
      _field(body,'url','URL do áudio','text',node.data.url,'https://exemplo.com/audio.ogg');
    },
  };

  // ── Tipo: documento ─────────────────────────────────────────────
  const documento = {
    type: 'documento',
    executorHint: 'send_document',
    schema: { fileUrl: '', filename: '' },
    defaults: { fileUrl: '', filename: '' },
    validate(data) {
      const errors = [];
      if (!data.url && !data.fileUrl) errors.push('URL do ficheiro obrigatório');
      return { valid: errors.length === 0, errors };
    },
    getPreview(data) { return data.fn || data.filename || data.url || ''; },
    buildEditor(node, body) {
      _field(body,'url','URL do ficheiro','text',node.data.url,'https://exemplo.com/catalogo.pdf');
      _field(body,'fn','Nome do ficheiro','text',node.data.fn,'catalogo.pdf');
    },
  };

  // ── Tipo: pergunta ──────────────────────────────────────────────
  const pergunta = {
    type: 'pergunta',
    executorHint: 'ask_question',
    schema: { text: '', variable: '' },
    defaults: { text: '', variable: '' },
    validate(data) {
      const errors = [];
      if (!data.txt && !data.text) errors.push('Pergunta obrigatória');
      if (!data.var && !data.variable) errors.push('Variável de destino obrigatória');
      return { valid: errors.length === 0, errors };
    },
    getPreview(data) { return data.txt || data.text || ''; },
    buildEditor(node, body) {
      _field(body,'txt','Pergunta','area',node.data.txt,'Qual é o seu nome?');
      _field(body,'var','Guardar resposta em variável','text',node.data.var,'{{nome}}');
    },
  };

  // ── Tipo: aguardar ──────────────────────────────────────────────
  const aguardar = {
    type: 'aguardar',
    executorHint: 'wait_reply',
    schema: { timeoutMinutes: 30, variable: '' },
    defaults: { timeoutMinutes: 30, variable: '' },
    validate(data) {
      const errors = [];
      const to = parseInt(data.to || data.timeoutMinutes);
      if (isNaN(to) || to <= 0) errors.push('Timeout deve ser maior que 0');
      return { valid: errors.length === 0, errors };
    },
    getPreview(data) {
      const to = data.to || data.timeoutMinutes;
      return to ? `Timeout: ${to} min` : '';
    },
    buildEditor(node, body) {
      _field(body,'to','Timeout (minutos)','number',node.data.to,'30');
      _field(body,'var','Guardar resposta em','text',node.data.var,'{{resposta}}');
    },
  };

  // ── Tipo: botao ─────────────────────────────────────────────────
  const botao = {
    type: 'botao',
    executorHint: 'send_buttons',
    schema: { text: '', buttons: [] },
    defaults: { text: '', buttons: [] },
    validate(data) {
      const errors = [];
      if (!data.txt && !data.text) errors.push('Texto obrigatório');
      if (!data.btns && !data.buttons?.length) errors.push('Pelo menos um botão obrigatório');
      return { valid: errors.length === 0, errors };
    },
    getPreview(data) { return data.txt || data.text || ''; },
    buildEditor(node, body) {
      _field(body,'txt','Texto da mensagem','area',node.data.txt,'Escolha uma opção:');
      _field(body,'btns','Botões (um por linha)','area',node.data.btns,'Opção 1\nOpção 2\nOpção 3');
    },
  };

  // ── Tipo: lista ─────────────────────────────────────────────────
  const lista = {
    type: 'lista',
    executorHint: 'send_list',
    schema: { text: '', buttonLabel: '', items: [] },
    defaults: { text: '', buttonLabel: 'Ver opções', items: [] },
    validate(data) {
      const errors = [];
      if (!data.txt && !data.text) errors.push('Texto obrigatório');
      if (!data.items && !data.items?.length) errors.push('Pelo menos um item obrigatório');
      return { valid: errors.length === 0, errors };
    },
    getPreview(data) { return data.txt || data.text || ''; },
    buildEditor(node, body) {
      _field(body,'txt','Texto','area',node.data.txt,'Escolha:');
      _field(body,'bl','Rótulo do botão','text',node.data.bl,'Ver opções');
      _field(body,'items','Itens (um por linha)','area',node.data.items,'Item 1\nItem 2\nItem 3');
    },
  };

  // ── Tipo: condicao ──────────────────────────────────────────────
  const condicao = {
    type: 'condicao',
    executorHint: 'condition',
    schema: { field: '', operator: '', value: '' },
    defaults: { field: '', operator: 'igual a', value: '' },
    validate(data) {
      const errors = [];
      const field = data.var || data.field;
      const op    = data.op  || data.operator;
      if (!field) errors.push('Campo / variável obrigatório');
      if (!op)    errors.push('Operador obrigatório');
      return { valid: errors.length === 0, errors };
    },
    getPreview(data) {
      const f = data.var || data.field;
      const o = data.op  || data.operator;
      const v = data.val || data.value;
      return f ? `${f} ${o} ${v}` : '';
    },
    buildEditor(node, body) {
      _field(body,'var','Variável','text',node.data.var,'{{resposta}}');
      _field(body,'op','Operador','select',node.data.op,'',['igual a','diferente de','contém','não contém','começa com','é número','não vazio','vazio']);
      _field(body,'val','Valor de comparação','text',node.data.val,'1');
    },
  };

  // ── Tipo: webhook ───────────────────────────────────────────────
  const webhook = {
    type: 'webhook',
    executorHint: 'http_request',
    schema: { url: '', method: 'POST', headers: {}, body: {} },
    defaults: { url: '', method: 'POST', headers: '', body: '' },
    validate(data) {
      const errors = [];
      if (!data.url) errors.push('URL obrigatório');
      else if (!/^https?:\/\/.+/.test(data.url)) errors.push('URL inválido');
      if (!data.method) errors.push('Método HTTP obrigatório');
      return { valid: errors.length === 0, errors };
    },
    getPreview(data) {
      return data.url ? `${data.method||'POST'} ${data.url}` : '';
    },
    buildEditor(node, body) {
      _field(body,'url','URL do Webhook','text',node.data.url,'https://meuservidor.com/webhook');
      _field(body,'method','Método HTTP','select',node.data.method,'',['POST','GET','PUT','PATCH','DELETE']);
      _heading(body,'Headers (JSON)');
      _field(body,'headers','','area',
        typeof node.data.headers === 'object' ? JSON.stringify(node.data.headers, null, 2) : node.data.headers,
        '{"Authorization": "Bearer TOKEN"}');
      _heading(body,'Body (JSON)');
      _field(body,'body','','area',
        typeof node.data.body === 'object' ? JSON.stringify(node.data.body, null, 2) : node.data.body,
        '{"evento": "novo_lead", "telefone": "{{telefone}}"}');
    },
  };

  // ── Tipo: api (alias webhook, orientado a leitura de dados) ─────
  const api = {
    type: 'api',
    executorHint: 'api_call',
    schema: { endpoint: '', method: 'GET', headers: {}, payload: {}, resultVariable: '' },
    defaults: { endpoint: '', method: 'GET', headers: '', payload: '', resultVariable: '{{api_resultado}}' },
    validate(data) {
      const errors = [];
      const ep = data.endpoint || data.url;
      if (!ep) errors.push('Endpoint obrigatório');
      else if (!/^https?:\/\/.+/.test(ep)) errors.push('Endpoint inválido');
      return { valid: errors.length === 0, errors };
    },
    getPreview(data) {
      const ep = data.endpoint || data.url;
      return ep ? `${data.method||'GET'} ${ep}` : '';
    },
    buildEditor(node, body) {
      _field(body,'endpoint','Endpoint / URL','text',node.data.endpoint,'https://api.exemplo.com/dados');
      _field(body,'method','Método','select',node.data.method,'',['GET','POST','PUT','PATCH','DELETE']);
      _field(body,'resultVariable','Guardar resultado em','text',node.data.resultVariable,'{{api_resultado}}');
      _heading(body,'Headers (JSON)');
      _field(body,'headers','','area',
        typeof node.data.headers==='object'?JSON.stringify(node.data.headers,null,2):node.data.headers,
        '{"Authorization":"Bearer TOKEN"}');
      _heading(body,'Payload (JSON)');
      _field(body,'payload','','area',
        typeof node.data.payload==='object'?JSON.stringify(node.data.payload,null,2):node.data.payload,
        '{}');
    },
  };

  // ── Tipo: tag ────────────────────────────────────────────────────
  const tag = {
    type: 'tag',
    executorHint: 'crm_tag_add',
    schema: { tags: [] },
    defaults: { tags: '' },
    validate(data) {
      const errors = [];
      if (!data.tags) errors.push('Pelo menos uma tag obrigatória');
      return { valid: errors.length === 0, errors };
    },
    getPreview(data) { return data.tags || ''; },
    buildEditor(node, body) {
      _field(body,'tags','Tags (separadas por vírgula)','text',node.data.tags,'cliente, vip, lead');
    },
  };

  // ── Tipo: removertag ─────────────────────────────────────────────
  const removertag = {
    type: 'removertag',
    executorHint: 'crm_tag_remove',
    schema: { tags: [] },
    defaults: { tags: '' },
    validate(data) {
      const errors = [];
      if (!data.tags) errors.push('Pelo menos uma tag obrigatória');
      return { valid: errors.length === 0, errors };
    },
    getPreview(data) { return data.tags || ''; },
    buildEditor(node, body) {
      _field(body,'tags','Tags a remover (vírgula)','text',node.data.tags,'lead');
    },
  };

  // ── Tipo: transferir ─────────────────────────────────────────────
  const transferir = {
    type: 'transferir',
    executorHint: 'transfer_agent',
    schema: { department: '', userId: '' },
    defaults: { department: '', userId: '' },
    validate(data) {
      const errors = [];
      const dept = data.agent || data.department;
      if (!dept) errors.push('Departamento ou agente obrigatório');
      return { valid: errors.length === 0, errors };
    },
    getPreview(data) { return data.agent || data.department || ''; },
    buildEditor(node, body) {
      _field(body,'agent','Departamento / Agente','text',node.data.agent,'Vendas');
      _field(body,'msg','Mensagem ao agente','area',node.data.msg,'Novo cliente aguarda atendimento.');
    },
  };

  // ── Tipo: delay ──────────────────────────────────────────────────
  const delay = {
    type: 'delay',
    executorHint: 'wait_fixed',
    schema: { seconds: 3 },
    defaults: { secs: 3 },
    validate(data) {
      const errors = [];
      const s = parseInt(data.secs || data.seconds);
      if (isNaN(s) || s < 0) errors.push('Tempo deve ser 0 ou maior');
      return { valid: errors.length === 0, errors };
    },
    getPreview(data) {
      const s = data.secs || data.seconds;
      return s ? `${s} seg` : '';
    },
    buildEditor(node, body) {
      _field(body,'secs','Tempo (segundos)','number',node.data.secs,'3');
    },
  };

  // ── Tipo: encerrar ───────────────────────────────────────────────
  const encerrar = {
    type: 'encerrar',
    executorHint: 'end_flow',
    schema: { reason: '' },
    defaults: { reason: '' },
    validate(_data) { return { valid: true, errors: [] }; },
    getPreview(data) { return data.msg || data.reason || 'Fim do fluxo'; },
    buildEditor(node, body) {
      _field(body,'msg','Mensagem final (opcional)','area',node.data.msg,'Obrigado! 👋');
    },
  };

  // ── Tipos novos: webhook e api (para o picker) ─────────────────
  // Registados em DEFS se ainda não existirem
  const _extraTypes = [
    { t:'webhook', n:'Webhook (Em breve)',   ic:'ti-webhook',  c:'#00c8f0', cat:'Integração', d:'Enviar dados para URL externa — execução ainda não implementada', outs:['Sucesso','Erro'], fs:[] },
    { t:'api',     n:'API Call (Em breve)',  ic:'ti-api',      c:'#22c55e', cat:'Integração', d:'Consultar API externa — execução ainda não implementada',         outs:['Sucesso','Erro'], fs:[] },
  ];
  _extraTypes.forEach(et => { if (!DEF[et.t]) { DEFS.push(et); DEF[et.t] = et; } });


  // ── Tipo: atraso ────────────────────────────────────────────────
  const atraso = {
    type: 'atraso',
    executorHint: 'wait_fixed',
    schema: { secs: 10 },
    defaults: { secs: 10 },
    validate(data) {
      const errors = [];
      const s = parseInt(data.secs);
      if (isNaN(s) || s < 0) errors.push('Tempo deve ser 0 ou maior');
      return { valid: errors.length === 0, errors };
    },
    getPreview(data) {
      const s = data.secs || 10;
      return `${s} segundo${s == 1 ? '' : 's'}`;
    },
    buildEditor(node, body) {
      _field(body, 'secs', 'Tempo de espera (segundos)', 'number', node.data.secs, '10');
    },
  };

  // ── Tipo: randomizador ──────────────────────────────────────────
  const randomizador = {
    type: 'randomizador',
    executorHint: 'send_text',
    schema: { msgs: '' },
    defaults: { msgs: '' },
    validate(data) {
      const errors = [];
      if (!data.msgs || !data.msgs.trim()) errors.push('Pelo menos uma mensagem obrigatória');
      return { valid: errors.length === 0, errors };
    },
    getPreview(data) {
      const lines = (data.msgs || '').split('\n').filter(Boolean);
      return lines.length ? `${lines.length} mensagem${lines.length > 1 ? 'ns' : ''}` : '';
    },
    buildEditor(node, body) {
      _heading(body, 'Mensagens aleatórias');
      _field(body, 'msgs', 'Escreva uma mensagem por linha — o sistema escolhe aleatoriamente', 'area', node.data.msgs, 'Olá!\nOi, tudo bem?\nBom dia! Como posso ajudar?');
    },
  };

  // ── Tipo: remarketing ───────────────────────────────────────────
  const remarketing = {
    type: 'remarketing',
    executorHint: 'send_text',
    schema: { msg: '', delayHours: 24, maxRetries: 3 },
    defaults: { msg: '', delayHours: 24, maxRetries: 3 },
    validate(data) {
      const errors = [];
      if (!data.msg || !data.msg.trim()) errors.push('Mensagem de reengajamento obrigatória');
      const h = parseInt(data.delayHours);
      if (isNaN(h) || h < 1) errors.push('Horas de espera deve ser pelo menos 1');
      return { valid: errors.length === 0, errors };
    },
    getPreview(data) {
      return data.msg ? data.msg.slice(0, 40) + (data.msg.length > 40 ? '…' : '') : '';
    },
    buildEditor(node, body) {
      _field(body, 'msg', 'Mensagem de reengajamento', 'area', node.data.msg, 'Sentimos a sua falta! Posso ajudar com algo? 😊');
      _field(body, 'delayHours', 'Enviar após X horas sem resposta', 'number', node.data.delayHours, '24');
      _field(body, 'maxRetries', 'Máximo de tentativas', 'number', node.data.maxRetries, '3');
    },
  };

  // ── Registry map ────────────────────────────────────────────────
  const _registry = {
    inicio, mensagem, imagem, video, audio, documento,
    pergunta, aguardar, botao, lista, condicao,
    webhook, api, tag, removertag, transferir, delay, encerrar,
    atraso, randomizador, remarketing,
  };

  /**
   * get(type) → type definition from registry (or null).
   * Falls back gracefully for unknown types.
   */
  function get(type) { return _registry[type] || null; }

  /**
   * validate(node) → { valid, errors[] }
   * Runs the type-specific validator, or returns valid if type unknown.
   */
  function validate(node) {
    const def = _registry[node.t];
    if (!def) return { valid: true, errors: [] };
    try { return def.validate(node.data || {}); }
    catch(e) { return { valid: false, errors: [String(e)] }; }
  }

  /**
   * buildEditor(node, bodyEl)
   * Clears bodyEl and populates it with the type-specific editor fields.
   * Returns false if type unknown (falls back to generic).
   */
  function buildEditor(node, bodyEl) {
    const def = _registry[node.t];
    if (!def) return false;
    def.buildEditor(node, bodyEl);
    return true;
  }

  /**
   * getPreview(node) → short string for canvas node body.
   */
  function getPreview(node) {
    const def = _registry[node.t];
    if (!def) return '';
    return def.getPreview(node.data || '') || '';
  }

  /**
   * getDefaultData(type) → clean default data object for new nodes.
   */
  function getDefaultData(type) {
    const def = _registry[type];
    return def ? { ...def.defaults } : {};
  }

  /**
   * getAllTypes() → array of all registered type keys.
   * Used by future ExecutorEngine to enumerate known types.
   */
  function getAllTypes() { return Object.keys(_registry); }

  /**
   * getExecutorHint(type) → string hint for ExecutorEngine.
   */
  function getExecutorHint(type) {
    const def = _registry[type];
    return def ? def.executorHint : null;
  }

  return { get, validate, buildEditor, getPreview, getDefaultData, getAllTypes, getExecutorHint };
})();


// ─── State ────────────────────────────────────
let nodes = [];  // {id,t,x,y,lbl,data}
let edges = [];  // {id,fr,fp,to}
let sel = new Set();
let selEdge = null;  // selected edge id
let clipboard = [];
let hist = [];
let histIdx = -1;
let zoom = 1;
let panX = 80, panY = 60;
let activeId = null;
let connecting = null;
let saveTimer = null;
// FASE 5.3 — IDs dos nós inicio duplicados para destaque visual (borda vermelha)
let _multiStartErrorIds = new Set();

/* ══════════════════════════════════════════════════════════
   FASE 2.5 — PERFORMANCE ENGINE
   ──────────────────────────────────────────────────────────
   Índices O(1) para eliminar loops `.find()` / `.some()`
   em hot-paths de drag, renderização de arestas e selecção.
   ══════════════════════════════════════════════════════════ */

/**
 * NodeMap — lookup de nós por ID em O(1).
 * Actualizado em _rebuildIndex() após qualquer mutação estrutural.
 */
const NodeMap = new Map(); // id → node object
const EdgeMap  = new Map(); // id → edge object  ← O(1) lookup by edge id

/**
 * EdgeIndex — para cada nodeId, lista de arestas que tocam esse nó
 * (como origem ou destino). Permite recalcular só arestas afectadas.
 * Estrutura: Map<nodeId, Set<edgeId>>
 */
const EdgeIndex = new Map();

/** Rebuilds NodeMap + EdgeIndex. Called after any structural mutation. */
function _rebuildIndex() {
  NodeMap.clear();
  nodes.forEach(n => NodeMap.set(n.id, n));

  EdgeMap.clear();
  EdgeIndex.clear();
  edges.forEach(e => {
    EdgeMap.set(e.id, e);
    if (!EdgeIndex.has(e.fr)) EdgeIndex.set(e.fr, new Set());
    if (!EdgeIndex.has(e.to)) EdgeIndex.set(e.to, new Set());
    EdgeIndex.get(e.fr).add(e.id);
    EdgeIndex.get(e.to).add(e.id);
  });
}

/** Returns edge objects that touch a given nodeId. O(degree). */
function _edgesFor(nodeId) {
  const ids = EdgeIndex.get(nodeId);
  if (!ids) return [];
  return [...ids].map(id => EdgeMap.get(id)).filter(Boolean);
}

/** Returns edge objects that touch any of the given nodeIds. */
function _edgesForSet(nodeIds) {
  const result = new Map(); // edgeId → edge (deduplicated)
  nodeIds.forEach(nid => {
    _edgesFor(nid).forEach(e => result.set(e.id, e));
  });
  return Array.from(result.values());
}

/**
 * FASE 2.7 — Actualiza contadores de blocos e conexões na toolbar.
 * Chamado em render() (blocos) e renderEdges() (conexões).
 */
function _updateCounters() {
  const bc = document.getElementById('fb-block-count');
  const ec = document.getElementById('fb-edge-count');
  if (bc) bc.textContent = nodes.length;
  if (ec) ec.textContent = edges.length;
}

/**
 * rAF gate — ensures at most one minimap redraw per animation frame
 * during drag (where it can fire 60+ times/sec otherwise).
 */
let _miniRafPending = false;
function _schedMini() {
  if (_miniRafPending) return;
  _miniRafPending = true;
  requestAnimationFrame(() => { _miniRafPending = false; drawMini(); });
}

/**
 * Partial SVG edge redraw — redraws only the <g> elements for a
 * specific set of edge IDs, leaving all others untouched.
 * Used during drag to avoid full SVG teardown + rebuild.
 */
function _redrawEdgesPartial(edgeObjs) {
  const s = SV(); if (!s) return;
  const canvRect = cvs().getBoundingClientRect();
  edgeObjs.forEach(e => {
    const existing = s.querySelector(`g[data-eid="${e.id}"]`);
    const built = _buildEdgeGroup(e, canvRect);
    if (!built) { if (existing) existing.remove(); return; }
    if (existing) s.replaceChild(built, existing);
    else s.appendChild(built);
  });
}

/** Builds and returns a single SVG <g> for an edge. Returns null if nodes missing. */
function _buildEdgeGroup(e, canvRect) {
  const fn = nEl(e.fr), tn = nEl(e.to);
  if (!fn || !tn) return null;
  const op = fn.querySelector(`.fb-port[data-pp="${e.fp}"]`) || fn.querySelector('.fb-port.out-p');
  const ip = tn.querySelector('.fb-port.in-p');
  if (!op || !ip) return null;

  const or2 = op.getBoundingClientRect(), ir2 = ip.getBoundingClientRect();
  // Saída: centro da porta de saída (lado direito do bloco)
  const x1 = (or2.left + or2.width/2  - canvRect.left) / zoom;
  const y1 = (or2.top  + or2.height/2 - canvRect.top)  / zoom;
  // Entrada: centro da porta de entrada (lado esquerdo do bloco seguinte)
  const x2 = (ir2.left + ir2.width/2  - canvRect.left) / zoom;
  const y2 = (ir2.top  + ir2.height/2 - canvRect.top)  / zoom;
  // Bezier horizontal — as alças saem/entram na horizontal
  const cx = Math.max(Math.abs(x2 - x1) * 0.5, 60);
  const d  = `M${x1},${y1} C${x1+cx},${y1} ${x2-cx},${y2} ${x2},${y2}`;

  const isSel = selEdge === e.id;
  let stroke = '#0078f0', mid = 'm0', midSel = 'm0s';
  if (['Sim','Recebida','Seleccionado','Transferido','Saída'].includes(e.fp)) { stroke = '#22c55e'; mid = 'm1'; midSel = 'm1s'; }
  else if (['Não','Timeout'].includes(e.fp)) { stroke = '#f59e0b'; mid = 'm2'; midSel = 'm2s'; }

  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.dataset.eid = e.id;
  if (isSel) g.classList.add('edge-selected');

  const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  hit.setAttribute('d', d); hit.setAttribute('stroke', 'transparent');
  hit.setAttribute('stroke-width', '14'); hit.setAttribute('fill', 'none');
  hit.style.cursor = 'pointer'; hit.style.pointerEvents = 'stroke';

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d); path.setAttribute('fill', 'none');
  path.style.pointerEvents = 'none';
  if (isSel) {
    path.setAttribute('stroke', '#00c8f0'); path.setAttribute('stroke-width', '2.8');
    path.setAttribute('opacity', '1'); path.setAttribute('marker-end', `url(#${midSel})`);
  } else {
    path.setAttribute('stroke', stroke); path.setAttribute('stroke-width', '1.8');
    path.setAttribute('opacity', '.75'); path.setAttribute('marker-end', `url(#${mid})`);
  }

  // Attach interaction handlers once per group (no orphans)
  hit.addEventListener('mousedown', ev => {
    if (ev.button !== 0) return;
    ev.stopPropagation(); closeEdgeCtx();
    sel.clear(); updateSel();
    selEdge = (selEdge === e.id) ? null : e.id;
    renderEdges();
  });
  hit.addEventListener('contextmenu', ev => {
    ev.preventDefault(); ev.stopPropagation();
    sel.clear(); updateSel(); selEdge = e.id;
    renderEdges(); showEdgeCtx(ev, e.id);
  });

  g.appendChild(hit); g.appendChild(path);

  if (e.fp && !['Próximo','Saída','in'].includes(e.fp)) {
    const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    txt.setAttribute('x', (x1+x2)/2); txt.setAttribute('y', (y1+y2)/2 - 4);
    txt.setAttribute('text-anchor', 'middle'); txt.setAttribute('font-size', '9');
    txt.setAttribute('fill', isSel ? '#00c8f0' : stroke);
    txt.setAttribute('opacity', isSel ? '1' : '.7');
    txt.style.pointerEvents = 'none'; txt.textContent = e.fp;
    g.appendChild(txt);
  }
  return g;
}
// ── ID generators — garantem unicidade dentro da sessão ──
let _nodeCounter = Date.now();
let _edgeCounter = Date.now() + 1;

function uid() {
  _nodeCounter++;
  // NodeMap is O(1) — no .some() loop needed
  while (NodeMap.has(_nodeCounter)) _nodeCounter++;
  return _nodeCounter;
}

// Separate Set for edge IDs for O(1) lookup
const _edgeIdSet = new Set();

function eid() {
  _edgeCounter++;
  while (_edgeIdSet.has(_edgeCounter)) _edgeCounter++;
  _edgeIdSet.add(_edgeCounter);
  return _edgeCounter;
}

function _syncCounters() {
  if (nodes.length) _nodeCounter = Math.max(...nodes.map(n => n.id), _nodeCounter);
  if (edges.length) {
    _edgeCounter = Math.max(...edges.map(e => e.id), _edgeCounter);
    _edgeIdSet.clear();
    edges.forEach(e => _edgeIdSet.add(e.id));
  }
}

// ─── History ──────────────────────────────────
function push() {
  // Deep-clone only data needed for undo — avoids holding DOM references
  const s = JSON.stringify({nodes, edges});
  hist.splice(histIdx + 1);
  hist.push(s);
  if (hist.length > 60) hist.shift(); // cap: 60 states ~= reasonable memory budget
  histIdx = hist.length - 1;
  _rebuildIndex(); // keep indices in sync after every structural change
  schedSave();
}

function fbUndo() {
  if (histIdx <= 0) { toast('Nada para desfazer'); return; }
  histIdx--;
  const s = JSON.parse(hist[histIdx]);
  nodes = s.nodes; edges = s.edges; sel.clear();
  _rebuildIndex(); _syncCounters();
  render(); toast('Desfeito');
}
function fbRedo() {
  if (histIdx >= hist.length - 1) { toast('Nada para refazer'); return; }
  histIdx++;
  const s = JSON.parse(hist[histIdx]);
  nodes = s.nodes; edges = s.edges; sel.clear();
  _rebuildIndex(); _syncCounters();
  render(); toast('Refeito');
}

// ─── Demo data ────────────────────────────────
// FASE 3.1.1 — initDemo() removido.
// O sistema arranca vazio. Utilizadores novos vêem "Nenhum fluxo encontrado".

// ─── Render ───────────────────────────────────
const cvs = () => document.getElementById('fb-canvas');
const SV  = () => document.getElementById('fb-svg');

// O(1) DOM lookup via data attribute (querySelector is already O(subtree) but
// we cache the canvas reference to avoid repeated getElementById calls)
let _cvsCached = null;
function nEl(id) {
  if (!_cvsCached || !_cvsCached.isConnected) _cvsCached = cvs();
  return _cvsCached ? _cvsCached.querySelector(`.fb-node[data-nid="${id}"]`) : null;
}

function render() {
  const c = cvs(); if (!c) return;
  _cvsCached = c;

  // Remove only node elements (not SVG) using a single pass
  const toRemove = [];
  for (const ch of c.children) { if (ch !== SV()) toRemove.push(ch); }
  toRemove.forEach(ch => c.removeChild(ch));

  // Build all nodes into a DocumentFragment — single reflow
  const frag = document.createDocumentFragment();
  const nodeEls = nodes.map(n => { const el = mkNode(n); frag.appendChild(el); return el; });
  c.appendChild(frag);
  // Position right-side output ports after nodes are in the DOM (need layout info)
  nodeEls.forEach(el => { if (el._positionOutPorts) el._positionOutPorts(); });

  // Show/hide empty state
  const emptyEl = document.getElementById('canvas-empty-state');
  if (emptyEl) emptyEl.style.display = nodes.length === 0 ? 'flex' : 'none';

  renderEdges();
  drawMini();
  _updateCounters();
}

// ── FASE NODE-LR — mkNode com portas esquerda/direita e preview composto ──
// Entrada → ponto esquerdo centrado verticalmente no bloco inteiro.
// Saídas  → pontos direitos, um por output, alinhados com a sua linha no corpo.
// Bloco Início → sem porta de entrada.
// Blocos compostos (_items) → preview inline com ícone + texto truncado.
function mkNode(n) {
  const def = DEF[n.t] || DEFS[0];
  const el  = document.createElement('div');
  el.className = 'fb-node' + (sel.has(n.id) ? ' selected' : '');
  el.dataset.nid = n.id;
  el.dataset.t   = n.t;
  el.style.cssText = `left:${n.x}px;top:${n.y}px;z-index:2`;

  // FASE 5.3 — Destaque visual: borda vermelha em nós inicio duplicados
  if (n.t === 'inicio' && _multiStartErrorIds.has(n.id)) {
    el.style.cssText += `;outline:2px solid #ef4444;outline-offset:2px;box-shadow:0 0 0 4px rgba(239,68,68,.18)`;
  }

  // Cor do tipo → CSS variables
  const col = def.c || '#60a5fa';
  const hex = col.startsWith('#') ? col : '#60a5fa';
  const r   = parseInt(hex.slice(1,3),16);
  const g   = parseInt(hex.slice(3,5),16);
  const b   = parseInt(hex.slice(5,7),16);
  el.style.setProperty('--node-color',        col);
  el.style.setProperty('--node-color-bg',     `rgba(${r},${g},${b},.11)`);
  el.style.setProperty('--node-color-border', `rgba(${r},${g},${b},.20)`);
  el.style.setProperty('--node-rgb',          `${r},${g},${b}`);
  el.style.setProperty('--node-head-bg',      `rgba(${r},${g},${b},.13)`);

  // ── Preview do corpo ────────────────────────────────────────────
  // Ícones por sub-tipo para preview composto
  const _ITEM_ICONS = {
    mensagem:  'ti-message',    imagem:  'ti-photo',
    video:     'ti-video',      audio:   'ti-microphone',
    documento: 'ti-file',       delay:   'ti-clock',
    botao:     'ti-layout-grid',lista:   'ti-list',
    pergunta:  'ti-help-circle',aguardar:'ti-clock',
    tag:       'ti-tag',        removertag:'ti-tag-off',
  };

  let bodyLines = []; // array de { html, isDelay } para alinhar com ports

  const items = n.data && n.data._items;
  if (items && items.length) {
    // Bloco composto — mostrar cada item como linha compacta
    items.forEach((it, idx) => {
      const itDef  = DEF[it.type] || {};
      const ico    = _ITEM_ICONS[it.type] || itDef.ic || 'ti-circle';
      const itCol  = itDef.c || col;
      const isDelay = it.type === 'delay';

      if (isDelay) {
        const secs = (it.data && it.data.secs) ? it.data.secs : '?';
        bodyLines.push({
          html: `<div class="node-item-delay"><i class="ti ti-clock"></i> ${secs} segundo${secs==1?'':'s'}</div>`,
          isDelay: true,
        });
      } else {
        // Texto preview do item
        const firstField = itDef.fs && itDef.fs[0];
        let txt = (it.data && firstField ? it.data[firstField.id] : '') || itDef.d || it.type;
        if (txt.length > 42) txt = txt.slice(0, 40) + '…';
        // Thumbnail de imagem se disponível
        let extra = '';
        if ((it.type === 'imagem') && it.data && it.data.url) {
          extra = `<img class="node-item-thumb" src="${it.data.url}" alt="" onerror="this.style.display='none'">`;
        }
        bodyLines.push({
          html: `<div class="node-item-row" style="--item-color:${itCol}">
            <span class="node-item-ico"><i class="ti ${ico}"></i></span>
            <span class="node-item-txt">${txt}</span>
            ${extra}
          </div>`,
          isDelay: false,
        });
      }
    });
  } else {
    // Bloco simples — preview do primeiro campo
    let prev = '';
    if (n.data && def.fs && def.fs[0]) prev = n.data[def.fs[0].id] || '';
    if (prev.length > 72) prev = prev.slice(0, 70) + '…';

    if (n.t === 'pergunta' || n.t === 'aguardar') {
      const qt = prev || def.d;
      bodyLines.push({ html: `<div class="node-question-preview">
        <div class="node-question-text">${qt}</div>
        <div class="node-question-meta">
          <span class="node-question-chip"><i class="ti ti-message-dots"></i> Aguarda resposta</span>
        </div>
      </div>`, isDelay: false });
    } else if (prev) {
      bodyLines.push({ html: `<span class="node-preview">${prev}</span>`, isDelay: false });
    } else {
      bodyLines.push({ html: `<span class="node-placeholder">${def.d}</span>`, isDelay: false });
    }
  }

  // ── Outputs + portas de saída direita ──────────────────────────
  // Cada output alinha-se com a linha do body correspondente.
  // Para blocos compostos: os outputs alinham-se com as linhas não-delay.
  // Para blocos simples: único output centrado.
  const hasIn = n.t !== 'inicio'; // Início nunca recebe entrada

  // Para botao/lista: outs dinâmicos por nó a partir dos dados reais
  let nodeOuts = def.outs;
  if (n.t === 'botao' && n.data && n.data.btns) {
    const btns = n.data.btns.split('\n').map(b => b.trim()).filter(Boolean);
    if (btns.length > 0) nodeOuts = btns;
  } else if (n.t === 'lista' && n.data && n.data.items) {
    const its = n.data.items.split('\n').map(b => b.trim()).filter(Boolean);
    if (its.length > 0) nodeOuts = its;
  }

  // Para botao/lista: substituir bodyLines por blocos separados por opção
  if ((n.t === 'botao' || n.t === 'lista') && nodeOuts.length > 0) {
    bodyLines = nodeOuts.map(opt => ({
      html: `<div class="node-option-block" style="--node-color:var(--node-color)">${opt}</div>`,
      isDelay: false,
    }));
  }

  // Construir linhas de body sem ports (ports adicionados depois via CSS absolute)
  const bodyHTML = bodyLines.map(l => l.html).join('');

  // Gerar portas de saída — posição top calculada depois via JS (data-out-idx)
  const outPortsHTML = nodeOuts.map((o, i) => {
    const nodeEdgeIds = EdgeIndex.get(n.id);
    const hasConn = nodeEdgeIds ? [...nodeEdgeIds].some(eid2 => {
      const e = EdgeMap.get(eid2); return e && e.fr === n.id && e.fp === o;
    }) : false;
    return `<div class="fb-port out-p" data-pid="${n.id}" data-pp="${o}" data-out-idx="${i}"></div>`;
  }).join('');

  el.innerHTML = `
    ${hasIn ? `<div class="fb-port in-p" data-pid="${n.id}" data-pp="in"></div>` : ''}
    <div class="fb-node-head">
      <div class="fb-node-ico-wrap">
        <i class="ti ${def.ic} fb-node-ico"></i>
      </div>
      <span class="fb-node-lbl">${n.lbl || def.n}</span>
      <div class="fb-node-actions">
        <button class="fb-node-action-btn fb-node-copy" data-action-nid="${n.id}" title="Duplicar bloco">
          <i class="ti ti-copy"></i>
        </button>
        <button class="fb-node-action-btn fb-node-delete" data-action-nid="${n.id}" title="Apagar bloco">
          <i class="ti ti-trash"></i>
        </button>
        <button class="fb-node-opts" data-opts="${n.id}" title="Mais opções">
          <i class="ti ti-dots-vertical"></i>
        </button>
      </div>
    </div>
    <div class="fb-node-body">${bodyHTML}</div>
    ${nodeOuts.length ? `<div class="fb-node-outs-right">${outPortsHTML}</div>` : ''}
  `;

  // ── Posicionar portas de saída alinhadas com o corpo ──────────
  // Feito após inserção no DOM (requestAnimationFrame não necessário aqui
  // porque o nó ainda não foi anexado ao canvas — o alinhamento exacto
  // é feito em _positionOutPorts(), chamado após c.appendChild(frag)).
  el._positionOutPorts = () => _positionOutPorts(el, { ...def, outs: nodeOuts }, bodyLines);

  // ── Listeners ─────────────────────────────────────────────────
  el.addEventListener('mousedown', onNodeDown);
  el.addEventListener('dblclick',  () => openPanel(n.id));
  el.querySelector('.fb-node-opts').addEventListener('click', ev => {
    ev.stopPropagation(); showCtx(ev, n.id);
  });
  el.querySelector('.fb-node-copy').addEventListener('click', ev => {
    ev.stopPropagation(); sel.clear(); sel.add(n.id); duplicateSel(); toast('Bloco duplicado', 'ok');
  });
  el.querySelector('.fb-node-delete').addEventListener('click', ev => {
    ev.stopPropagation(); sel.clear(); sel.add(n.id); deleteSel();
  });
  el.querySelectorAll('.fb-port').forEach(p => p.addEventListener('mousedown', onPortDown));
  el.querySelectorAll('[data-tag-out]').forEach(tag => {
    tag.addEventListener('mousedown', ev => {
      ev.stopPropagation();
      const nid2 = parseInt(tag.dataset.tagNid);
      const port = tag.dataset.tagOut;
      // Iniciar ligação a partir do centro da porta de saída direita correspondente
      const outPort = el.querySelector(`.fb-port.out-p[data-pp="${port}"]`);
      const wr = document.getElementById('fb-wrap').getBoundingClientRect();
      if (outPort) {
        const r2 = outPort.getBoundingClientRect();
        beginConnect(nid2, port,
          (r2.left + r2.width/2  - wr.left - panX) / zoom,
          (r2.top  + r2.height/2 - wr.top  - panY) / zoom
        );
      } else {
        const r2 = tag.getBoundingClientRect();
        beginConnect(nid2, port,
          (r2.right - wr.left - panX) / zoom,
          (r2.top + r2.height/2 - wr.top - panY) / zoom
        );
      }
    });
  });
  return el;
}

/**
 * Posicionar portas de saída (right side) alinhadas com o body.
 * Chamado após o fragmento ser anexado ao canvas.
 */
function _positionOutPorts(el, def, bodyLines) {
  const ports    = el.querySelectorAll('.fb-port.out-p');
  const bodyEl   = el.querySelector('.fb-node-body');
  const headEl   = el.querySelector('.fb-node-head');
  if (!bodyEl || !ports.length) return;

  const elRect   = el.getBoundingClientRect();
  const cnt = def.outs.length;
  if (cnt === 0) return;

  // Para blocos botao/lista: alinhar cada porta com o bloco de opção correspondente
  const optionBlocks = bodyEl.querySelectorAll('.node-option-block');
  if (optionBlocks.length > 0 && optionBlocks.length === ports.length) {
    optionBlocks.forEach((block, i) => {
      const bRect = block.getBoundingClientRect();
      const midY  = bRect.top - elRect.top + bRect.height / 2;
      ports[i].style.top     = midY - 6 + 'px';
      ports[i].style.right   = '-6px';
      ports[i].style.left    = '';
      ports[i].style.bottom  = '';
      ports[i].style.transform = '';
    });
    return;
  }

  if (cnt === 1) {
    // Único output — centrado verticalmente no bloco inteiro
    const midY = (elRect.height / 2);
    ports[0].style.top  = midY - 6 + 'px';
    ports[0].style.right = '-6px';
    ports[0].style.left  = '';
    ports[0].style.bottom = '';
    ports[0].style.transform = '';
    return;
  }

  // Múltiplos outputs — distribuídos uniformemente na área do body
  const bodyRect = bodyEl.getBoundingClientRect();
  const bodyTop = bodyRect.top - elRect.top;
  const bodyH   = bodyRect.height;
  ports.forEach((port, i) => {
    const frac = (i + 1) / (cnt + 1);
    const topY = bodyTop + bodyH * frac;
    port.style.top     = topY - 6 + 'px';
    port.style.right   = '-6px';
    port.style.left    = '';
    port.style.bottom  = '';
    port.style.transform = '';
  });
}

// ─── Edge rendering ───────────────────────────
// Persistent <defs> block — created once, never torn down
const _SVG_DEFS = `<defs>
  <marker id="m0"  markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto"><path d="M0,0 L0,7 L9,3.5 z" fill="#0078f0" opacity=".7"/></marker>
  <marker id="m1"  markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto"><path d="M0,0 L0,7 L9,3.5 z" fill="#22c55e" opacity=".8"/></marker>
  <marker id="m2"  markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto"><path d="M0,0 L0,7 L9,3.5 z" fill="#f59e0b" opacity=".8"/></marker>
  <marker id="m0s" markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto"><path d="M0,0 L0,7 L9,3.5 z" fill="#00c8f0"/></marker>
  <marker id="m1s" markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto"><path d="M0,0 L0,7 L9,3.5 z" fill="#4ade80"/></marker>
  <marker id="m2s" markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto"><path d="M0,0 L0,7 L9,3.5 z" fill="#fbbf24"/></marker>
</defs>`;

// Persistent live-connection line element (reused, not recreated each frame)
let _liveLineEl = null;

function _ensureSvgDefs(s) {
  if (!s.querySelector('defs')) {
    s.insertAdjacentHTML('afterbegin', _SVG_DEFS);
  }
}

function _ensureLiveLine(s) {
  if (!_liveLineEl || !s.contains(_liveLineEl)) {
    _liveLineEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    _liveLineEl.setAttribute('fill', 'none');
    _liveLineEl.setAttribute('stroke', '#00c8f0');
    _liveLineEl.setAttribute('stroke-width', '1.5');
    _liveLineEl.setAttribute('stroke-dasharray', '6,4');
    _liveLineEl.setAttribute('opacity', '.9');
    _liveLineEl.style.pointerEvents = 'none';
    _liveLineEl.style.display = 'none';
    s.appendChild(_liveLineEl);
  }
}

function renderEdges() {
  const s = SV(); if (!s) return;
  s.style.pointerEvents = 'all';
  _ensureSvgDefs(s);
  _ensureLiveLine(s);

  const canvRect = cvs().getBoundingClientRect();

  // Rebuild all edge <g> elements (full redraw — called only on structural changes)
  // Remove existing edge groups only (leave defs + live-line)
  const toRemove = [];
  for (const ch of s.children) {
    if (ch.tagName === 'g' && ch.dataset.eid !== undefined) toRemove.push(ch);
  }
  toRemove.forEach(ch => s.removeChild(ch));

  // Insert live-line at end so it renders on top
  edges.forEach(e => {
    const g = _buildEdgeGroup(e, canvRect);
    if (g) s.insertBefore(g, _liveLineEl);
  });

  // Update live connecting line
  if (connecting) {
    const {x1, y1, x2, y2} = connecting;
    const cx2 = Math.max(Math.abs(x2 - x1) * 0.5, 60);
    _liveLineEl.setAttribute('d', `M${x1},${y1} C${x1+cx2},${y1} ${x2-cx2},${y2} ${x2},${y2}`);
    _liveLineEl.style.display = '';
  } else {
    _liveLineEl.style.display = 'none';
  }
  // Update edge counter
  const ecEl = document.getElementById('fb-edge-count');
  if (ecEl) ecEl.textContent = edges.length;
}

// ─── Edge context menu ────────────────────────
let ctxEdgeTarget = null;

function showEdgeCtx(e, eid) {
  ctxEdgeTarget = eid;
  const m = document.getElementById('ctx-edge');
  // Adjust so menu stays inside viewport
  const vw = window.innerWidth, vh = window.innerHeight;
  let lx = e.clientX, ly = e.clientY;
  if (lx + 180 > vw) lx = vw - 185;
  if (ly + 60 > vh) ly = vh - 65;
  m.style.left = lx + 'px'; m.style.top = ly + 'px';
  m.classList.add('open');
  document.addEventListener('mousedown', closeEdgeCtx, {once: true, capture: true});
}

function closeEdgeCtx() {
  document.getElementById('ctx-edge').classList.remove('open');
  ctxEdgeTarget = null;
}

function deleteSelEdge() {
  if (!selEdge) return;
  _edgeIdSet.delete(selEdge);
  edges = edges.filter(e => e.id !== selEdge);
  selEdge = null;
  push(); render(); toast('Conexão removida');
}

// ─── Node drag ────────────────────────────────
function onNodeDown(e) {
  if (e.target.closest('.fb-port') || e.target.closest('.fb-node-opts') || e.target.closest('[data-tag-out]')) return;
  e.stopPropagation();
  const el = e.currentTarget;
  const nid = parseInt(el.dataset.nid);
  if (e.button === 2) { showCtx(e, nid); return; }

  if (!e.shiftKey && !sel.has(nid)) sel.clear();
  sel.add(nid); updateSel();

  const wr  = document.getElementById('fb-wrap').getBoundingClientRect();
  const mx0 = (e.clientX - wr.left - panX) / zoom;
  const my0 = (e.clientY - wr.top  - panY) / zoom;

  // Pre-compute offsets — O(sel.size), done once
  const offs = Array.from(sel).map(id => {
    const n = NodeMap.get(id); if (!n) return null;
    return {id, ox: n.x - mx0, oy: n.y - my0};
  }).filter(Boolean);

  // Pre-collect all affected edges once (not per mousemove)
  const affectedEdges = _edgesForSet(sel);

  let moved    = false;
  let rafId    = null;
  let lastCx   = 0, lastCy = 0;
  let pendingMove = false;

  const canvRect = () => cvs().getBoundingClientRect();

  const doFrame = () => {
    rafId = null;
    if (!pendingMove) return;
    pendingMove = false;

    offs.forEach(({id, ox, oy}) => {
      const n = NodeMap.get(id); if (!n) return;
      n.x = Math.round((lastCx + ox) / 20) * 20;
      n.y = Math.round((lastCy + oy) / 20) * 20;
      const el2 = nEl(id); if (!el2) return;
      el2.style.left = n.x + 'px';
      el2.style.top  = n.y + 'px';
    });

    // Partial SVG update — only affected edges, not full SVG teardown
    _redrawEdgesPartial(affectedEdges);
    _schedMini();
  };

  const onMove = ev => {
    moved = true;
    lastCx = (ev.clientX - wr.left - panX) / zoom;
    lastCy = (ev.clientY - wr.top  - panY) / zoom;
    pendingMove = true;
    if (!rafId) rafId = requestAnimationFrame(doFrame);
  };

  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onUp);
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    sel.forEach(id => { const e2 = nEl(id); if (e2) e2.classList.remove('dragging'); });
    if (moved) push();
    else if (!e.shiftKey && sel.size === 1) openPanel(nid);
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup',   onUp);
}

// ─── Port connection ──────────────────────────
function onPortDown(e) {
  e.stopPropagation(); e.preventDefault();
  const p   = e.currentTarget;
  const nid = parseInt(p.dataset.pid);
  const pp  = p.dataset.pp;
  if (pp === 'in') return;
  const wr = document.getElementById('fb-wrap').getBoundingClientRect();
  const pr = p.getBoundingClientRect();
  beginConnect(nid, pp,
    (pr.left + pr.width/2  - wr.left - panX) / zoom,
    (pr.top  + pr.height/2 - wr.top  - panY) / zoom
  );
}

function beginConnect(fromId, fromPort, sx, sy) {
  const wrap = document.getElementById('fb-wrap');
  wrap.classList.add('connecting-mode');
  document.querySelectorAll('.fb-port.in-p').forEach(p => {
    if (parseInt(p.dataset.pid) !== fromId) p.classList.add('glow');
  });

  connecting = {fromId, fromPort, x1: sx, y1: sy, x2: sx, y2: sy};
  const wr = wrap.getBoundingClientRect();

  let _connectRaf = null;

  const onMove = ev => {
    connecting.x2 = (ev.clientX - wr.left - panX) / zoom;
    connecting.y2 = (ev.clientY - wr.top  - panY) / zoom;
    // Only update the live line (not full SVG) for performance
    if (_liveLineEl) {
      const {x1, y1, x2, y2} = connecting;
      const cx2live = Math.max(Math.abs(x2 - x1) * 0.5, 60);
      if (!_connectRaf) {
        _connectRaf = requestAnimationFrame(() => {
          _connectRaf = null;
          _liveLineEl.setAttribute('d', `M${x1},${y1} C${x1+cx2live},${y1} ${x2-cx2live},${y2} ${x2},${y2}`);
          _liveLineEl.style.display = '';
        });
      }
    }
  };

  const onUp = ev => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onUp);
    if (_connectRaf) { cancelAnimationFrame(_connectRaf); _connectRaf = null; }
    wrap.classList.remove('connecting-mode');
    document.querySelectorAll('.fb-port.in-p').forEach(p => p.classList.remove('glow'));

    const tgt = document.elementFromPoint(ev.clientX, ev.clientY);
    const inP = tgt && tgt.closest('.fb-port.in-p');
    if (inP) {
      const toId = parseInt(inP.dataset.pid);
      const toNode = NodeMap.get(toId);
      // Bloco Início nunca pode receber ligações
      if (toId !== fromId && toNode && toNode.t !== 'inicio') {
        const newEdgeId = eid();
        edges = edges.filter(e => !(e.fr === fromId && e.fp === fromPort));
        edges.push({id: newEdgeId, fr: fromId, fp: fromPort, to: toId});
        push(); // _rebuildIndex called inside push()
      } else if (toNode && toNode.t === 'inicio') {
        toast('O bloco Início não pode receber ligações', 'err');
      }
    }
    connecting = null;
    if (_liveLineEl) _liveLineEl.style.display = 'none';
    render();
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup',   onUp);
}

function updateSel() {
  // Update only nodes whose selection state may have changed.
  // Avoids querySelectorAll over the full canvas (costly with 300 nodes).
  // Strategy: clear all selected, then add to selected set — two passes over DOM
  // but limited to nodes that are or were selected.
  const allNodeEls = _cvsCached ? _cvsCached.querySelectorAll('.fb-node') : document.querySelectorAll('.fb-node');
  allNodeEls.forEach(el => {
    const id = parseInt(el.dataset.nid);
    const shouldBeSelected = sel.has(id);
    const isSelected = el.classList.contains('selected');
    if (shouldBeSelected !== isSelected) {
      el.classList.toggle('selected', shouldBeSelected);
    }
  });
}

// ─── Canvas pan & selection ───────────────────
function initCanvas() {
  const wrap = document.getElementById('fb-wrap');

  wrap.addEventListener('mousedown', e => {
    if (e.target.closest('.fb-node') || e.target.closest('.fb-port') || e.target.closest('.minimap')) return;
    if (e.button === 2) { closeCtx(); return; }
    if (e.button === 0 && e.altKey) { startPan(e); return; }
    if (e.button === 1) { startPan(e); return; }

    closeCtx();
    if (!e.shiftKey) { sel.clear(); updateSel(); }

    const wr = wrap.getBoundingClientRect();
    const sx = (e.clientX - wr.left - panX) / zoom;
    const sy = (e.clientY - wr.top  - panY) / zoom;

    const box = document.getElementById('sel-box');
    let bx0 = sx, by0 = sy;

    const onMove = ev => {
      const cx = (ev.clientX - wr.left - panX) / zoom;
      const cy = (ev.clientY - wr.top  - panY) / zoom;
      const lx = Math.min(bx0, cx) * zoom + panX;
      const ly = Math.min(by0, cy) * zoom + panY;
      const lw = Math.abs(cx - bx0) * zoom;
      const lh = Math.abs(cy - by0) * zoom;
      box.style.cssText = `display:block;left:${lx}px;top:${ly}px;width:${lw}px;height:${lh}px`;
    };
    const onUp = ev => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      box.style.display = 'none';
      const cx = (ev.clientX - wr.left - panX) / zoom;
      const cy = (ev.clientY - wr.top  - panY) / zoom;
      const minX = Math.min(bx0,cx), maxX = Math.max(bx0,cx);
      const minY = Math.min(by0,cy), maxY = Math.max(by0,cy);
      if (Math.abs(maxX-minX) > 4 || Math.abs(maxY-minY) > 4) {
        nodes.forEach(n => {
          if (n.x >= minX && n.x <= maxX && n.y >= minY && n.y <= maxY) sel.add(n.id);
        });
        updateSel();
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  wrap.addEventListener('contextmenu', e => {
    e.preventDefault();
    const node = e.target.closest('.fb-node');
    if (node) {
      const nid = parseInt(node.dataset.nid);
      if (!sel.has(nid)) { sel.clear(); sel.add(nid); updateSel(); }
      showCtx(e, nid);
    } else {
      ctxClickPos = e;
      ctxNodeTarget = null;
      showCtxEmpty(e);
    }
  });

  wrap.addEventListener('wheel', e => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const wr = wrap.getBoundingClientRect();
      const mx = e.clientX - wr.left, my = e.clientY - wr.top;
      const oldZ = zoom;
      zoom = Math.min(2.5, Math.max(0.15, zoom + (e.deltaY > 0 ? -0.08 : 0.08)));
      panX = mx - (mx - panX) * (zoom / oldZ);
      panY = my - (my - panY) * (zoom / oldZ);
    } else {
      panX -= e.deltaX; panY -= e.deltaY;
    }
    updateTransform();
  }, {passive: false});
}

function startPan(e) {
  const wrap = document.getElementById('fb-wrap');
  wrap.classList.add('panning');
  const sx = e.clientX - panX, sy = e.clientY - panY;
  const onMove = ev => { panX = ev.clientX - sx; panY = ev.clientY - sy; updateTransform(); };
  const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); wrap.classList.remove('panning'); };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function updateTransform() {
  if (_transformRaf) return; // already scheduled — skip redundant call
  _transformRaf = requestAnimationFrame(() => {
    _transformRaf = null;
    const c = cvs(); if (!c) return;
    c.style.transform = `translate(${panX}px,${panY}px) scale(${zoom})`;
    document.getElementById('fb-zoom-val').textContent = Math.round(zoom * 100) + '%';
    const g = document.getElementById('fb-grid');
    if (g) {
      const sz = 24 * zoom;
      g.style.backgroundSize = `${sz}px ${sz}px`;
      g.style.backgroundPosition = `${((panX % sz) + sz) % sz}px ${((panY % sz) + sz) % sz}px`;
    }
    _schedMini();
  });
}

function fbZoom(d) {
  const wrap = document.getElementById('fb-wrap');
  const r = wrap.getBoundingClientRect();
  const cx = r.width / 2, cy = r.height / 2;
  const oldZ = zoom;
  zoom = Math.min(2.5, Math.max(0.15, zoom + d));
  panX = cx - (cx - panX) * (zoom / oldZ);
  panY = cy - (cy - panY) * (zoom / oldZ);
  updateTransform();
}

function fbFit() {
  if (!nodes.length) return;
  const wrap = document.getElementById('fb-wrap');
  const r = wrap.getBoundingClientRect();
  const minX = Math.min(...nodes.map(n => n.x));
  const minY = Math.min(...nodes.map(n => n.y));
  const maxX = Math.max(...nodes.map(n => n.x + 215));
  const maxY = Math.max(...nodes.map(n => n.y + 130));
  const scX = (r.width - 120) / (maxX - minX || 1);
  const scY = (r.height - 120) / (maxY - minY || 1);
  zoom = Math.min(scX, scY, 1.3);
  panX = (r.width  - (maxX - minX) * zoom) / 2 - minX * zoom;
  panY = (r.height - (maxY - minY) * zoom) / 2 - minY * zoom;
  updateTransform();
}

// ─── Auto layout ──────────────────────────────
function fbAutoLayout() {
  if (!nodes.length) return;
  const inDeg = {};
  nodes.forEach(n => inDeg[n.id] = 0);
  edges.forEach(e => inDeg[e.to] = (inDeg[e.to] || 0) + 1);
  const next = {};
  nodes.forEach(n => next[n.id] = []);
  edges.forEach(e => next[e.fr] && next[e.fr].push(e.to));

  const level = {};
  const roots = nodes.filter(n => !inDeg[n.id]).map(n => n.id);
  if (!roots.length) roots.push(nodes[0].id);
  const q = [...roots];
  roots.forEach(id => level[id] = 0);
  while (q.length) {
    const cur = q.shift();
    (next[cur] || []).forEach(nxt => {
      const lv = (level[cur] || 0) + 1;
      if (level[nxt] === undefined || lv > level[nxt]) { level[nxt] = lv; q.push(nxt); }
    });
  }
  nodes.forEach(n => { if (level[n.id] === undefined) level[n.id] = 0; });

  const byLev = {};
  nodes.forEach(n => { const l = level[n.id]; (byLev[l] = byLev[l] || []).push(n); });
  const COL = 260, ROW = 160;
  Object.entries(byLev).forEach(([lv, ns]) => {
    const total = ns.length;
    ns.forEach((n, i) => {
      n.x = 100 + i * COL - (total - 1) * COL / 2;
      n.y = 60 + parseInt(lv) * ROW;
    });
  });

  push(); render(); fbFit(); toast('Fluxo organizado', 'ok');
}

// ─── Block picker ──────────────────────────────

function openPicker(pos) {
  pickerPos = pos || null;
  const ov = document.getElementById('picker-overlay');
  const inp = document.getElementById('picker-q');
  ov.classList.add('open');
  inp.value = '';
  setTimeout(() => inp.focus(), 50);
  renderPicker('');
}
function closePicker() { document.getElementById('picker-overlay').classList.remove('open'); }

function renderPicker(q) {
  const body = document.getElementById('picker-body');
  body.innerHTML = '';
  const lq = q.toLowerCase();
  const cats = {};
  DEFS.filter(d => !q || d.n.toLowerCase().includes(lq) || d.d.toLowerCase().includes(lq) || d.cat.toLowerCase().includes(lq))
      .forEach(d => (cats[d.cat] = cats[d.cat] || []).push(d));

  Object.entries(cats).forEach(([cat, ds]) => {
    const h = document.createElement('div'); h.className = 'picker-cat'; h.textContent = cat; body.appendChild(h);
    const g = document.createElement('div'); g.className = 'picker-grid';
    ds.forEach(d => {
      const item = document.createElement('div'); item.className = 'picker-item';
      item.innerHTML = `<div class="picker-ico" style="background:${d.c}22"><i class="ti ${d.ic}" style="color:${d.c}"></i></div>
        <div><div class="picker-name">${d.n}</div><div class="picker-desc">${d.d}</div></div>`;
      item.addEventListener('click', () => { addNode(d.t, pickerPos); closePicker(); });
      g.appendChild(item);
    });
    body.appendChild(g);
  });
}

function addNode(type, pos) {
  const def = DEF[type]; if (!def) return;
  const wrap = document.getElementById('fb-wrap');
  const r = wrap.getBoundingClientRect();
  let x, y;
  if (pos) { x = pos.x; y = pos.y; }
  else {
    x = Math.round((r.width / 2 - panX - 95) / zoom / 20) * 20;
    y = Math.round((r.height / 2 - panY - 60) / zoom / 20) * 20;
    // NodeMap iteration is O(n) but happens only once on add — acceptable
    while (nodes.some(n => Math.abs(n.x - x) < 25 && Math.abs(n.y - y) < 25)) x += 250;
  }
  // Use NodeTypeRegistry for type-specific defaults (Firebase-ready schema)
  const regDef = NodeTypeRegistry.get(type);
  const data = regDef ? NodeTypeRegistry.getDefaultData(type) : {};
  // Also seed legacy DEFS.fs select defaults for unregistered types
  if (!regDef && def.fs) def.fs.forEach(f => { if (f.tp==='sel' && f.o) data[f.id]=f.o[0]; });
  const n = {id: uid(), t: type, x, y, lbl: def.n, data};
  nodes.push(n);
  NodeMap.set(n.id, n); // keep NodeMap in sync immediately
  push(); render();
  sel.clear(); sel.add(n.id); updateSel();
  setTimeout(() => openPanel(n.id), 50);
}

// ─── Edit panel ───────────────────────────────
function openPanel(nid) {
  const n = NodeMap.get(nid); if (!n) return;
  activeId = nid;
  const def = DEF[n.t] || {};

  // Panel title
  document.getElementById('panel-title').textContent = def.n || n.t;
  document.getElementById('fb-panel').classList.add('open');

  const body = document.getElementById('panel-body');
  body.innerHTML = '';

  // ── Validation indicator ─────────────────────
  const vcheck = NodeTypeRegistry.validate(n);
  if (!vcheck.valid) {
    const vbanner = document.createElement('div');
    vbanner.style.cssText = 'background:rgba(239,68,68,.12);border:0.5px solid rgba(239,68,68,.4);border-radius:6px;padding:7px 10px;font-size:11px;color:#f87171;margin-bottom:8px;line-height:1.6';
    vbanner.innerHTML = '<i class="ti ti-alert-triangle" style="font-size:12px"></i> ' + vcheck.errors.join('<br>');
    body.appendChild(vbanner);
  }

  // ── Block name ─────────────────────────────
  const lf = document.createElement('div'); lf.className = 'pf';
  lf.innerHTML = `<label>Nome do bloco</label><input id="pf-lbl" value="${n.lbl || def.n || ''}" placeholder="Nome...">`;
  body.appendChild(lf);

  // ── Type-specific editor (NodeTypeRegistry) ─
  const builtByRegistry = NodeTypeRegistry.buildEditor(n, body);

  // ── Fallback: generic field builder for unregistered types ─────
  if (!builtByRegistry && def.fs) {
    def.fs.forEach(f => {
      const val = n.data[f.id] !== undefined ? n.data[f.id] : '';
      const div = document.createElement('div'); div.className = 'pf';
      if (f.tp === 'area') {
        div.innerHTML = `<label>${f.l}</label><textarea id="pf-${f.id}" placeholder="${f.ph||''}">${val}</textarea>`;
      } else if (f.tp === 'sel') {
        const opts = (f.o||[]).map(o=>`<option${o===val?' selected':''}>${o}</option>`).join('');
        div.innerHTML = `<label>${f.l}</label><select id="pf-${f.id}">${opts}</select>`;
      } else {
        div.innerHTML = `<label>${f.l}</label><input id="pf-${f.id}" type="${f.tp==='num'?'number':'text'}" value="${val}" placeholder="${f.ph||''}">`;
      }
      body.appendChild(div);
    });
  }

  // ── Wire live-update to all fields ─────────
  body.querySelectorAll('input,textarea,select').forEach(el => {
    el.addEventListener('input',  () => applyLive());
    el.addEventListener('change', () => applyLive());
  });
}

function applyLive() {
  if (!activeId) return;
  const n = NodeMap.get(activeId); if (!n) return;
  const def = DEF[n.t] || {};

  // Collect label
  const lblEl = document.getElementById('pf-lbl');
  if (lblEl) n.lbl = lblEl.value;

  // Collect all pf- prefixed fields from the panel body
  document.querySelectorAll('[id^="pf-"]').forEach(el => {
    if (el.id === 'pf-lbl') return;
    const key = el.id.replace('pf-', '');
    n.data[key] = el.value;
  });

  // Update canvas node in place
  const domEl = nEl(activeId);
  if (domEl) {
    domEl.querySelector('.fb-node-lbl').textContent = n.lbl || def.n || n.t;

    // Preview via NodeTypeRegistry (with graceful fallback)
    let prev = NodeTypeRegistry.getPreview(n);
    if (!prev && def.fs && def.fs[0]) prev = n.data[def.fs[0].id] || '';
    if (prev.length > 55) prev = prev.slice(0, 53) + '…';
    domEl.querySelector('.fb-node-body').innerHTML =
      prev
      ? prev.replace(/</g,'&lt;')
      : `<span style="color:var(--k-muted);font-style:italic">${def.d || ''}</span>`;

    // Validation error indicator on the node card
    const vcheck = NodeTypeRegistry.validate(n);
    domEl.classList.toggle('node-invalid', !vcheck.valid);
    let errDot = domEl.querySelector('.node-err-dot');
    if (!vcheck.valid) {
      if (!errDot) {
        errDot = document.createElement('span');
        errDot.className = 'node-err-dot';
        errDot.title = vcheck.errors.join('\n');
        domEl.querySelector('.fb-node-head').appendChild(errDot);
      }
    } else if (errDot) {
      errDot.remove();
    }
  }

  // Update validation banner in panel
  const body = document.getElementById('panel-body');
  if (body) {
    const existing = body.querySelector('.v-banner');
    const vcheck = NodeTypeRegistry.validate(n);
    if (!vcheck.valid) {
      if (!existing) {
        const vb = document.createElement('div');
        vb.className = 'v-banner';
        vb.style.cssText = 'background:rgba(239,68,68,.12);border:0.5px solid rgba(239,68,68,.4);border-radius:6px;padding:7px 10px;font-size:11px;color:#f87171;margin-bottom:8px;line-height:1.6';
        body.insertBefore(vb, body.firstChild);
      }
      body.querySelector('.v-banner').innerHTML = '<i class="ti ti-alert-triangle" style="font-size:12px"></i> ' + vcheck.errors.join('<br>');
    } else if (existing) {
      existing.remove();
    }
  }

  schedSave();
}

function applyPanel() { applyLive(); push(); toast('Bloco actualizado', 'ok'); }
function closePanel() { document.getElementById('fb-panel').classList.remove('open'); activeId = null; }

// ─── Context menu ─────────────────────────────

function showCtx(e, nid) {
  e.preventDefault(); e.stopPropagation();
  ctxNodeTarget = nid;
  const m = document.getElementById('ctx');
  m.style.left = e.clientX + 'px'; m.style.top = e.clientY + 'px';
  m.classList.add('open');
  document.getElementById('ctx-edit').style.display = '';
  document.addEventListener('mousedown', closeCtx, {once: true, capture: true});
}

function showCtxEmpty(e) {
  const m = document.getElementById('ctx');
  m.style.left = e.clientX + 'px'; m.style.top = e.clientY + 'px';
  m.classList.add('open');
  document.getElementById('ctx-edit').style.display = 'none';
  document.addEventListener('mousedown', closeCtx, {once: true, capture: true});
}

function closeCtx() { document.getElementById('ctx').classList.remove('open'); }

// ─── Node operations ──────────────────────────
function deleteSel() {
  if (!sel.size) return;
  // Remove edges connected to deleted nodes from _edgeIdSet
  edges.forEach(e => { if (sel.has(e.fr) || sel.has(e.to)) _edgeIdSet.delete(e.id); });
  nodes = nodes.filter(n => !sel.has(n.id));
  edges = edges.filter(e => !sel.has(e.fr) && !sel.has(e.to));
  sel.clear(); closePanel(); push(); render(); toast('Eliminado');
}

function duplicateSel() {
  const ids = Array.from(sel); const newSel = new Set();
  ids.forEach(id => {
    const n = NodeMap.get(id); if (!n) return;
    const nid = uid();
    nodes.push({...n, id: nid, x: n.x + 240, y: n.y + 30, data: {...n.data}});
    newSel.add(nid);
  });
  sel.clear(); newSel.forEach(id => sel.add(id));
  push(); render(); updateSel(); toast('Duplicado', 'ok');
}

function copyNodes() {
  clipboard = Array.from(sel).map(id => NodeMap.get(id)).filter(Boolean);
  toast(`${clipboard.length} bloco(s) copiado(s)`);
}

function pasteNodes() {
  if (!clipboard.length) return;
  sel.clear();
  clipboard.forEach(n => {
    const nid = uid();
    nodes.push({...n, id: nid, x: n.x + 240, y: n.y + 30, data: {...n.data}});
    sel.add(nid);
  });
  push(); render(); updateSel(); toast('Colado', 'ok');
}

// ─── Minimap ──────────────────────────────────
// FASE 2.7 — minimap scale/offset cache para clique-para-pan
let _miniSc = 1, _miniOx = 0, _miniOy = 0;

function drawMini() {
  const cv = document.getElementById('minimap'); if (!cv) return;
  const W = cv.width || 148, H = cv.height || 94;
  const ctx = cv.getContext('2d');

  if (!nodes.length) {
    ctx.fillStyle = '#0a0a0f'; ctx.fillRect(0, 0, W, H);
    return;
  }

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0a0a0f'; ctx.fillRect(0, 0, W, H);

  const minX = Math.min(...nodes.map(n => n.x)) - 20;
  const minY = Math.min(...nodes.map(n => n.y)) - 20;
  const maxX = Math.max(...nodes.map(n => n.x + 215)) + 20;
  const maxY = Math.max(...nodes.map(n => n.y + 130)) + 20;
  const sc   = Math.min((W - 10) / (maxX - minX), (H - 10) / (maxY - minY));
  const ox   = 5 - minX * sc, oy = 5 - minY * sc;

  // Cache for click-to-pan
  _miniSc = sc; _miniOx = ox; _miniOy = oy;

  // Grid dots (subtle)
  ctx.fillStyle = '#ffffff08';
  for (let gx = 0; gx < W; gx += 12) for (let gy = 0; gy < H; gy += 12) {
    ctx.fillRect(gx, gy, 1, 1);
  }

  // Edges — curved bezier in minimap
  edges.forEach(e => {
    const fn = NodeMap.get(e.fr), tn = NodeMap.get(e.to);
    if (!fn || !tn) return;
    const x1 = fn.x * sc + ox + 107 * sc;
    const y1 = fn.y * sc + oy + 120 * sc;
    const x2 = tn.x * sc + ox + 107 * sc;
    const y2 = tn.y * sc + oy;
    const cy = Math.max(Math.abs(y2 - y1) * 0.4, 8 * sc);
    ctx.strokeStyle = '#0078f055'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.bezierCurveTo(x1, y1 + cy, x2, y2 - cy, x2, y2);
    ctx.stroke();
  });

  // Nodes
  nodes.forEach(n => {
    const def = DEF[n.t];
    const color = def?.c || '#0078f0';
    const nx = n.x * sc + ox, ny = n.y * sc + oy;
    const nw = Math.max(8, 215 * sc), nh = Math.max(5, 120 * sc);
    ctx.fillStyle = color + '44';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(nx, ny, nw, nh, 2);
    else ctx.rect(nx, ny, nw, nh);
    ctx.fill();
    if (sel.has(n.id)) {
      ctx.strokeStyle = '#00c8f0'; ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  });

  // Viewport rectangle
  const wrap = document.getElementById('fb-wrap'); if (!wrap) return;
  const r = wrap.getBoundingClientRect();
  const vx = (-panX / zoom) * sc + ox;
  const vy = (-panY / zoom) * sc + oy;
  const vw = (r.width  / zoom) * sc;
  const vh = (r.height / zoom) * sc;
  ctx.strokeStyle = 'rgba(0,200,240,.6)'; ctx.lineWidth = 1.5;
  ctx.strokeRect(vx, vy, vw, vh);
  // Tint viewport
  ctx.fillStyle = 'rgba(0,200,240,.04)';
  ctx.fillRect(vx, vy, vw, vh);
}

// FASE 2.7 — clique no minimap para pan
function _initMinimapClick() {
  const cv = document.getElementById('minimap'); if (!cv) return;
  let _miniDragging = false;
  const _doMinimapPan = (e) => {
    const r = cv.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    if (_miniSc === 0) return;
    // Convert minimap coords to canvas world coords
    const worldX = (mx - _miniOx) / _miniSc;
    const worldY = (my - _miniOy) / _miniSc;
    const wrap = document.getElementById('fb-wrap');
    if (!wrap) return;
    const wr = wrap.getBoundingClientRect();
    panX = wr.width  / 2 - worldX * zoom;
    panY = wr.height / 2 - worldY * zoom;
    updateTransform();
  };
  cv.addEventListener('mousedown', e => {
    e.stopPropagation();
    _miniDragging = true;
    _doMinimapPan(e);
    const onMove = ev => { if (_miniDragging) _doMinimapPan(ev); };
    const onUp   = ()  => { _miniDragging = false; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// FASE 3.2.1 — _updateToolbarStatus removido: já não existe conceito de
// status (draft/published/archived). A toolbar mostra apenas nome,
// indicador de Auto Save e botão Salvar (ver schedSave/doSave abaixo).

// ─── Save & autosave ──────────────────────────
// schedSave é chamado pelo motor em cada mutação.
// Delega toda a lógica de persistência ao FlowRepository.
// saveTimer declarado no topo do ficheiro

// FASE 3.2.1 — Indicador "Salvo automaticamente há X segundos", conforme
// pedido (substitui o antigo texto fixo "Salvo"). _lastSavedAt guarda o
// momento do último save bem-sucedido; _saveStatusTicker actualiza o
// texto periodicamente para reflectir o tempo decorrido.
let _lastSavedAt = null;
let _saveStatusTicker = null;

function _fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 5)   return 'agora mesmo';
  if (s < 60)  return `há ${s} segundos`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `há ${m} minuto${m === 1 ? '' : 's'}`;
  const h = Math.floor(m / 60);
  return `há ${h} hora${h === 1 ? '' : 's'}`;
}

function _markSaved() {
  _lastSavedAt = Date.now();
  _renderSavedStatus();

  clearInterval(_saveStatusTicker);
  _saveStatusTicker = setInterval(_renderSavedStatus, 5000);
}

function _renderSavedStatus() {
  const st = document.getElementById('fb-status');
  if (!st || !_lastSavedAt) return;
  st.className = 'fb-save-status saved';
  st.innerHTML = `<i class="ti ti-check" style="font-size:11px"></i> Salvo automaticamente ${_fmtElapsed(Date.now() - _lastSavedAt)}`;
}

function schedSave() {
  const st = document.getElementById('fb-status');
  if (st) {
    st.className = 'fb-save-status';
    st.innerHTML = '<i class="ti ti-circle-dashed" style="font-size:11px"></i> A guardar…';
  }
  clearInterval(_saveStatusTicker);

  // Actualiza o nome a partir do input antes de persistir
  const nameEl = document.getElementById('fb-name');
  if (nameEl) FlowRepository.setName(nameEl.value);

  FlowRepository.commitState(nodes, edges);

  // Feedback visual após o debounce (1 400 ms + margem)
  clearTimeout(saveTimer);
  saveTimer = setTimeout(_markSaved, 1600);
}

function doSave() {
  // Persistência imediata (sem debounce) — para Ctrl+S e botão Salvar
  const nameEl = document.getElementById('fb-name');
  if (nameEl) FlowRepository.setName(nameEl.value);
  FlowRepository.commitState(nodes, edges, true);
  _markSaved();
}

function fbSave() { doSave(); toast('Fluxo guardado', 'ok'); }

/**
 * FASE 5.3 — Actualiza o conjunto de IDs de nós inicio duplicados e
 * re-renderiza o canvas para aplicar/remover a borda vermelha de erro.
 * Chamado por flow-builder.js sempre que a validação é executada.
 * @param {string[]} ids — IDs dos nós inicio em erro (vazio = sem erro)
 */
function setMultiStartErrors(ids) {
  _multiStartErrorIds = new Set(ids || []);
  render(); // re-render para aplicar/remover borda vermelha
}

/* ══════════════════════════════════════════════════════════════════════
   FASE 2.7 — WorkflowEngine  (Modo Design — sem execução)
   ────────────────────────────────────────────────────────────────────
   Analisa e valida a estrutura do fluxo.
   Não envia mensagens, não chama APIs, não processa automações.

   Será consumido por:
     • ExecutorEngine   — execução real de automações
     • WhatsApp Engine  — envio de mensagens
     • FlowSimulator    — simulação de caminhos
     • Firebase Functions — execução serverless
   ══════════════════════════════════════════════════════════════════════ */