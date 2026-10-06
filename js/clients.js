/* ══════════════════════════════════════════════════════════════════════
   FASE 6.0 — Clientes (vista do utilizador normal)
   ────────────────────────────────────────────────────────────────────
   Lê a subcoleção workspaces/{uid}/inbox/{phone} em tempo real e
   apresenta a lista de contactos que já interagiram com o bot.

   Dados lidos por contacto (campos já gravados pelo server/engine/inbox.js):
     • phone          — número WhatsApp (chave do documento)
     • displayName    — nome calculado: savedName → pushName → phone
     • savedName      — nome definido manualmente pelo utilizador
     • pushName       — nome do perfil WhatsApp do contacto
     • lastMessage    — prévia da última mensagem
     • lastMessageAt  — timestamp da última mensagem
     • unreadCount    — mensagens não lidas
     • status         — 'bot' | 'human' | 'done' | 'finished'
     • activeFlowId   — fluxo ativo neste contacto
     • isGroup        — true se for grupo WhatsApp

   Funcionalidades:
     • Lista em tempo real com onSnapshot
     • Pesquisa por nome ou número
     • Filtro por estado (todos / bot / humano / concluído)
     • Ordenação por última mensagem (mais recente primeiro)
     • Modal de detalhe com opção de editar o nome guardado
     • Contador de total de contactos
   ══════════════════════════════════════════════════════════════════════ */

const ClientsView = (() => {

  let _uid             = null;
  let _unsubscribe     = null;   // listener onSnapshot
  let _contacts        = [];     // todos os contactos (snapshot mais recente)
  let _searchTerm      = '';
  let _filterStatus    = 'all';  // 'all' | 'bot' | 'human' | 'done'

  // ── helpers ────────────────────────────────────────────────────────

  function _escHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function _formatDate(ts) {
    if (!ts) return '—';
    const d = new Date(typeof ts === 'object' && ts.toMillis ? ts.toMillis() : ts);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000)        return 'agora';
    if (diff < 3600000)      return `${Math.floor(diff / 60000)}m`;
    if (diff < 86400000)     return `${Math.floor(diff / 3600000)}h`;
    if (diff < 604800000)    return d.toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit' });
    return d.toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit', year: '2-digit' });
  }

  function _statusInfo(status) {
    switch (status) {
      case 'human':    return { label: 'Humano',    cls: 'cl-status-human',  icon: 'ti-user' };
      case 'done':
      case 'finished': return { label: 'Concluído', cls: 'cl-status-done',   icon: 'ti-circle-check' };
      default:         return { label: 'Bot',       cls: 'cl-status-bot',    icon: 'ti-robot' };
    }
  }

  function _initials(name) {
    const parts = (name || '').trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return (name || '?')[0].toUpperCase();
  }

  function _avatarColor(phone) {
    const colors = ['#0078f0','#00c8f0','#22c55e','#f59e0b','#a855f7','#ef4444','#06b6d4'];
    let h = 0;
    for (let i = 0; i < phone.length; i++) h = (h * 31 + phone.charCodeAt(i)) & 0xffff;
    return colors[h % colors.length];
  }

  // ── Firestore ───────────────────────────────────────────────────────

  function _inboxCol() {
    const db = FirebaseCore.getDb();
    return db.collection('workspaces').doc(_uid).collection('inbox');
  }

  function _startListener() {
    _stopListener();
    const col = _inboxCol();
    _unsubscribe = col.orderBy('lastMessageAt', 'desc').onSnapshot(
      snap => {
        _contacts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        _renderList();
        _updateCounter();
      },
      err => {
        console.error('[ClientsView] onSnapshot erro:', err);
        _showError('Erro ao carregar contactos: ' + err.message);
      }
    );
  }

  function _stopListener() {
    if (_unsubscribe) { _unsubscribe(); _unsubscribe = null; }
  }

  // ── render ─────────────────────────────────────────────────────────

  function _filtered() {
    let list = _contacts;

    if (_searchTerm) {
      const q = _searchTerm.toLowerCase();
      list = list.filter(c =>
        (c.displayName || c.phone || '').toLowerCase().includes(q) ||
        (c.phone || '').includes(q) ||
        (c.savedName || '').toLowerCase().includes(q) ||
        (c.pushName  || '').toLowerCase().includes(q)
      );
    }

    if (_filterStatus !== 'all') {
      if (_filterStatus === 'done') {
        list = list.filter(c => c.status === 'done' || c.status === 'finished');
      } else {
        list = list.filter(c => c.status === _filterStatus);
      }
    }

    return list;
  }

  function _updateCounter() {
    const el = document.getElementById('cl-total-count');
    if (el) el.textContent = _contacts.length;
  }

  function _renderList() {
    const listEl = document.getElementById('cl-list');
    if (!listEl) return;

    const list = _filtered();

    if (!_contacts.length) {
      listEl.innerHTML = `
        <div class="cl-empty">
          <i class="ti ti-users" style="font-size:36px;color:var(--k-muted);opacity:.3"></i>
          <p>Nenhum contacto ainda.</p>
          <p style="font-size:11px;color:var(--k-muted)">Os contactos aparecem aqui assim que alguém enviar uma mensagem ao teu bot.</p>
        </div>`;
      return;
    }

    if (!list.length) {
      listEl.innerHTML = `
        <div class="cl-empty">
          <i class="ti ti-search" style="font-size:32px;color:var(--k-muted);opacity:.3"></i>
          <p>Nenhum contacto encontrado.</p>
        </div>`;
      return;
    }

    listEl.innerHTML = list.map(c => {
      const name   = c.displayName || c.phone || '?';
      const st     = _statusInfo(c.status);
      const color  = _avatarColor(c.phone || c.id);
      const unread = (c.unreadCount || 0) > 0
        ? `<span class="cl-unread">${c.unreadCount > 99 ? '99+' : c.unreadCount}</span>`
        : '';
      const groupBadge = c.isGroup
        ? `<span class="cl-group-badge"><i class="ti ti-users-group" style="font-size:9px"></i> Grupo</span>`
        : '';

      return `
        <div class="cl-item" data-phone="${_escHtml(c.phone || c.id)}" onclick="ClientsView.openDetail('${_escHtml(c.phone || c.id)}')">
          <div class="cl-avatar" style="background:${color}">${_escHtml(_initials(name))}</div>
          <div class="cl-info">
            <div class="cl-name-row">
              <span class="cl-name">${_escHtml(name)}</span>
              ${groupBadge}
              <span class="cl-time">${_formatDate(c.lastMessageAt)}</span>
            </div>
            <div class="cl-preview-row">
              <span class="cl-preview">${_escHtml(c.lastMessage || '—')}</span>
              <span class="cl-status-pill ${st.cls}"><i class="ti ${st.icon}" style="font-size:9px"></i>${_escHtml(st.label)}</span>
              ${unread}
            </div>
            ${c.activeFlowId ? `<div class="cl-flow-row"><i class="ti ti-hierarchy" style="font-size:10px;color:var(--k-muted)"></i><span class="cl-flow-label">${_escHtml(c.activeFlowId)}</span></div>` : ''}
          </div>
        </div>`;
    }).join('');
  }

  function _showError(msg) {
    const listEl = document.getElementById('cl-list');
    if (listEl) listEl.innerHTML = `<div class="cl-empty"><p style="color:#ef4444">${_escHtml(msg)}</p></div>`;
  }

  // ── modal de detalhe ────────────────────────────────────────────────

  function openDetail(phone) {
    const c = _contacts.find(x => (x.phone || x.id) === phone);
    if (!c) return;

    const name   = c.displayName || c.phone || '?';
    const st     = _statusInfo(c.status);
    const color  = _avatarColor(c.phone || c.id);
    const date   = c.lastMessageAt
      ? new Date(typeof c.lastMessageAt === 'object' && c.lastMessageAt.toMillis
          ? c.lastMessageAt.toMillis() : c.lastMessageAt
        ).toLocaleString('pt-PT')
      : '—';

    const modal = document.getElementById('cl-modal');
    document.getElementById('cl-modal-avatar').textContent = _initials(name);
    document.getElementById('cl-modal-avatar').style.background = color;
    document.getElementById('cl-modal-name').textContent  = name;
    document.getElementById('cl-modal-phone').textContent = c.phone || c.id;
    document.getElementById('cl-modal-status').textContent = st.label;
    document.getElementById('cl-modal-status').className  = 'cl-modal-status-val ' + st.cls;
    document.getElementById('cl-modal-last').textContent  = date;
    document.getElementById('cl-modal-flow').textContent  = c.activeFlowId || '—';
    document.getElementById('cl-modal-msgs').textContent  = c.lastMessage || '—';
    document.getElementById('cl-modal-pushname').textContent = c.pushName || '—';
    document.getElementById('cl-modal-savedname').value   = c.savedName || '';
    document.getElementById('cl-modal-savedname').dataset.phone = phone;
    document.getElementById('cl-modal-save-msg').textContent = '';

    // guardar phone activo para as acções rápidas
    modal.dataset.activePhone = phone;

    // limpar msg de acção anterior
    const actMsg = document.getElementById('cl-act-msg');
    if (actMsg) actMsg.textContent = '';

    modal.style.display = 'flex';
  }

  function closeDetail() {
    document.getElementById('cl-modal').style.display = 'none';
  }

  async function saveContactName() {
    const input   = document.getElementById('cl-modal-savedname');
    const phone   = input.dataset.phone;
    const newName = input.value.trim();
    const msgEl   = document.getElementById('cl-modal-save-msg');

    if (!phone || !_uid) return;

    msgEl.textContent = 'A guardar…';
    msgEl.style.color = 'var(--k-muted)';

    try {
      const BACKEND_URL = window._KORVEX_BACKEND_URL || 'http://localhost:3001';
      const res = await fetch(`${BACKEND_URL}/inbox/${_uid}/${encodeURIComponent(phone)}/name`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ uid: _uid, savedName: newName || null }),
      });
      const data = await res.json();
      if (data.ok) {
        msgEl.textContent = 'Nome guardado!';
        msgEl.style.color = 'var(--k-green)';
        setTimeout(() => { msgEl.textContent = ''; }, 2000);
      } else {
        throw new Error(data.error || 'Erro desconhecido');
      }
    } catch (e) {
      msgEl.textContent = 'Erro: ' + e.message;
      msgEl.style.color = '#ef4444';
    }
  }

  // ── acções rápidas do modal ─────────────────────────────────────────

  function _activePhone() {
    return document.getElementById('cl-modal')?.dataset?.activePhone || null;
  }

  function _actMsg(text, color) {
    const el = document.getElementById('cl-act-msg');
    if (!el) return;
    el.textContent  = text;
    el.style.color  = color || 'var(--k-muted)';
  }

  async function _updateStatus(phone, newStatus) {
    if (!phone || !_uid) return false;
    try {
      const db  = FirebaseCore.getDb();
      const ref = db.collection('workspaces').doc(_uid).collection('inbox').doc(
        String(phone).replace(/\//g, '_')
      );
      await ref.set({ status: newStatus, updatedAt: Date.now() }, { merge: true });
      // actualizar badge do estado no modal imediatamente
      const st  = _statusInfo(newStatus);
      const stEl = document.getElementById('cl-modal-status');
      if (stEl) { stEl.textContent = st.label; stEl.className = 'cl-modal-status-val ' + st.cls; }
      return true;
    } catch (e) {
      console.error('[ClientsView] _updateStatus:', e);
      return false;
    }
  }

  // Abre a conversa na tab Inbox
  function openInInbox() {
    const phone = _activePhone();
    if (!phone) return;
    closeDetail();
    // navegar para inbox e seleccionar a conversa
    const navInbox = document.querySelector('.nav-item[onclick*="inbox"]');
    if (typeof setView === 'function') setView('inbox', navInbox);
    // InboxView.openConversation se existir
    setTimeout(() => {
      if (typeof InboxView !== 'undefined' && typeof InboxView.openConversation === 'function') {
        InboxView.openConversation(phone);
      }
    }, 100);
  }

  // Transfere para atendimento humano
  async function transferToHuman() {
    const phone = _activePhone();
    if (!phone) return;
    _actMsg('A transferir…', 'var(--k-muted)');
    const ok = await _updateStatus(phone, 'human');
    if (ok) _actMsg('Transferido para humano.', 'var(--k-green)');
    else    _actMsg('Erro ao transferir.', '#ef4444');
    setTimeout(() => _actMsg(''), 2500);
  }

  // Marca como concluído
  async function markDone() {
    const phone = _activePhone();
    if (!phone) return;
    _actMsg('A marcar…', 'var(--k-muted)');
    const ok = await _updateStatus(phone, 'done');
    if (ok) _actMsg('Conversa concluída.', 'var(--k-green)');
    else    _actMsg('Erro ao marcar.', '#ef4444');
    setTimeout(() => _actMsg(''), 2500);
  }

  // Devolve ao bot
  async function returnToBot() {
    const phone = _activePhone();
    if (!phone) return;
    _actMsg('A devolver ao bot…', 'var(--k-muted)');
    const ok = await _updateStatus(phone, 'bot');
    if (ok) _actMsg('Devolvido ao bot.', 'var(--k-green)');
    else    _actMsg('Erro.', '#ef4444');
    setTimeout(() => _actMsg(''), 2500);
  }

  // ── init / render público ───────────────────────────────────────────

  function render() {
    const u = typeof AuthService !== 'undefined' ? AuthService.currentUser() : null;
    _uid = u ? u.uid : null;

    if (!_uid) {
      _showError('Utilizador não autenticado.');
      return;
    }

    // Ligar pesquisa
    const searchEl = document.getElementById('cl-search');
    if (searchEl) {
      searchEl.oninput = e => {
        _searchTerm = e.target.value;
        _renderList();
      };
    }

    // Ligar filtros
    document.querySelectorAll('.cl-filter-btn').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.cl-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _filterStatus = btn.dataset.filter;
        _renderList();
      };
    });

    // Fechar modal ao clicar fora
    const modal = document.getElementById('cl-modal');
    if (modal) modal.onclick = e => { if (e.target === modal) closeDetail(); };

    _startListener();
  }

  function destroy() {
    _stopListener();
    _contacts = [];
  }

  return { render, destroy, openDetail, closeDetail, saveContactName,
           openInInbox, transferToHuman, markDone, returnToBot };
})();
