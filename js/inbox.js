/* ══════════════════════════════════════════════════════════════════════
   InboxView — Centro de atendimento do Korvex (versão completa)
   ────────────────────────────────────────────────────────────────────
   Inteiramente OBSERVADOR do sistema: lê o que o motor de fluxos e o
   WhatsApp já gravaram (server/engine/inbox.js), nunca decide nada
   sobre fluxos. Toda a interface é alimentada por dados reais —
   nenhum número, etiqueta ou estado é inventado; quando não existem
   dados, mostram-se estados vazios.

   Firestore:
     workspaces/{uid}/inbox/{phone}                        → resumo (lista)
     workspaces/{uid}/conversations/{phone}/messages/{id}  → histórico
     workspaces/{uid}/conversations/{phone}/events/{id}    → timeline
     workspaces/{uid}/quickReplies/{id}                    → respostas rápidas

   Backend (server/index.js):
     GET    /inbox/:uid/:phone/messages
     POST   /inbox/:uid/:phone/read
     POST   /inbox/:uid/:phone/name
     POST   /inbox/:uid/:phone/send
     DELETE /inbox/:uid/:phone
     POST   /admin/sessions/:uid/:phone/block-ai    → "Assumir atendimento"
     POST   /admin/sessions/:uid/:phone/unblock-ai  → "Voltar para IA"

   NÃO toca em: flow-builder.js, simulator.js, repository.js (DEFS),
   workflowEngine, ConnectionService, Dashboard, Analytics, IA, Conexões.
   ══════════════════════════════════════════════════════════════════════ */

const InboxView = (() => {

  // ── Configuração ─────────────────────────────────────────────────────
  const BACKEND_URL = (typeof window !== 'undefined' && window.KORVEX_BACKEND_URL)
    ? window.KORVEX_BACKEND_URL
    : 'http://localhost:3001';

  // ── Estado interno ───────────────────────────────────────────────────
  let _uid               = null;
  let _listUnsubscribe   = null;
  let _msgsUnsubscribe   = null;
  let _eventsUnsubscribe = null;
  let _qrUnsubscribe     = null;
  let _contacts          = [];
  let _contactsReady     = false;
  let _activePhone       = null;
  let _activeContact     = null;
  let _messages          = [];      // mensagens da conversa aberta (cache em memória)
  let _events            = [];      // timeline da conversa aberta
  let _quickReplies       = [];
  let _searchTerm        = '';
  let _activeFilter      = 'all';
  let _icpTab            = 'info';
  let _quotedMessage     = null;    // mensagem citada na resposta (Responder)
  let _rendered          = false;

  // ── Referências Firestore ────────────────────────────────────────────
  function _db() { return typeof FirebaseCore !== 'undefined' ? FirebaseCore.getDb() : null; }

  function _inboxCol() {
    const db = _db();
    if (!db || !_uid) return null;
    return db.collection('workspaces').doc(_uid).collection('inbox');
  }

  function _safePhoneId(phone) {
    return String(phone).replace(/\//g, '_');
  }

  function _convDoc(phone) {
    const db = _db();
    if (!db || !_uid) return null;
    return db.collection('workspaces').doc(_uid)
              .collection('conversations').doc(_safePhoneId(phone));
  }

  function _messagesCol(phone) {
    const doc = _convDoc(phone);
    return doc ? doc.collection('messages') : null;
  }

  function _eventsCol(phone) {
    const doc = _convDoc(phone);
    return doc ? doc.collection('events') : null;
  }

  function _quickRepliesCol() {
    const db = _db();
    if (!db || !_uid) return null;
    return db.collection('workspaces').doc(_uid).collection('quickReplies');
  }

  function _inboxDocRef(phone) {
    const col = _inboxCol();
    return col ? col.doc(_safePhoneId(phone)) : null;
  }

  // ══════════════════════════════════════════════════════════════════════
  // init / destroy
  // ══════════════════════════════════════════════════════════════════════

  function init(uid) {
    _uid = uid;
    _rendered = false;
    // [FLIGHT RECORDER]
    if (typeof korvexFlightRecorder !== 'undefined') {
      korvexFlightRecorder.recordInbox('init', {
        uid
      });
    }
  }

  function destroy() {
    // [FLIGHT RECORDER]
    if (typeof korvexFlightRecorder !== 'undefined') {
      korvexFlightRecorder.recordInbox('destroy', {
        uid: _uid,
        listeners: 4 // stopListListener, stopMessagesListener, stopEventsListener, stopQuickRepliesListener
      });
    }
    _stopListListener();
    _stopMessagesListener();
    _stopEventsListener();
    _stopQuickRepliesListener();
    _uid            = null;
    _contacts       = [];
    _contactsReady  = false;
    _activePhone    = null;
    _activeContact  = null;
    _messages       = [];
    _events         = [];
    _quickReplies   = [];
    _searchTerm     = '';
    _activeFilter   = 'all';
    _quotedMessage  = null;
    _rendered       = false;
  }

  function render() {
    if (!_uid) return;
    _wireStaticControls();
    if (!_rendered) {
      _rendered = true;
      _startListListener();
      _startQuickRepliesListener();
    }
  }

  // Alias público — usado por ClientsView.openInInbox() (js/clients.js)
  function openConversation(phone) {
    if (!_contactsReady) { setTimeout(() => openConversation(phone), 150); return; }
    _openConversation(phone);
  }

  // ── Ligar controlos estáticos uma única vez ─────────────────────────
  let _controlsWired = false;
  function _wireStaticControls() {
    if (_controlsWired) return;
    _controlsWired = true;

    const searchInput = document.querySelector('#view-inbox .inbox-search');
    if (searchInput) {
      searchInput.addEventListener('input', e => {
        _searchTerm = (e.target.value || '').trim().toLowerCase();
        _renderList();
      });
    }

    document.querySelectorAll('#inbox-filters .inbox-filter').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#inbox-filters .inbox-filter').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _activeFilter = btn.dataset.filter || 'all';
        _renderList();
      });
    });

    const qrMgrBtn = document.getElementById('inbox-btn-quick-replies-mgr');
    if (qrMgrBtn) qrMgrBtn.addEventListener('click', () => _openQuickRepliesPopover(qrMgrBtn));

    document.addEventListener('click', _onGlobalClickClosePopovers, true);
  }

  function _onGlobalClickClosePopovers(e) {
    document.querySelectorAll('.chat-popover.open').forEach(p => {
      if (!p.contains(e.target) && !e.target.closest('[data-popover-trigger]')) p.classList.remove('open');
    });
    document.querySelectorAll('.chat-more-menu.open').forEach(m => {
      if (!m.contains(e.target) && !e.target.closest('#inbox-btn-more')) m.classList.remove('open');
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // Listener da lista (workspaces/{uid}/inbox)
  // ══════════════════════════════════════════════════════════════════════
  let _listRenderTimeout = null;

  function _startListListener() {
    _stopListListener();
    const col = _inboxCol();
    if (!col) return;

    _listUnsubscribe = col.orderBy('updatedAt', 'desc').onSnapshot(snap => {
      _contacts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      _contactsReady = true;
      
      // Debounce: evitar re-renders muito rapidamente
      if (_listRenderTimeout) clearTimeout(_listRenderTimeout);
      _listRenderTimeout = setTimeout(() => {
        _renderList();

        if (_activePhone) {
          const fresh = _contacts.find(c => c.phone === _activePhone);
          if (!fresh) { _activePhone = null; _activeContact = null; _renderEmptyChat(); }
          else { _activeContact = fresh; _renderChatHeader(fresh); if (_icpPanelOpen()) _renderICPActivePane(fresh); }
        }
        _listRenderTimeout = null;
      }, 50);
    }, err => {
      console.warn('[InboxView] listener da lista falhou:', err.message);
    });
  }

  function _stopListListener() {
    if (_listRenderTimeout) clearTimeout(_listRenderTimeout);
    if (_listUnsubscribe) { _listUnsubscribe(); _listUnsubscribe = null; }
  }

  // ══════════════════════════════════════════════════════════════════════
  // Renderização da lista (esquerda)
  // ══════════════════════════════════════════════════════════════════════
  function _renderList() {
    const listEl = document.getElementById('inbox-items-list');
    if (!listEl) return;

    let items = _contacts;

    if (_searchTerm) {
      items = items.filter(c => {
        const name  = (c.displayName || '').toLowerCase();
        const phone = (c.phone || '').toLowerCase();
        const word  = (c.lastMessage || '').toLowerCase();
        const tags  = Array.isArray(c.tags) ? c.tags.join(' ').toLowerCase() : '';
        return name.includes(_searchTerm) || phone.includes(_searchTerm)
            || word.includes(_searchTerm) || tags.includes(_searchTerm);
      });
    }

    items = items.filter(c => _passesFilter(c, _activeFilter));

    if (!items.length) {
      listEl.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 16px;gap:10px;text-align:center">
          <i class="ti ti-inbox" style="font-size:28px;color:var(--k-muted);opacity:.3"></i>
          <div style="font-size:12px;color:var(--k-muted)">${_searchTerm ? 'Nenhum resultado para a busca' : 'Nenhuma conversa encontrada'}</div>
        </div>`;
      return;
    }

    listEl.innerHTML = items.map(c => _contactItemHtml(c)).join('');

    listEl.querySelectorAll('.inbox-item[data-phone]').forEach(el => {
      el.addEventListener('click', () => {
        if (!_contactsReady) return;
        _openConversation(el.dataset.phone);
      });
    });
  }

  function _passesFilter(c, filter) {
    const isArchived = c.archived === true;
    const isResolved = c.status === 'done' || c.status === 'finished';

    if (filter !== 'archived' && isArchived) return false; // arquivadas só aparecem no próprio filtro

    switch (filter) {
      case 'unread':   return (c.unreadCount || 0) > 0;
      case 'human':    return c.status === 'human';
      case 'replied':  return c.lastMessageDirection === 'out';
      case 'resolved': return isResolved;
      case 'archived': return isArchived;
      case 'hasFlow':  return !!c.activeFlowId;
      case 'noFlow':   return !c.activeFlowId;
      case 'favorite': return c.favorite === true;
      case 'tagged':   return Array.isArray(c.tags) && c.tags.length > 0;
      case 'all':
      default:         return true;
    }
  }

  function _contactItemHtml(c) {
    const name    = c.displayName || c.phone;
    const initial = (name || '?').trim()[0]?.toUpperCase() || '?';
    const color   = _colorFor(c.phone || name);
    const time    = _formatTime(c.lastMessageAt);
    const isActive = c.phone === _activePhone;
    const unread  = c.unreadCount || 0;
    const preview = c.lastMessage || '';

    const statusMap = {
      bot:      { label: 'Bot ativo',   cls: 'bot',     icon: 'ti-robot' },
      human:    { label: 'Humano',      cls: 'human',   icon: 'ti-user' },
      waiting:  { label: 'Aguardando', cls: 'waiting', icon: 'ti-clock' },
      done:     { label: 'Resolvida',  cls: 'done',    icon: 'ti-circle-check' },
      finished: { label: 'Resolvida',  cls: 'done',    icon: 'ti-circle-check' },
    };
    const st = statusMap[c.status] || statusMap.bot;
    const statusPill = `<span class="inbox-status-pill ${st.cls}"><i class="ti ${st.icon}" style="font-size:10px"></i>${_escapeHtml(st.label)}</span>`;

    const flowPill = c.activeFlowId
      ? `<span class="inbox-dot-sep">·</span><span class="inbox-flow-pill"><i class="ti ti-hierarchy" style="font-size:10px"></i>${_escapeHtml(c.activeFlowId)}</span>`
      : '';

    const archivedPill = c.archived
      ? `<span class="inbox-dot-sep">·</span><span class="inbox-archived-badge"><i class="ti ti-archive" style="font-size:9px"></i>Arquivada</span>`
      : '';

    const tags = Array.isArray(c.tags) ? c.tags : [];
    const tagPills = tags.slice(0, 2).map(t => `<span class="inbox-tag">${_escapeHtml(t)}</span>`).join('');

    return `
      <div class="inbox-item${isActive ? ' active' : ''}" data-phone="${_escapeAttr(c.phone)}">
        <div class="inbox-av" style="background:${color}">
          ${_escapeHtml(initial)}
          <span class="inbox-channel-badge" title="WhatsApp"><i class="ti ti-brand-whatsapp"></i></span>
        </div>
        <div class="inbox-info">
          <div class="inbox-name-row">
            <span class="inbox-name-text">${c.favorite ? '<i class="ti ti-star-filled inbox-fav-star"></i> ' : ''}${_escapeHtml(name)}</span>
            <span class="inbox-time">${time}</span>
          </div>
          <div class="inbox-preview">${_escapeHtml(preview)}</div>
          <div class="inbox-meta">
            ${statusPill}${flowPill}${archivedPill}${tagPills}
            ${unread > 0 ? `<div class="unread-dot" style="margin-left:auto">${unread}</div>` : ''}
          </div>
        </div>
      </div>`;
  }

  // ══════════════════════════════════════════════════════════════════════
  // Abrir conversa
  // ══════════════════════════════════════════════════════════════════════
  async function _openConversation(phone) {
    if (!phone || !_contactsReady) return;

    _activePhone   = phone;
    _quotedMessage = null;
    _renderList();

    const contact = _contacts.find(c => c.phone === phone);
    if (!contact) {
      console.warn('[InboxView] contacto não encontrado:', phone);
      _renderEmptyChat();
      return;
    }
    _activeContact = contact;
    _renderChatHeader(contact);
    _renderChatLoading();

    if (contact.unreadCount > 0) {
      contact.unreadCount = 0;
      _renderList();
    }
    _markAsRead(phone);

    _startMessagesListener(phone);
    _startEventsListener(phone);
    _wireChatInput(phone);
    _wireComposerExtras(phone);
    _wireChatSearch(phone);

    const panel = document.getElementById('inbox-contact-panel');
    if (panel && panel.style.display !== 'none') _renderICPActivePane(contact);
  }

  function _icpPanelOpen() {
    const panel = document.getElementById('inbox-contact-panel');
    return !!panel && panel.style.display !== 'none';
  }

  // ── Mensagens — listener em tempo real ──────────────────────────────
  let _lastMessageCount = 0;
  let _lastMessageIds = new Set();
  let _renderingMessages = false;
  
  function _startMessagesListener(phone) {
    _stopMessagesListener();
    const col = _messagesCol(phone);
    if (!col) {
      _renderMessagesError('Firestore não disponível. Recarregue a página.');
      return;
    }
    _msgsUnsubscribe = col.orderBy('timestamp', 'asc').onSnapshot(snap => {
      if (_renderingMessages) return; // Skip se já está a renderizar
      
      _renderingMessages = true;
      const newMessages = snap.docs.map(d => ({ _docId: d.id, ...d.data() }));
      const newMessageIds = new Set(newMessages.map(m => m._docId));
      
      // Detectar se apenas adicionou mensagens novas (sem deletar/editar)
      const onlyAdded = newMessages.length > _lastMessageCount && 
                       _lastMessageIds.size > 0 &&
                       Array.from(_lastMessageIds).every(id => newMessageIds.has(id));
      
      _messages = newMessages;
      _lastMessageCount = newMessages.length;
      _lastMessageIds = newMessageIds;
      
      // Se apenas adicionou mensagens, apenas adiciona novas ao DOM (evita pisca)
      if (onlyAdded) {
        _appendNewMessages(_messages);
      } else {
        // Caso contrário (primeira carga, deleção, edição), renderiza completo
        _renderMessages(_messages);
      }
      
      _renderingMessages = false;
      
      if (_icpTab === 'files' && _icpPanelOpen()) _renderICPFiles();
    }, err => {
      console.warn('[InboxView] listener de mensagens falhou:', err.message);
      _renderMessagesError('Não foi possível carregar as mensagens. (' + err.message + ')');
      _renderingMessages = false;
    });
  }
  
  function _appendNewMessages(messages) {
    const msgsEl = document.getElementById('inbox-messages');
    if (!msgsEl) return;
    
    const existingMsgs = msgsEl.querySelectorAll('[data-mid]');
    const existingIds = new Set(Array.from(existingMsgs).map(el => el.dataset.mid));
    
    // Adicionar apenas mensagens que não estão no DOM
    messages.forEach(m => {
      if (!existingIds.has(m._docId)) {
        const html = _messageHtml(m);
        msgsEl.innerHTML += html;
      }
    });
    
    // Fazer scroll para baixo suavemente
    setTimeout(() => {
      msgsEl.scrollTop = msgsEl.scrollHeight;
      _wireMessageActions();
    }, 10);
  }

  function _stopMessagesListener() {
    if (_msgsUnsubscribe) { _msgsUnsubscribe(); _msgsUnsubscribe = null; }
  }

  // ── Timeline — listener em tempo real ───────────────────────────────
  function _startEventsListener(phone) {
    _stopEventsListener();
    const col = _eventsCol(phone);
    if (!col) return;
    _eventsUnsubscribe = col.orderBy('timestamp', 'asc').onSnapshot(snap => {
      _events = snap.docs.map(d => ({ _docId: d.id, ...d.data() }));
      if (_icpTab === 'timeline' && _icpPanelOpen()) _renderICPTimeline();
    }, err => {
      console.warn('[InboxView] listener de eventos falhou:', err.message);
    });
  }

  function _stopEventsListener() {
    if (_eventsUnsubscribe) { _eventsUnsubscribe(); _eventsUnsubscribe = null; }
  }

  function _logEvent(phone, type, label) {
    const col = _eventsCol(phone);
    if (!col) return;
    col.add({ type, label, timestamp: Date.now(), source: 'user' }).catch(e => {
      console.warn('[InboxView] Não foi possível gravar evento na timeline:', e.message);
    });
  }

  async function _markAsRead(phone) {
    try {
      await fetch(`${BACKEND_URL}/inbox/${_uid}/${encodeURIComponent(phone)}/read`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: _uid }),
      });
    } catch (e) {
      console.warn('[InboxView] Não foi possível marcar como lida:', e.message);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // Cabeçalho do chat
  // ══════════════════════════════════════════════════════════════════════
  function _renderChatHeader(contact) {
    const chatArea = document.querySelector('#view-inbox .chat-area');
    if (!chatArea) return;

    const name    = contact?.displayName || contact?.phone || '';
    const phone   = contact?.phone || '';
    const initial = (name || '?').trim()[0]?.toUpperCase() || '?';
    const color   = _colorFor(phone || name);

    chatArea.style.display = '';
    const stMap = { bot:'Bot ativo', human:'Atendimento humano', waiting:'Aguardando', done:'Resolvida', finished:'Resolvida' };
    const stCls = { bot:'bot', human:'human', waiting:'waiting', done:'done', finished:'done' };
    const cStatus  = contact?.status || 'bot';
    const stLabel  = stMap[cStatus] || 'Bot ativo';
    const stClass  = stCls[cStatus] || 'bot';
    const isHuman  = cStatus === 'human';
    const isResolved = cStatus === 'done' || cStatus === 'finished';
    const isArchived = contact?.archived === true;
    const flowLabel = contact?.activeFlowId ? `Fluxo: ${_escapeHtml(contact.activeFlowId)}` : 'Sem fluxo';
    const tags = Array.isArray(contact?.tags) ? contact.tags : [];
    const tagPillsHeader = tags.slice(0,2).map(t => `<span class="inbox-tag">${_escapeHtml(t)}</span>`).join('');

    chatArea.innerHTML = `
      <div class="chat-header">
        <div class="chat-header-av" style="background:${color}">${_escapeHtml(initial)}</div>
        <div class="chat-header-info">
          <div id="inbox-chat-name" class="chat-header-name" title="Clique para editar o nome">
            ${_escapeHtml(name)}
          </div>
          <div class="chat-header-meta">
            <span class="inbox-status-pill ${stClass}"><i class="ti ti-circle-dot" style="font-size:10px"></i>${_escapeHtml(stLabel)}</span>
            <span class="inbox-dot-sep">·</span>
            <span class="inbox-flow-pill"><i class="ti ti-hierarchy" style="font-size:10px"></i>${flowLabel}</span>
            ${tagPillsHeader ? `<span class="inbox-dot-sep">·</span>${tagPillsHeader}` : ''}
          </div>
        </div>
        <div class="chat-header-actions">
          <button class="inbox-icon-btn" id="inbox-btn-search" title="Pesquisar na conversa"><i class="ti ti-search"></i></button>
          <button class="chat-action-btn${contact?.favorite ? ' fav-on' : ''}" id="inbox-btn-fav" title="Marcar como favorita">
            <i class="ti ${contact?.favorite ? 'ti-star-filled' : 'ti-star'}"></i>
          </button>
          <button class="chat-action-btn ${isHuman ? 'release' : 'assume'}" id="inbox-btn-assume" title="${isHuman ? 'Devolver a conversa à IA' : 'Assumir este atendimento'}">
            <i class="ti ${isHuman ? 'ti-robot' : 'ti-headset'}"></i> ${isHuman ? 'Voltar para IA' : 'Assumir atendimento'}
          </button>
          <button class="inbox-icon-btn" id="inbox-btn-info" title="Ver dados do contacto"><i class="ti ti-info-circle"></i></button>
          <div class="chat-more-wrap">
            <button class="inbox-icon-btn" id="inbox-btn-more" title="Mais opções"><i class="ti ti-dots-vertical"></i></button>
            <div class="chat-more-menu" id="inbox-more-menu">
              <button class="chat-more-item" data-act="archive"><i class="ti ti-archive"></i> ${isArchived ? 'Desarquivar conversa' : 'Arquivar conversa'}</button>
              <button class="chat-more-item" data-act="resolve"><i class="ti ti-circle-check"></i> ${isResolved ? 'Reabrir conversa' : 'Marcar como resolvida'}</button>
              <div class="chat-more-sep"></div>
              <button class="chat-more-item danger" data-act="delete"><i class="ti ti-trash"></i> Apagar contacto</button>
            </div>
          </div>
        </div>
      </div>
      ${isArchived ? `<div class="chat-status-banner archived"><i class="ti ti-archive"></i> Esta conversa está arquivada.<button id="inbox-banner-unarchive">Desarquivar</button></div>` : ''}
      ${(!isArchived && isResolved) ? `<div class="chat-status-banner resolved"><i class="ti ti-circle-check"></i> Esta conversa foi marcada como resolvida.<button id="inbox-banner-reopen">Reabrir</button></div>` : ''}
      <div class="chat-search-bar" id="chat-search-bar">
        <i class="ti ti-search" style="color:var(--k-muted);font-size:13px"></i>
        <input type="text" id="chat-search-input" placeholder="Pesquisar nesta conversa...">
        <span class="csb-count" id="chat-search-count"></span>
        <button id="chat-search-close" title="Fechar"><i class="ti ti-x"></i></button>
      </div>
      <div class="messages" id="inbox-messages"></div>
      <div class="chat-reply-bar" id="chat-reply-bar">
        <div class="chat-reply-bar-line">
          <div class="chat-reply-bar-title" id="chat-reply-bar-title">A responder</div>
          <div class="chat-reply-bar-text" id="chat-reply-bar-text"></div>
        </div>
        <button id="chat-reply-cancel" title="Cancelar"><i class="ti ti-x"></i></button>
      </div>
      <div class="chat-input" style="position:relative">
        <button class="chat-input-icon" id="inbox-btn-attach" data-popover-trigger title="Anexar"><i class="ti ti-paperclip"></i></button>
        <button class="chat-input-icon" id="inbox-btn-emoji" data-popover-trigger title="Emoji"><i class="ti ti-mood-smile"></i></button>
        <button class="chat-input-icon" id="inbox-btn-qr" data-popover-trigger title="Respostas rápidas"><i class="ti ti-message-2-bolt"></i></button>
        <div class="chat-input-wrap">
          <input type="text" id="inbox-chat-input" class="chat-input-field" placeholder="Digite uma mensagem...">
        </div>
        <button class="chat-input-icon soon" id="inbox-btn-audio" title="Gravação de áudio — em breve" disabled><i class="ti ti-microphone"></i></button>
        <button class="send-btn" id="inbox-chat-send" title="Enviar"><i class="ti ti-send"></i></button>

        <div class="chat-popover emoji-popover" id="emoji-popover">
          <div class="emoji-grid">
            ${['😀','😁','😂','🤣','😊','😉','😍','😘','🤔','😎','😢','😭','😡','👍','👎','🙏','👏','🙌','💪','🔥','✅','❌','⏰','📌','📎','💬','❤️','🎉'].map(e => `<button type="button" data-emoji="${e}">${e}</button>`).join('')}
          </div>
        </div>

        <div class="chat-popover attach-popover" id="attach-popover">
          <button type="button" class="attach-opt" data-soon="imagem"><i class="ti ti-photo"></i> Imagem <span class="soon-tag">Em breve</span></button>
          <button type="button" class="attach-opt" data-soon="video"><i class="ti ti-video"></i> Vídeo <span class="soon-tag">Em breve</span></button>
          <button type="button" class="attach-opt" data-soon="documento"><i class="ti ti-file"></i> Documento <span class="soon-tag">Em breve</span></button>
          <button type="button" class="attach-opt" data-soon="pdf"><i class="ti ti-file-type-pdf"></i> PDF <span class="soon-tag">Em breve</span></button>
        </div>

        <div class="chat-popover quickreply-popover" id="qr-popover">
          <div class="qr-popover-head">
            <span>Respostas rápidas</span>
            <button type="button" id="qr-add-btn"><i class="ti ti-plus" style="font-size:11px"></i> Nova</button>
          </div>
          <div class="qr-popover-list" id="qr-popover-list"></div>
        </div>
      </div>`;

    const nameEl = document.getElementById('inbox-chat-name');
    if (nameEl) nameEl.addEventListener('click', () => _promptRename(phone, contact?.savedName));

    const infoBtn = document.getElementById('inbox-btn-info');
    if (infoBtn) infoBtn.addEventListener('click', () => _toggleContactPanel(contact));

    const favBtn = document.getElementById('inbox-btn-fav');
    if (favBtn) favBtn.addEventListener('click', () => _toggleContactFavorite(phone, !(contact?.favorite === true)));

    const assumeBtn = document.getElementById('inbox-btn-assume');
    if (assumeBtn) assumeBtn.addEventListener('click', () => isHuman ? _releaseToAI(phone) : _assumeAttendance(phone));

    const moreBtn  = document.getElementById('inbox-btn-more');
    const moreMenu = document.getElementById('inbox-more-menu');
    if (moreBtn && moreMenu) {
      moreBtn.addEventListener('click', e => { e.stopPropagation(); moreMenu.classList.toggle('open'); });
      moreMenu.querySelectorAll('.chat-more-item').forEach(item => {
        item.addEventListener('click', () => {
          moreMenu.classList.remove('open');
          const act = item.dataset.act;
          if (act === 'archive') _toggleArchive(phone, !isArchived);
          else if (act === 'resolve') _toggleResolve(phone, !isResolved);
          else if (act === 'delete') _deleteContact(phone, contact?.displayName || phone);
        });
      });
    }

    const unarchiveBtn = document.getElementById('inbox-banner-unarchive');
    if (unarchiveBtn) unarchiveBtn.addEventListener('click', () => _toggleArchive(phone, false));
    const reopenBtn = document.getElementById('inbox-banner-reopen');
    if (reopenBtn) reopenBtn.addEventListener('click', () => _toggleResolve(phone, false));

    // Reply bar cancel
    const replyCancel = document.getElementById('chat-reply-cancel');
    if (replyCancel) replyCancel.addEventListener('click', _cancelReply);
  }

  function _renderChatLoading() {
    const msgsEl = document.getElementById('inbox-messages');
    if (msgsEl) msgsEl.innerHTML = `<div style="text-align:center;color:var(--k-muted);font-size:11px;padding:20px">A carregar conversa...</div>`;
  }

  function _renderMessagesError(msg) {
    const msgsEl = document.getElementById('inbox-messages');
    if (msgsEl) {
      msgsEl.innerHTML = `<div style="text-align:center;color:#f87171;font-size:11px;padding:20px;line-height:1.6">
        <i class="ti ti-alert-circle" style="font-size:18px;display:block;margin-bottom:6px"></i>
        ${_escapeHtml(msg)}
      </div>`;
    }
  }

  function _renderEmptyChat() {
    const chatArea = document.querySelector('#view-inbox .chat-area');
    if (!chatArea) return;
    chatArea.style.display = '';
    chatArea.innerHTML = `
      <div class="chat-empty">
        <div class="chat-empty-inner">
          <div class="chat-empty-icon"><i class="ti ti-messages"></i></div>
          <div style="font-size:16px;font-weight:600;color:var(--k-text)">Nenhuma conversa seleccionada</div>
          <div style="font-size:12px;color:var(--k-muted);line-height:1.7">Selecione uma conversa à esquerda para ver o histórico de mensagens.</div>
        </div>
      </div>`;
    const panel = document.getElementById('inbox-contact-panel');
    if (panel) panel.style.display = 'none';
  }

  // ══════════════════════════════════════════════════════════════════════
  // Mensagens
  // ══════════════════════════════════════════════════════════════════════
  function _renderMessages(messages) {
    const msgsEl = document.getElementById('inbox-messages');
    if (!msgsEl) return;

    if (!messages.length) {
      msgsEl.innerHTML = `<div style="text-align:center;color:var(--k-muted);font-size:11px;padding:20px">Ainda não há mensagens nesta conversa.</div>`;
      return;
    }

    let html = '';
    let lastDateKey = null;
    messages.forEach(m => {
      const d = new Date(m.timestamp || Date.now());
      const dateKey = d.toDateString();
      if (dateKey !== lastDateKey) {
        lastDateKey = dateKey;
        html += `<div class="msg-date-sep"><span>${_formatDateSep(d)}</span></div>`;
      }
      html += _messageHtml(m);
    });

    msgsEl.innerHTML = html;
    // Scroll com delay para evitar pisca visual
    setTimeout(() => {
      msgsEl.scrollTop = msgsEl.scrollHeight;
      _wireMessageActions();
    }, 20);
  }

  function _formatDateSep(d) {
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return 'Hoje';
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    if (d.toDateString() === yest.toDateString()) return 'Ontem';
    return d.toLocaleDateString('pt-PT', { day: '2-digit', month: 'long', year: 'numeric' });
  }

  function _messageHtml(m) {
    const dir  = m.direction === 'outgoing' ? 'out' : 'in';
    const time = _formatTime(m.timestamp);
    const mid  = m._docId || m.id || '';

    if (m.deleted) {
      return `
        <div class="msg ${dir} deleted" data-mid="${_escapeAttr(mid)}">
          <div style="display:flex;align-items:center;gap:6px"><i class="ti ti-ban"></i> Mensagem apagada</div>
          <div class="msg-meta"><span class="msg-time">${time}</span></div>
        </div>`;
    }

    const body  = _messageBodyHtml(m);
    const ticks = dir === 'out' ? `<span class="msg-ticks"><i class="ti ti-checks"></i></span>` : '';
    const quote = m.quotedText
      ? `<div class="msg-quote"><b>${_escapeHtml(m.quotedFrom || 'Mensagem citada')}</b>${_escapeHtml(_truncate(m.quotedText, 120))}</div>`
      : '';
    const favMark = m.favorite ? `<span class="msg-fav-mark"><i class="ti ti-star-filled"></i></span>` : '';

    return `
      <div class="msg ${dir}" data-mid="${_escapeAttr(mid)}">
        ${favMark}
        <div class="msg-actions">
          <button class="msg-action-btn act-reply" title="Responder"><i class="ti ti-arrow-back-up"></i></button>
          <button class="msg-action-btn act-copy" title="Copiar"><i class="ti ti-copy"></i></button>
          <button class="msg-action-btn act-forward" title="Encaminhar"><i class="ti ti-arrow-forward-up"></i></button>
          <button class="msg-action-btn act-fav" title="${m.favorite ? 'Remover dos favoritos' : 'Favoritar'}"><i class="ti ${m.favorite ? 'ti-star-filled' : 'ti-star'}"></i></button>
          <button class="msg-action-btn act-delete" title="Apagar mensagem"><i class="ti ti-trash"></i></button>
        </div>
        ${quote}
        ${body}
        <div class="msg-meta">
          ${ticks}
          <span class="msg-time">${time}</span>
        </div>
      </div>`;
  }

  function _messageBodyHtml(m) {
    const caption = m.text ? `<div style="margin-top:4px">${_escapeHtml(m.text)}</div>` : '';

    switch (m.type) {
      case 'image':
        return m.mediaUrl
          ? `<img src="${_escapeAttr(m.mediaUrl)}" style="max-width:100%;border-radius:8px;display:block">${caption}`
          : `<div style="display:flex;align-items:center;gap:6px"><i class="ti ti-photo"></i> Imagem recebida</div>${caption}`;
      case 'video':
        return m.mediaUrl
          ? `<video src="${_escapeAttr(m.mediaUrl)}" controls style="max-width:100%;border-radius:8px;display:block"></video>${caption}`
          : `<div style="display:flex;align-items:center;gap:6px"><i class="ti ti-video"></i> Vídeo recebido</div>${caption}`;
      case 'audio':
        return m.mediaUrl
          ? `<audio src="${_escapeAttr(m.mediaUrl)}" controls style="max-width:100%"></audio>${caption}`
          : `<div style="display:flex;align-items:center;gap:6px"><i class="ti ti-microphone"></i> Áudio recebido</div>${caption}`;
      case 'document':
        return m.mediaUrl
          ? `<a href="${_escapeAttr(m.mediaUrl)}" target="_blank" style="display:flex;align-items:center;gap:6px;color:inherit"><i class="ti ti-file"></i> Documento</a>${caption}`
          : `<div style="display:flex;align-items:center;gap:6px"><i class="ti ti-file"></i> Documento recebido</div>${caption}`;
      case 'location':
        return (m.lat != null && m.lng != null)
          ? `<div class="msg-location"><i class="ti ti-map-pin"></i> <a href="https://maps.google.com/?q=${m.lat},${m.lng}" target="_blank">Ver localização</a></div>${caption}`
          : `<div style="display:flex;align-items:center;gap:6px"><i class="ti ti-map-pin"></i> Localização recebida</div>${caption}`;
      default:
        return `<div>${_escapeHtml(m.text || '')}</div>`;
    }
  }

  // ── Acções sobre mensagens (delegação por re-render) ────────────────
  function _wireMessageActions() {
    const msgsEl = document.getElementById('inbox-messages');
    if (!msgsEl) return;
    msgsEl.querySelectorAll('.msg[data-mid]').forEach(el => {
      const mid = el.dataset.mid;
      const m = _messages.find(x => (x._docId || x.id) === mid);
      if (!m) return;

      const replyBtn = el.querySelector('.act-reply');
      if (replyBtn) replyBtn.addEventListener('click', () => _replyToMessage(m));

      const copyBtn = el.querySelector('.act-copy');
      if (copyBtn) copyBtn.addEventListener('click', () => _copyMessage(m));

      const fwdBtn = el.querySelector('.act-forward');
      if (fwdBtn) fwdBtn.addEventListener('click', () => _openForwardPicker(m, fwdBtn));

      const favBtn = el.querySelector('.act-fav');
      if (favBtn) favBtn.addEventListener('click', () => _toggleMessageFavorite(m));

      const delBtn = el.querySelector('.act-delete');
      if (delBtn) delBtn.addEventListener('click', () => _deleteMessage(m));
    });
  }

  function _replyToMessage(m) {
    _quotedMessage = m;
    const bar = document.getElementById('chat-reply-bar');
    const titleEl = document.getElementById('chat-reply-bar-title');
    const textEl  = document.getElementById('chat-reply-bar-text');
    if (!bar) return;
    const who = m.direction === 'outgoing' ? 'A si mesmo' : (_activeContact?.displayName || 'cliente');
    if (titleEl) titleEl.textContent = `A responder a ${who}`;
    if (textEl)  textEl.textContent  = m.text || _mediaLabel(m.type);
    bar.classList.add('open');
    const input = document.getElementById('inbox-chat-input');
    if (input) input.focus();
  }

  function _cancelReply() {
    _quotedMessage = null;
    const bar = document.getElementById('chat-reply-bar');
    if (bar) bar.classList.remove('open');
  }

  function _mediaLabel(type) {
    return { image: '📷 Imagem', video: '🎥 Vídeo', audio: '🎵 Áudio', document: '📄 Documento', location: '📍 Localização' }[type] || 'mensagem';
  }

  async function _copyMessage(m) {
    const text = m.text || _mediaLabel(m.type);
    try {
      await navigator.clipboard.writeText(text);
      _toast('Mensagem copiada.');
    } catch (e) {
      _toast('Não foi possível copiar.', 'error');
    }
  }

  async function _toggleMessageFavorite(m) {
    const phone = _activePhone;
    const col = _messagesCol(phone);
    if (!col) return;
    const mid = m._docId || m.id;
    try {
      await col.doc(mid).set({ favorite: !(m.favorite === true) }, { merge: true });
    } catch (e) {
      _toast('Não foi possível favoritar a mensagem.', 'error');
    }
  }

  async function _deleteMessage(m) {
    const confirmed = window.confirm('Apagar esta mensagem? O histórico da conversa não é afectado, apenas o conteúdo desta mensagem deixa de ser mostrado.');
    if (!confirmed) return;
    const phone = _activePhone;
    const col = _messagesCol(phone);
    if (!col) return;
    const mid = m._docId || m.id;
    try {
      await col.doc(mid).set({ deleted: true }, { merge: true });
    } catch (e) {
      _toast('Não foi possível apagar a mensagem.', 'error');
    }
  }

  // ── Encaminhar mensagem ──────────────────────────────────────────────
  function _openForwardPicker(m, anchorBtn) {
    document.querySelectorAll('.forward-popover').forEach(p => p.remove());

    const pop = document.createElement('div');
    pop.className = 'chat-popover forward-popover open';
    pop.innerHTML = `
      <div class="fwd-search"><input type="text" placeholder="Pesquisar contacto..." id="fwd-search-input"></div>
      <div class="fwd-list" id="fwd-list"></div>`;
    anchorBtn.style.position = 'relative';
    anchorBtn.appendChild(pop);

    const renderFwdList = (term) => {
      const list = document.getElementById('fwd-list');
      if (!list) return;
      const t = (term || '').toLowerCase();
      const items = _contacts.filter(c => c.phone !== _activePhone && (
        !t || (c.displayName || '').toLowerCase().includes(t) || (c.phone || '').toLowerCase().includes(t)
      )).slice(0, 30);
      if (!items.length) {
        list.innerHTML = `<div style="padding:18px;text-align:center;font-size:11px;color:var(--k-muted)">Nenhum contacto encontrado</div>`;
        return;
      }
      list.innerHTML = items.map(c => {
        const name = c.displayName || c.phone;
        const initial = (name || '?').trim()[0]?.toUpperCase() || '?';
        return `<div class="fwd-item" data-phone="${_escapeAttr(c.phone)}">
          <div class="fwd-av" style="background:${_colorFor(c.phone)}">${_escapeHtml(initial)}</div>
          <span>${_escapeHtml(name)}</span>
        </div>`;
      }).join('');
      list.querySelectorAll('.fwd-item').forEach(it => {
        it.addEventListener('click', () => _forwardMessageTo(m, it.dataset.phone, pop));
      });
    };
    renderFwdList('');

    const searchInput = document.getElementById('fwd-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', e => renderFwdList(e.target.value));
      searchInput.focus();
    }
  }

  async function _forwardMessageTo(m, targetPhone, popEl) {
    popEl.remove();
    const text = m.text ? m.text : `📎 Encaminhado: ${_mediaLabel(m.type)}`;
    const finalText = `↪ Encaminhada:\n${text}`;
    try {
      const res = await fetch(`${BACKEND_URL}/inbox/${_uid}/${encodeURIComponent(targetPhone)}/send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: _uid, text: finalText }),
      });
      const data = await res.json();
      if (data.ok) _toast('Mensagem encaminhada.');
      else _toast('Não foi possível encaminhar: ' + (data.error || 'erro desconhecido'), 'error');
    } catch (e) {
      _toast('Servidor Korvex indisponível.', 'error');
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // Pesquisa dentro da conversa
  // ══════════════════════════════════════════════════════════════════════
  function _wireChatSearch(phone) {
    const searchBtn  = document.getElementById('inbox-btn-search');
    const bar        = document.getElementById('chat-search-bar');
    const input      = document.getElementById('chat-search-input');
    const closeBtn   = document.getElementById('chat-search-close');
    const countEl    = document.getElementById('chat-search-count');
    if (!searchBtn || !bar || !input) return;

    const apply = () => {
      const term = (input.value || '').trim().toLowerCase();
      const msgsEl = document.getElementById('inbox-messages');
      if (!msgsEl) return;
      if (!term) {
        msgsEl.querySelectorAll('.msg').forEach(el => el.classList.remove('search-hit', 'search-dim'));
        if (countEl) countEl.textContent = '';
        return;
      }
      let hits = 0;
      msgsEl.querySelectorAll('.msg').forEach(el => {
        const mid = el.dataset.mid;
        const m = _messages.find(x => (x._docId || x.id) === mid);
        const text = (m?.text || '').toLowerCase();
        const isHit = text.includes(term);
        el.classList.toggle('search-hit', isHit);
        el.classList.toggle('search-dim', !isHit);
        if (isHit) hits++;
      });
      if (countEl) countEl.textContent = hits ? `${hits} resultado(s)` : 'Sem resultados';
    };

    searchBtn.addEventListener('click', () => {
      bar.classList.add('open');
      input.focus();
    });
    if (closeBtn) closeBtn.addEventListener('click', () => {
      bar.classList.remove('open');
      input.value = '';
      apply();
    });
    input.addEventListener('input', apply);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Composer — emoji / anexos / respostas rápidas
  // ══════════════════════════════════════════════════════════════════════
  function _wireComposerExtras(phone) {
    const emojiBtn = document.getElementById('inbox-btn-emoji');
    const emojiPop = document.getElementById('emoji-popover');
    if (emojiBtn && emojiPop) {
      emojiBtn.addEventListener('click', e => { e.stopPropagation(); _togglePopover(emojiPop); });
      emojiPop.querySelectorAll('button[data-emoji]').forEach(b => {
        b.addEventListener('click', () => {
          const input = document.getElementById('inbox-chat-input');
          if (input) { input.value += b.dataset.emoji; input.focus(); }
        });
      });
    }

    const attachBtn = document.getElementById('inbox-btn-attach');
    const attachPop = document.getElementById('attach-popover');
    if (attachBtn && attachPop) {
      attachBtn.addEventListener('click', e => { e.stopPropagation(); _togglePopover(attachPop); });
      attachPop.querySelectorAll('.attach-opt').forEach(b => {
        b.addEventListener('click', () => {
          attachPop.classList.remove('open');
          _toast('Envio de anexos pela Inbox estará disponível numa próxima actualização.', 'error');
        });
      });
    }

    const qrBtn = document.getElementById('inbox-btn-qr');
    const qrPop = document.getElementById('qr-popover');
    if (qrBtn && qrPop) {
      qrBtn.addEventListener('click', e => { e.stopPropagation(); _togglePopover(qrPop); _renderQuickRepliesList(); });
      const addBtn = document.getElementById('qr-add-btn');
      if (addBtn) addBtn.addEventListener('click', () => _promptAddQuickReply());
    }
  }

  function _togglePopover(pop) {
    const willOpen = !pop.classList.contains('open');
    document.querySelectorAll('.chat-popover.open').forEach(p => p.classList.remove('open'));
    if (willOpen) pop.classList.add('open');
  }

  // ══════════════════════════════════════════════════════════════════════
  // Respostas rápidas (quickReplies)
  // ══════════════════════════════════════════════════════════════════════
  function _startQuickRepliesListener() {
    const col = _quickRepliesCol();
    if (!col) return;
    _qrUnsubscribe = col.orderBy('createdAt', 'desc').onSnapshot(snap => {
      _quickReplies = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      _renderQuickRepliesList();
    }, err => console.warn('[InboxView] listener de respostas rápidas falhou:', err.message));
  }

  function _stopQuickRepliesListener() {
    if (_qrUnsubscribe) { _qrUnsubscribe(); _qrUnsubscribe = null; }
  }

  function _renderQuickRepliesList() {
    const list = document.getElementById('qr-popover-list');
    if (!list) return;
    if (!_quickReplies.length) {
      list.innerHTML = `<div class="qr-empty">Sem respostas rápidas. Clique em "Nova" para criar a primeira.</div>`;
      return;
    }
    list.innerHTML = _quickReplies.map(qr => `
      <div class="qr-item" data-id="${_escapeAttr(qr.id)}">
        <div class="qr-item-body">
          <div class="qr-item-shortcut">/${_escapeHtml(qr.shortcut || '')}</div>
          <div class="qr-item-text">${_escapeHtml(qr.text || '')}</div>
        </div>
        <button class="qr-item-del" title="Apagar"><i class="ti ti-trash"></i></button>
      </div>`).join('');

    list.querySelectorAll('.qr-item').forEach(el => {
      el.addEventListener('click', e => {
        if (e.target.closest('.qr-item-del')) return;
        const qr = _quickReplies.find(x => x.id === el.dataset.id);
        const input = document.getElementById('inbox-chat-input');
        if (qr && input) { input.value = qr.text || ''; input.focus(); }
        document.getElementById('qr-popover')?.classList.remove('open');
      });
      const delBtn = el.querySelector('.qr-item-del');
      if (delBtn) delBtn.addEventListener('click', () => _deleteQuickReply(el.dataset.id));
    });
  }

  function _openQuickRepliesPopover(anchorBtn) {
    const pop = document.getElementById('qr-popover-global') || _createGlobalQrPopover();
    anchorBtn.style.position = 'relative';
    if (pop.parentElement !== anchorBtn) anchorBtn.appendChild(pop);
    _togglePopover(pop);
    _renderQuickRepliesListInto(pop.querySelector('.qr-popover-list'));
  }

  function _createGlobalQrPopover() {
    const pop = document.createElement('div');
    pop.id = 'qr-popover-global';
    pop.className = 'chat-popover quickreply-popover';
    pop.style.bottom = 'auto';
    pop.style.top = '36px';
    pop.style.left = 'auto';
    pop.style.right = '0';
    pop.innerHTML = `
      <div class="qr-popover-head"><span>Respostas rápidas</span><button type="button" id="qr-add-btn-global"><i class="ti ti-plus" style="font-size:11px"></i> Nova</button></div>
      <div class="qr-popover-list"></div>`;
    pop.querySelector('#qr-add-btn-global').addEventListener('click', () => _promptAddQuickReply());
    return pop;
  }

  function _renderQuickRepliesListInto(listEl) {
    if (!listEl) return;
    if (!_quickReplies.length) {
      listEl.innerHTML = `<div class="qr-empty">Sem respostas rápidas. Clique em "Nova" para criar a primeira.</div>`;
      return;
    }
    listEl.innerHTML = _quickReplies.map(qr => `
      <div class="qr-item" data-id="${_escapeAttr(qr.id)}">
        <div class="qr-item-body">
          <div class="qr-item-shortcut">/${_escapeHtml(qr.shortcut || '')}</div>
          <div class="qr-item-text">${_escapeHtml(qr.text || '')}</div>
        </div>
        <button class="qr-item-del" title="Apagar"><i class="ti ti-trash"></i></button>
      </div>`).join('');
    listEl.querySelectorAll('.qr-item-del').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        _deleteQuickReply(btn.closest('.qr-item').dataset.id);
      });
    });
  }

  async function _promptAddQuickReply() {
    const shortcut = window.prompt('Atalho da resposta rápida (ex: saudacao):');
    if (shortcut === null || !shortcut.trim()) return;
    const text = window.prompt('Texto da resposta rápida:');
    if (text === null || !text.trim()) return;
    const col = _quickRepliesCol();
    if (!col) return;
    try {
      await col.add({ shortcut: shortcut.trim(), text: text.trim(), createdAt: Date.now() });
      _toast('Resposta rápida criada.');
    } catch (e) {
      _toast('Não foi possível criar a resposta rápida.', 'error');
    }
  }

  async function _deleteQuickReply(id) {
    if (!id) return;
    const confirmed = window.confirm('Apagar esta resposta rápida?');
    if (!confirmed) return;
    const col = _quickRepliesCol();
    if (!col) return;
    try {
      await col.doc(id).delete();
    } catch (e) {
      _toast('Não foi possível apagar.', 'error');
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // Envio manual de mensagens
  // ══════════════════════════════════════════════════════════════════════
  let _wiredPhone = null;
  function _wireChatInput(phone) {
    const input = document.getElementById('inbox-chat-input');
    const btn   = document.getElementById('inbox-chat-send');
    if (!input || !btn) return;

    if (_wiredPhone === phone && input.dataset.wired === '1') return;
    _wiredPhone = phone;
    input.dataset.wired = '1';

    const send = () => _sendManualMessage(phone, input);
    btn.addEventListener('click', send);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
  }

  async function _sendManualMessage(phone, input) {
    let text = (input.value || '').trim();
    if (!text) return;

    let finalText = text;
    if (_quotedMessage) {
      const quoted = _quotedMessage.text || _mediaLabel(_quotedMessage.type);
      finalText = `↳ ${_truncate(quoted, 80)}\n${text}`;
    }

    input.value = '';
    input.disabled = true;
    const quotedSnapshot = _quotedMessage;
    _cancelReply();

    try {
      const res = await fetch(`${BACKEND_URL}/inbox/${_uid}/${encodeURIComponent(phone)}/send`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ uid: _uid, text: finalText }),
      });
      const data = await res.json();
      if (!data.ok) {
        console.warn('[InboxView] Falha ao enviar:', data.error);
        _toast('Não foi possível enviar a mensagem: ' + (data.error || 'erro desconhecido'), 'error');
        input.value = text; // devolver o texto ao campo para não se perder
      }
    } catch (e) {
      console.warn('[InboxView] Backend indisponível ao enviar:', e.message);
      _toast('Não foi possível contactar o servidor Korvex.', 'error');
      input.value = text;
    } finally {
      input.disabled = false;
      input.focus();
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // Assumir atendimento / Voltar para IA
  // ══════════════════════════════════════════════════════════════════════
  async function _assumeAttendance(phone) {
    try {
      const res = await fetch(`${BACKEND_URL}/admin/sessions/${_uid}/${encodeURIComponent(phone)}/block-ai`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: _uid }),
      });
      const data = await res.json();
      if (!data.ok) { _toast('Não foi possível assumir o atendimento: ' + (data.error || ''), 'error'); return; }

      const ref = _inboxDocRef(phone);
      const operator = (typeof AuthService !== 'undefined' ? AuthService.currentUser()?.email : null) || null;
      if (ref) await ref.set({ status: 'human', assignedTo: operator, updatedAt: Date.now() }, { merge: true });
      _logEvent(phone, 'human_assumed', operator ? `${operator} assumiu o atendimento` : 'Humano assumiu o atendimento');
      _toast('Assumiste este atendimento. A IA deixou de responder.');
    } catch (e) {
      _toast('Servidor Korvex indisponível.', 'error');
    }
  }

  async function _releaseToAI(phone) {
    try {
      const res = await fetch(`${BACKEND_URL}/admin/sessions/${_uid}/${encodeURIComponent(phone)}/unblock-ai`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: _uid }),
      });
      const data = await res.json();
      if (!data.ok) { _toast('Não foi possível devolver à IA: ' + (data.error || ''), 'error'); return; }

      const ref = _inboxDocRef(phone);
      if (ref) await ref.set({ status: 'bot', assignedTo: null, updatedAt: Date.now() }, { merge: true });
      _logEvent(phone, 'ai_resumed', 'IA retomou o atendimento, a partir de onde tinha ficado');
      _toast('A IA retomou esta conversa, exactamente de onde ficou.');
    } catch (e) {
      _toast('Servidor Korvex indisponível.', 'error');
    }
  }

  // ── Arquivar / Resolver / Favoritar (contacto) ──────────────────────
  async function _toggleArchive(phone, archived) {
    const ref = _inboxDocRef(phone);
    if (!ref) return;
    try {
      await ref.set({ archived: !!archived, updatedAt: Date.now() }, { merge: true });
      _logEvent(phone, archived ? 'archived' : 'unarchived', archived ? 'Conversa arquivada' : 'Conversa desarquivada');
      _toast(archived ? 'Conversa arquivada.' : 'Conversa desarquivada.');
    } catch (e) {
      _toast('Não foi possível actualizar o arquivo.', 'error');
    }
  }

  async function _toggleResolve(phone, resolved) {
    const ref = _inboxDocRef(phone);
    if (!ref) return;
    try {
      await ref.set({ status: resolved ? 'done' : 'bot', updatedAt: Date.now() }, { merge: true });
      _logEvent(phone, resolved ? 'resolved' : 'reopened', resolved ? 'Conversa marcada como resolvida' : 'Conversa reaberta');
      _toast(resolved ? 'Conversa marcada como resolvida.' : 'Conversa reaberta.');
    } catch (e) {
      _toast('Não foi possível actualizar o estado.', 'error');
    }
  }

  async function _toggleContactFavorite(phone, favorite) {
    const ref = _inboxDocRef(phone);
    if (!ref) return;
    try {
      await ref.set({ favorite: !!favorite, updatedAt: Date.now() }, { merge: true });
    } catch (e) {
      _toast('Não foi possível favoritar.', 'error');
    }
  }

  // ── Renomear contacto ────────────────────────────────────────────────
  async function _promptRename(phone, currentSavedName) {
    if (!phone) return;
    const next = window.prompt('Nome do contacto (deixe vazio para usar o nome do WhatsApp):', currentSavedName || '');
    if (next === null) return;

    try {
      const res = await fetch(`${BACKEND_URL}/inbox/${_uid}/${encodeURIComponent(phone)}/name`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ uid: _uid, savedName: next.trim() || null }),
      });
      const data = await res.json();
      if (data.ok) {
        const nameEl = document.getElementById('inbox-chat-name');
        if (nameEl) nameEl.textContent = data.displayName;
      }
    } catch (e) {
      _toast('Não foi possível contactar o servidor Korvex.', 'error');
    }
  }

  // ── Apagar contacto ───────────────────────────────────────────────────
  async function _deleteContact(phone, displayName) {
    if (!phone) return;
    const confirmed = window.confirm(`Apagar o contacto "${displayName}" e todas as suas mensagens?\n\nEsta acção não pode ser desfeita.`);
    if (!confirmed) return;

    try {
      const res = await fetch(`${BACKEND_URL}/inbox/${_uid}/${encodeURIComponent(phone)}`, {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ uid: _uid }),
      });
      
      if (!res.ok) {
        _toast(`Erro ao apagar: ${res.status} ${res.statusText}`, 'error');
        return;
      }
      
      const data = await res.json();
      if (!data.ok) {
        _toast('Não foi possível apagar o contacto: ' + (data.error || 'erro desconhecido'), 'error');
        return;
      }
      
      // Sucesso — limpar estado e recarregar lista
      _activePhone = null;
      _activeContact = null;
      _renderEmptyChat();
      
      // Remover contacto da lista visível
      const listEl = document.getElementById('inbox-contacts-list');
      if (listEl) {
        const contactEl = listEl.querySelector(`[data-phone="${phone}"]`);
        if (contactEl) contactEl.remove();
      }
      
      // Recarregar lista de contactos do servidor para garantir sincronização
      await _loadContacts();
      
      _toast(`Contacto "${displayName}" apagado com sucesso`, 'success');
    } catch (e) {
      console.error('[_deleteContact] Erro:', e.message);
      _toast('Não foi possível contactar o servidor Korvex.', 'error');
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // Painel lateral do contacto — Info / Timeline / Notas / Ficheiros
  // ══════════════════════════════════════════════════════════════════════
  function _toggleContactPanel(contact) {
    const panel = document.getElementById('inbox-contact-panel');
    if (!panel) return;
    const isOpen = panel.style.display !== 'none';
    if (isOpen) { panel.style.display = 'none'; return; }

    panel.style.display = 'flex';
    _wireICPTabs();
    _renderICPActivePane(contact);

    const closeBtn = document.getElementById('inbox-contact-panel-close');
    if (closeBtn) closeBtn.onclick = () => { panel.style.display = 'none'; };
  }

  let _icpTabsWired = false;
  function _wireICPTabs() {
    if (_icpTabsWired) return;
    _icpTabsWired = true;
    document.querySelectorAll('#icp-tabs .icp-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#icp-tabs .icp-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.icp-pane').forEach(p => p.classList.remove('active'));
        _icpTab = btn.dataset.icpTab;
        document.getElementById(`icp-pane-${_icpTab}`)?.classList.add('active');
        _renderICPActivePane(_activeContact);
      });
    });
  }

  function _renderICPActivePane(contact) {
    if (!contact) return;
    if (_icpTab === 'info') _renderICPInfo(contact);
    else if (_icpTab === 'timeline') _renderICPTimeline();
    else if (_icpTab === 'notes') _renderICPNotes(contact);
    else if (_icpTab === 'files') _renderICPFiles();
  }

  function _renderICPInfo(contact) {
    const pane = document.getElementById('icp-pane-info');
    if (!pane) return;

    const name      = contact.displayName || contact.phone || '—';
    const phone     = contact.phone || '—';
    const initial   = (name || '?').trim()[0]?.toUpperCase() || '?';
    const color     = _colorFor(phone || name);
    const flowId    = contact.activeFlowId || '—';
    const unread    = contact.unreadCount || 0;
    const createdAt = contact.createdAt ? _formatFullDate(contact.createdAt) : '—';
    const updatedAt = contact.lastMessageAt ? _formatFullDate(contact.lastMessageAt) : '—';
    const customerSince = contact.createdAt ? _formatDuration(Date.now() - contact.createdAt) : '—';
    const aiActive = contact.status !== 'human';
    const assignedTo = contact.assignedTo || '—';
    const tags = Array.isArray(contact.tags) ? contact.tags : [];

    pane.innerHTML = `
      <div class="icp-profile">
        <div class="icp-avatar-lg" style="background:${color}">${_escapeHtml(initial)}</div>
        <div class="icp-profile-name">${_escapeHtml(name)}</div>
        <div class="icp-profile-sub"><i class="ti ti-brand-whatsapp" style="color:#22c55e"></i> WhatsApp</div>
      </div>

      <div class="icp-section-title">Etiquetas</div>
      <div class="icp-tag-editor" id="icp-tag-editor">
        ${tags.map(t => `<span class="icp-tag-chip">${_escapeHtml(t)}<button data-tag="${_escapeAttr(t)}" title="Remover"><i class="ti ti-x"></i></button></span>`).join('')}
        <button class="icp-tag-add" id="icp-tag-add-btn"><i class="ti ti-plus" style="font-size:10px"></i> Etiqueta</button>
      </div>

      <div class="icp-section-title">Dados do contacto</div>
      <div style="padding:0 16px">
        <div class="icp-row"><span class="icp-label"><i class="ti ti-phone"></i> Número</span><span class="icp-val">${_escapeHtml(phone)}</span></div>
        <div class="icp-row"><span class="icp-label"><i class="ti ti-route"></i> Origem</span><span class="icp-val" style="font-weight:400;font-size:11px;color:var(--k-muted)">Conversa iniciada pelo cliente via WhatsApp</span></div>
        <div class="icp-row"><span class="icp-label"><i class="ti ti-calendar-plus"></i> Primeira conversa</span><span class="icp-val">${createdAt}</span></div>
        <div class="icp-row"><span class="icp-label"><i class="ti ti-clock"></i> Última actividade</span><span class="icp-val">${updatedAt}</span></div>
        <div class="icp-row"><span class="icp-label"><i class="ti ti-hourglass"></i> Cliente há</span><span class="icp-val">${customerSince}</span></div>
        <div class="icp-row"><span class="icp-label"><i class="ti ti-bell"></i> Não lidas</span><span class="icp-val">${unread}</span></div>
      </div>

      <div class="icp-section-title">Atendimento</div>
      <div style="padding:0 16px">
        <div class="icp-row"><span class="icp-label"><i class="ti ti-hierarchy"></i> Fluxo actual</span><span class="icp-val icp-val-mono">${_escapeHtml(flowId)}</span></div>
        <div class="icp-row"><span class="icp-label"><i class="ti ti-git-branch"></i> Último nó</span><span class="icp-val" style="color:var(--k-muted);font-weight:400">—</span></div>
        <div class="icp-row"><span class="icp-label"><i class="ti ti-robot"></i> IA activa?</span><span class="icp-val">${aiActive ? 'Sim' : 'Não — em atendimento humano'}</span></div>
        <div class="icp-row"><span class="icp-label"><i class="ti ti-headset"></i> Responsável</span><span class="icp-val" style="word-break:break-word">${_escapeHtml(assignedTo)}</span></div>
      </div>
    `;

    const addBtn = document.getElementById('icp-tag-add-btn');
    if (addBtn) addBtn.addEventListener('click', () => _showTagInput(addBtn, contact.phone));
    document.querySelectorAll('#icp-tag-editor button[data-tag]').forEach(btn => {
      btn.addEventListener('click', () => _removeTag(contact.phone, btn.dataset.tag));
    });
  }

  function _showTagInput(addBtn, phone) {
    const input = document.createElement('input');
    input.className = 'icp-tag-input';
    input.placeholder = 'Nova etiqueta';
    addBtn.replaceWith(input);
    input.focus();
    const commit = () => {
      const val = input.value.trim();
      if (val) _addTag(phone, val);
    };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') _renderICPInfo(_activeContact);
    });
    input.addEventListener('blur', () => _renderICPInfo(_activeContact));
  }

  async function _addTag(phone, tag) {
    const ref = _inboxDocRef(phone);
    if (!ref || typeof firebase === 'undefined') return;
    try {
      await ref.set({ tags: firebase.firestore.FieldValue.arrayUnion(tag), updatedAt: Date.now() }, { merge: true });
      _logEvent(phone, 'tag_added', `Etiqueta adicionada: ${tag}`);
    } catch (e) {
      _toast('Não foi possível adicionar a etiqueta.', 'error');
    }
  }

  async function _removeTag(phone, tag) {
    const ref = _inboxDocRef(phone);
    if (!ref || typeof firebase === 'undefined') return;
    try {
      await ref.set({ tags: firebase.firestore.FieldValue.arrayRemove(tag), updatedAt: Date.now() }, { merge: true });
      _logEvent(phone, 'tag_removed', `Etiqueta removida: ${tag}`);
    } catch (e) {
      _toast('Não foi possível remover a etiqueta.', 'error');
    }
  }

  // ── Timeline ─────────────────────────────────────────────────────────
  const _TL_ICON = {
    conversation_started: { icon: 'ti-message-circle', cls: '' },
    flow_started:         { icon: 'ti-player-play',    cls: '' },
    flow_finished:        { icon: 'ti-flag',            cls: 'green' },
    human_assumed:        { icon: 'ti-headset',          cls: 'amber' },
    ai_resumed:           { icon: 'ti-robot',            cls: '' },
    tag_added:             { icon: 'ti-tag',              cls: '' },
    tag_removed:           { icon: 'ti-tag-off',          cls: '' },
    archived:              { icon: 'ti-archive',          cls: '' },
    unarchived:            { icon: 'ti-archive-off',      cls: '' },
    resolved:              { icon: 'ti-circle-check',     cls: 'green' },
    reopened:              { icon: 'ti-refresh',          cls: 'pink' },
    attachment_received:   { icon: 'ti-paperclip',        cls: '' },
    note_added:            { icon: 'ti-notes',            cls: '' },
  };

  function _renderICPTimeline() {
    const pane = document.getElementById('icp-pane-timeline');
    if (!pane) return;
    if (!_events.length) {
      pane.innerHTML = `<div class="icp-timeline-empty"><i class="ti ti-timeline"></i>Sem eventos registados ainda.</div>`;
      return;
    }
    pane.innerHTML = `<div class="icp-timeline-list">${_events.map(ev => {
      const conf = _TL_ICON[ev.type] || { icon: 'ti-point', cls: '' };
      return `
        <div class="tl-item">
          <div class="tl-dot ${conf.cls}"><i class="ti ${conf.icon}"></i></div>
          <div class="tl-body">
            <div class="tl-label">${_escapeHtml(ev.label || ev.type)}</div>
            <div class="tl-time">${_formatFullDate(ev.timestamp)}</div>
          </div>
        </div>`;
    }).join('')}</div>`;
  }

  // ── Notas internas ──────────────────────────────────────────────────
  function _renderICPNotes(contact) {
    const pane = document.getElementById('icp-pane-notes');
    if (!pane) return;
    const notes = Array.isArray(contact.internalNotes) ? [...contact.internalNotes].reverse() : [];

    pane.innerHTML = `
      <div class="icp-notes-wrap">
        <div class="icp-notes-add">
          <textarea id="icp-note-input" placeholder="Escrever nota interna (nunca visível para o cliente)..."></textarea>
          <button class="btn btn-sm btn-primary" id="icp-note-save"><i class="ti ti-plus"></i> Adicionar nota</button>
        </div>
        <div id="icp-notes-list">
          ${notes.length ? notes.map(n => `
            <div class="icp-note-item" data-nid="${_escapeAttr(n.id)}">
              <div class="icp-note-meta">
                <span class="icp-note-time">${_formatFullDate(n.createdAt)}</span>
                <button class="icp-note-del" title="Apagar nota"><i class="ti ti-trash"></i></button>
              </div>
              ${_escapeHtml(n.text)}
            </div>`).join('') : `<div class="icp-notes-empty"><i class="ti ti-notes"></i>Sem notas internas ainda.</div>`}
        </div>
      </div>`;

    const saveBtn = document.getElementById('icp-note-save');
    if (saveBtn) saveBtn.addEventListener('click', () => _addNote(contact.phone));
    pane.querySelectorAll('.icp-note-del').forEach(btn => {
      btn.addEventListener('click', () => _deleteNote(contact.phone, btn.closest('.icp-note-item').dataset.nid));
    });
  }

  async function _addNote(phone) {
    const input = document.getElementById('icp-note-input');
    const text = (input?.value || '').trim();
    if (!text) return;
    const ref = _inboxDocRef(phone);
    if (!ref) return;
    const note = { id: `n_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, text, createdAt: Date.now() };
    try {
      const snap = await ref.get();
      const current = Array.isArray(snap.data()?.internalNotes) ? snap.data().internalNotes : [];
      await ref.set({ internalNotes: [...current, note], updatedAt: Date.now() }, { merge: true });
      _logEvent(phone, 'note_added', 'Nota interna adicionada');
      _toast('Nota adicionada.');
    } catch (e) {
      _toast('Não foi possível adicionar a nota.', 'error');
    }
  }

  async function _deleteNote(phone, noteId) {
    const ref = _inboxDocRef(phone);
    if (!ref) return;
    try {
      const snap = await ref.get();
      const current = Array.isArray(snap.data()?.internalNotes) ? snap.data().internalNotes : [];
      await ref.set({ internalNotes: current.filter(n => n.id !== noteId), updatedAt: Date.now() }, { merge: true });
    } catch (e) {
      _toast('Não foi possível apagar a nota.', 'error');
    }
  }

  // ── Ficheiros enviados ──────────────────────────────────────────────
  function _renderICPFiles() {
    const pane = document.getElementById('icp-pane-files');
    if (!pane) return;
    const images = _messages.filter(m => m.type === 'image' && !m.deleted);
    const videos = _messages.filter(m => m.type === 'video' && !m.deleted);
    const docs   = _messages.filter(m => m.type === 'document' && !m.deleted);

    if (!images.length && !videos.length && !docs.length) {
      pane.innerHTML = `<div class="icp-files-empty"><i class="ti ti-paperclip"></i>Nenhum ficheiro enviado nesta conversa.</div>`;
      return;
    }

    let html = '<div class="icp-files-wrap">';
    if (images.length) {
      html += `<div class="icp-files-group"><div class="icp-files-group-title">Imagens (${images.length})</div><div class="icp-files-grid">`;
      html += images.map(m => m.mediaUrl
        ? `<a class="icp-file-thumb" href="${_escapeAttr(m.mediaUrl)}" target="_blank"><img src="${_escapeAttr(m.mediaUrl)}"></a>`
        : `<div class="icp-file-thumb"><i class="ti ti-photo"></i></div>`).join('');
      html += '</div></div>';
    }
    if (videos.length) {
      html += `<div class="icp-files-group"><div class="icp-files-group-title">Vídeos (${videos.length})</div><div class="icp-files-grid">`;
      html += videos.map(m => m.mediaUrl
        ? `<a class="icp-file-thumb" href="${_escapeAttr(m.mediaUrl)}" target="_blank"><video src="${_escapeAttr(m.mediaUrl)}"></video></a>`
        : `<div class="icp-file-thumb"><i class="ti ti-video"></i></div>`).join('');
      html += '</div></div>';
    }
    if (docs.length) {
      html += `<div class="icp-files-group"><div class="icp-files-group-title">Documentos (${docs.length})</div>`;
      html += docs.map(m => m.mediaUrl
        ? `<div class="icp-doc-row"><i class="ti ti-file"></i><a href="${_escapeAttr(m.mediaUrl)}" target="_blank">${_escapeHtml(m.text || 'Documento')}</a></div>`
        : `<div class="icp-doc-row"><i class="ti ti-file"></i><span>${_escapeHtml(m.text || 'Documento recebido')}</span></div>`).join('');
      html += '</div>';
    }
    html += '</div>';
    pane.innerHTML = html;
  }

  // ══════════════════════════════════════════════════════════════════════
  // Toast
  // ══════════════════════════════════════════════════════════════════════
  function _toast(msg, type) {
    let wrap = document.getElementById('inbox-toast-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'inbox-toast-wrap';
      document.body.appendChild(wrap);
    }
    const el = document.createElement('div');
    el.className = 'inbox-toast' + (type === 'error' ? ' error' : '');
    el.innerHTML = `<i class="ti ${type === 'error' ? 'ti-alert-circle' : 'ti-circle-check'}"></i><span>${_escapeHtml(msg)}</span>`;
    wrap.appendChild(el);
    setTimeout(() => el.remove(), 3800);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Helpers
  // ══════════════════════════════════════════════════════════════════════
  const _AVATAR_COLORS = ['#60a5fa', '#a78bfa', '#34d399', '#fbbf24', '#f472b6', '#fb923c', '#22d3ee'];
  function _colorFor(seed) {
    const s = String(seed || '');
    let hash = 0;
    for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
    return _AVATAR_COLORS[hash % _AVATAR_COLORS.length];
  }

  function _formatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return d.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit' });
  }

  function _formatFullDate(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return d.toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
      ' · ' + d.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
  }

  function _formatDuration(ms) {
    if (!ms || ms < 0) return '—';
    const days = Math.floor(ms / 86400000);
    if (days >= 365) return `${Math.floor(days / 365)} ano(s)`;
    if (days >= 30)  return `${Math.floor(days / 30)} mês(es)`;
    if (days >= 1)   return `${days} dia(s)`;
    const hours = Math.floor(ms / 3600000);
    if (hours >= 1) return `${hours} hora(s)`;
    return 'Menos de 1 hora';
  }

  function _truncate(str, max) {
    const s = String(str || '');
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  function _escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  function _escapeAttr(str) {
    return _escapeHtml(str);
  }

  return { init, destroy, render, openConversation };
})();
