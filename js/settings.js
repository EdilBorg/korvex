/* ══════════════════════════════════════════════════════════════════════
   Configurações — Vista de definições do workspace
   ────────────────────────────────────────────────────────────────────
   Lê e grava em Firestore (dados reais, sem valores fictícios):
     workspaces/{uid}/settings/workspace → {
       workspaceName, botName, timezone, language, updatedAt
     }

   Funcionalidades:
     • Nome do workspace
     • Nome do bot (aparece na Inbox)
     • Fuso horário
     • Idioma do bot
     • Informação de conta (email, UID, plano)
     • Botão para alterar password (envia email de reset)
   ══════════════════════════════════════════════════════════════════════ */

const SettingsView = (() => {

  let _uid  = null;
  let _user = null;

  // ── Firestore refs ───────────────────────────────────────────────────

  function _settingsRef() {
    return FirebaseCore.getDb()
      .collection('workspaces').doc(_uid)
      .collection('settings').doc('workspace');
  }

  // ── carregar e preencher form ────────────────────────────────────────

  async function _load() {
    const msgEl = document.getElementById('st-save-msg');
    try {
      const snap = await _settingsRef().get();
      const data = snap.exists ? snap.data() : {};

      _setVal('st-workspace-name', data.workspaceName || '');
      _setVal('st-bot-name',       data.botName       || '');
      _setVal('st-timezone',       data.timezone      || 'Africa/Maputo');
      _setVal('st-language',       data.language      || 'pt');
    } catch (e) {
      console.error('[SettingsView] _load:', e);
      if (msgEl) { msgEl.textContent = 'Erro ao carregar: ' + e.message; msgEl.style.color = '#ef4444'; }
    }
  }

  // ── Verifica se a conta é admin (acesso total, sem restrições) ──────
  function _isAdmin() {
    // 1. Via SubscriptionService (fonte de verdade principal)
    if (typeof SubscriptionService !== 'undefined') {
      const status = SubscriptionService.getStatus();
      if (status === 'admin') return true;
      const sub = SubscriptionService.getCached();
      if (sub?.plan === 'admin') return true;
    }
    // 2. Fallback: canAccess() já cobre super_admin por email/uid
    if (typeof SubscriptionService !== 'undefined' && SubscriptionService.canAccess) {
      // canAccess retorna true para admin mesmo sem plano no Firestore
      const sub = SubscriptionService.getCached();
      if (sub?.plan === 'trial' || !sub) {
        // Pode ser admin sem plano correcto no Firestore — verificar pelo status
        const status = SubscriptionService.getStatus();
        if (status === 'admin') return true;
      }
    }
    return false;
  }

  // ── Modal de upgrade (aparece quando Trial tenta activar IA) ─────────
  function _showUpgradeModal() {
    let overlay = document.getElementById('st-upgrade-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'st-upgrade-overlay';
      overlay.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:10100',
        'background:rgba(0,0,0,0.70)', 'backdrop-filter:blur(4px)',
        'display:flex', 'align-items:center', 'justify-content:center',
        'opacity:0', 'pointer-events:none',
        'transition:opacity .2s',
      ].join(';');
      overlay.innerHTML = `
        <div id="st-upgrade-box" style="
          background: #111827;
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 16px;
          width: 100%;
          max-width: 400px;
          margin: 16px;
          padding: 28px 28px 24px;
          position: relative;
          box-shadow: 0 24px 64px rgba(0,0,0,0.6);
          transform: scale(0.95);
          transition: transform .2s;
        ">
          <!-- Botão fechar -->
          <button onclick="document.getElementById('st-upgrade-overlay')._close()" style="
            position:absolute; top:14px; right:14px;
            background:rgba(255,255,255,0.06); border:none; border-radius:6px;
            width:28px; height:28px; cursor:pointer; display:flex;
            align-items:center; justify-content:center; color:var(--k-muted,#94a3b8);
            transition:background .15s;
          " onmouseover="this.style.background='rgba(255,255,255,0.12)'"
             onmouseout="this.style.background='rgba(255,255,255,0.06)'">
            <i class="ti ti-x" style="font-size:14px"></i>
          </button>

          <!-- Logo Korvex -->
          <div style="margin-bottom:18px;">
            <img src="data:image/png;base64,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" alt="Korvex" style="height:40px;width:auto;display:block;">
          </div>

          <!-- Título -->
          <div style="font-size:18px;font-weight:700;color:var(--k-text,#e2e8f0);margin-bottom:8px;">
            Funcionalidade Pro
          </div>

          <!-- Descrição -->
          <div style="font-size:13px;color:var(--k-muted,#94a3b8);line-height:1.6;margin-bottom:22px;">
            O assistente de IA não está disponível no plano <strong style="color:var(--k-text,#e2e8f0)">Trial</strong>.
            Faz upgrade para o plano <strong style="color:var(--k-text,#e2e8f0)">Korvex Pro</strong> e activa respostas
            automáticas inteligentes para os teus clientes.
          </div>

          <!-- Botão upgrade -->
          <button onclick="document.getElementById('st-upgrade-overlay')._close(); RenewPanel.open();" style="
            width:100%; padding:12px; border:none; border-radius:10px; cursor:pointer;
            background: linear-gradient(135deg,#0078f0,#0056c7);
            color:#fff; font-size:14px; font-weight:600; letter-spacing:0.3px;
            display:flex; align-items:center; justify-content:center; gap:8px;
            transition: opacity .15s; margin-bottom:10px;
          " onmouseover="this.style.opacity='0.88'" onmouseout="this.style.opacity='1'">
            <i class="ti ti-crown" style="font-size:15px"></i>
            Actualizar Plano
          </button>

          <!-- Botão cancelar -->
          <button onclick="document.getElementById('st-upgrade-overlay')._close()" style="
            width:100%; padding:10px; border:1px solid rgba(255,255,255,0.08);
            border-radius:10px; cursor:pointer; background:transparent;
            color:var(--k-muted,#94a3b8); font-size:13px;
            transition:background .15s;
          " onmouseover="this.style.background='rgba(255,255,255,0.04)'"
             onmouseout="this.style.background='transparent'">
            Agora não
          </button>
        </div>
      `;

      // Fechar ao clicar fora da caixa
      overlay._close = function() {
        overlay.style.opacity = '0';
        overlay.style.pointerEvents = 'none';
        document.getElementById('st-upgrade-box').style.transform = 'scale(0.95)';
      };
      overlay.addEventListener('click', function(e) {
        if (e.target === overlay) overlay._close();
      });

      document.body.appendChild(overlay);
    }

    // Abrir com animação
    overlay.style.opacity = '1';
    overlay.style.pointerEvents = 'all';
    requestAnimationFrame(() => {
      document.getElementById('st-upgrade-box').style.transform = 'scale(1)';
    });
  }

  async function _loadAi() {
    try {


  function _setVal(id, val) {
    const el = document.getElementById(id);
    if (el) el.value = val;
  }

  // ── guardar workspace ────────────────────────────────────────────────

  async function save() {
    const msgEl = document.getElementById('st-save-msg');
    if (msgEl) { msgEl.textContent = 'A guardar…'; msgEl.style.color = 'var(--k-muted)'; }

    const workspaceName = (document.getElementById('st-workspace-name')?.value || '').trim();
    const botName       = (document.getElementById('st-bot-name')?.value || '').trim();
    const timezone      = document.getElementById('st-timezone')?.value || 'Africa/Maputo';
    const language      = document.getElementById('st-language')?.value || 'pt';

    try {
      await _settingsRef().set({
        workspaceName: workspaceName || null,
        botName:       botName       || null,
        timezone,
        language,
        updatedAt: Date.now(),
      }, { merge: true });

      if (msgEl) { msgEl.textContent = 'Definições guardadas!'; msgEl.style.color = 'var(--k-green)'; }
      setTimeout(() => { if (msgEl) msgEl.textContent = ''; }, 2500);
    } catch (e) {
      console.error('[SettingsView] save:', e);
      if (msgEl) { msgEl.textContent = 'Erro: ' + e.message; msgEl.style.color = '#ef4444'; }
    }
  }

  // ── guardar IA ───────────────────────────────────────────────────────

  // ── reset password ───────────────────────────────────────────────────

  async function sendResetPassword() {
    const btnEl = document.getElementById('st-reset-pw-btn');
    const msgEl = document.getElementById('st-reset-pw-msg');
    if (!_user?.email) return;

    if (btnEl) btnEl.disabled = true;
    if (msgEl) { msgEl.textContent = 'A enviar…'; msgEl.style.color = 'var(--k-muted)'; }

    try {
      const auth = FirebaseCore.getAuth();
      await auth.sendPasswordResetEmail(_user.email);
      if (msgEl) { msgEl.textContent = `Email enviado para ${_user.email}`; msgEl.style.color = 'var(--k-green)'; }
    } catch (e) {
      console.error('[SettingsView] sendResetPassword:', e);
      if (msgEl) { msgEl.textContent = 'Erro: ' + e.message; msgEl.style.color = '#ef4444'; }
      if (btnEl) btnEl.disabled = false;
    }
  }

  // ── preencher info de conta ──────────────────────────────────────────

  function _fillAccountInfo() {
    const emailEl = document.getElementById('st-acct-email');
    const uidEl   = document.getElementById('st-acct-uid');
    const planEl  = document.getElementById('st-acct-plan');

    if (emailEl) emailEl.textContent = _user?.email || '—';
    if (uidEl)   uidEl.textContent   = _uid         || '—';

    // plano — lido do SubscriptionService se disponível
    if (planEl) {
      const sub = typeof SubscriptionService !== 'undefined' ? SubscriptionService.getCached() : null;
      const labels = { trial:'Trial', premium:'Activo', suspended:'Suspenso', suspended:'Suspenso', admin:'Administrador' };
      planEl.textContent = sub ? (labels[sub.plan] || sub.plan) : '—';
    }
  }

  // ── público ──────────────────────────────────────────────────────────

  function render() {
    const u = typeof AuthService !== 'undefined' ? AuthService.currentUser() : null;
    _user = u;
    _uid  = u ? u.uid : null;
    if (!_uid) return;

    _fillAccountInfo();
    _load();
    _loadAi();

    // ligar Enter nos inputs para guardar
    ['st-workspace-name','st-bot-name'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.onkeydown = e => { if (e.key === 'Enter') save(); };
    });

    // O toggle chama SettingsView.saveAi() via onchange no HTML.
    // saveAi() já trata o modal de upgrade e a actualização da UI.
  }

  return { render, save, sendResetPassword };
})();

/* ══════════════════════════════════════════════════════════════════════
   CreditsView — Painel de créditos IA
   ────────────────────────────────────────────────────────────────────
   Consome GET /accounts/:uid/credits/status e renderiza o estado
   actual dos créditos IA no painel de definições.
   ══════════════════════════════════════════════════════════════════════ */

const CreditsView = (() => {
  const BACKEND_URL = window._KORVEX_BACKEND_URL || 'http://localhost:3001';

  let _uid = null;
  let _refreshTimer = null;

  // ── carregar dados do backend ────────────────────────────────────────

  async function _load() {
    if (!_uid) return;

    const rootEl = document.getElementById('credits-root');
    if (!rootEl) return;

    try {
      const res  = await fetch(`${BACKEND_URL}/accounts/${_uid}/credits/status`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Erro desconhecido');
      _render(data);
    } catch (e) {
      console.error('[CreditsView] Erro ao carregar créditos:', e.message);
      const rootEl = document.getElementById('credits-root');
      if (rootEl) rootEl.innerHTML = `<p style="color:#ef4444;font-size:12px">Erro ao carregar créditos: ${e.message}</p>`;
    }
  }

  // ── renderizar painel ────────────────────────────────────────────────

  function _render(d) {
    const rootEl = document.getElementById('credits-root');
    if (!rootEl) return;

    const monthPct  = Math.min(d.monthly_percent  || 0, 100);
    const dayPct    = Math.min(d.daily_percent    || 0, 100);
    const warnLevel = d.warning_level || 'none';

    const barColor = warnLevel === 'blocked' ? '#ef4444'
                   : warnLevel === 'warning' ? '#f59e0b'
                   : 'var(--k-accent, #0078f0)';

    const warnHtml = warnLevel === 'blocked'
      ? `<div class="credits-alert danger"><i class="ti ti-ban"></i> Limite mensal atingido. A IA está temporariamente desactivada até à renovação.</div>`
      : warnLevel === 'warning'
      ? `<div class="credits-alert warn"><i class="ti ti-alert-triangle"></i> Utilizaste ${monthPct}% da cota mensal de IA.</div>`
      : '';

    const costMT = ((d.estimated_cost_usd || 0) * 80).toFixed(2); // conversão aproximada USD → MT

    rootEl.innerHTML = `
      ${warnHtml}
      <div class="credits-grid">

        <div class="credits-card">
          <div class="credits-card-label"><i class="ti ti-calendar-month" style="font-size:11px"></i> Cota Mensal</div>
          <div class="credits-card-values">
            <span class="credits-used">${(d.monthly_used || 0).toLocaleString()}</span>
            <span class="credits-sep">/</span>
            <span class="credits-total">${(d.monthly_limit || 0).toLocaleString()}</span>
          </div>
          <div class="credits-bar-wrap">
            <div class="credits-bar-fill" style="width:${monthPct}%;background:${barColor}"></div>
          </div>
          <div class="credits-bar-pct">${monthPct}% utilizado</div>
        </div>

        <div class="credits-card">
          <div class="credits-card-label"><i class="ti ti-calendar-day" style="font-size:11px"></i> Cota Diária</div>
          <div class="credits-card-values">
            <span class="credits-used">${(d.daily_used || 0).toLocaleString()}</span>
            <span class="credits-sep">/</span>
            <span class="credits-total">${(d.daily_limit || 0).toLocaleString()}</span>
          </div>
          <div class="credits-bar-wrap">
            <div class="credits-bar-fill" style="width:${dayPct}%;background:var(--k-accent2, #00c8f0)"></div>
          </div>
          <div class="credits-bar-pct">${dayPct}% utilizado hoje</div>
        </div>

        <div class="credits-card">
          <div class="credits-card-label"><i class="ti ti-currency-dollar" style="font-size:11px"></i> Custo Estimado</div>
          <div class="credits-card-values">
            <span class="credits-used">$${(d.estimated_cost_usd || 0).toFixed(4)}</span>
          </div>
          <div class="credits-bar-pct">≈ ${costMT} MT este mês</div>
        </div>

        <div class="credits-card">
          <div class="credits-card-label"><i class="ti ti-refresh" style="font-size:11px"></i> Renovação</div>
          <div class="credits-card-values">
            <span class="credits-used" style="font-size:13px">${_fmtReset(d.last_monthly_reset)}</span>
          </div>
          <div class="credits-bar-pct">Renova automaticamente a cada 30 dias</div>
        </div>

      </div>
      <div style="text-align:right;margin-top:6px">
        <button class="btn btn-sm" onclick="CreditsView.refresh()" style="font-size:11px">
          <i class="ti ti-refresh"></i> Actualizar
        </button>
      </div>
    `;
  }

  function _fmtReset(ts) {
    if (!ts) return '—';
    const d    = new Date(ts);
    const next = new Date(ts + 30 * 24 * 60 * 60 * 1000);
    return next.toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  // ── público ──────────────────────────────────────────────────────────

  function render() {
    const u = typeof AuthService !== 'undefined' ? AuthService.currentUser() : null;
    _uid = u ? u.uid : null;
    if (!_uid) return;
    _load();
    // Actualizar automaticamente a cada 60 segundos enquanto o painel está aberto
    if (_refreshTimer) clearInterval(_refreshTimer);
    _refreshTimer = setInterval(_load, 60000);
  }

  function refresh() { _load(); }

  function destroy() {
    if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
    _uid = null;
  }

  return { render, refresh, destroy };
})();
