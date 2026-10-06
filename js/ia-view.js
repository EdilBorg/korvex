/* ══════════════════════════════════════════════════════════════════════════════════════
   IA VIEW — Redesign Completo
   
   Layout: 4 cartões em ordem fixa
   1. Status da IA
   2. Tokens
   3. Conhecimento da IA
   4. Histórico de Recargas
   ════════════════════════════════════════════════════════════════════════════════════ */

const IAView = (() => {
  let _uid = null;
  let _loading = false;

  function _fmt(n) {
    if (n === null || n === undefined) return '0';
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace('.0', '') + 'M';
    return Number(n).toLocaleString('pt-PT');
  }

  function _fmtDate(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleDateString('pt-PT');
  }

  function _fmtMethod(method) {
    return method === 'mpesa' ? 'M-Pesa' : method === 'emola' ? 'E-Mola' : method === 'paysuite' ? 'PaySuite' : method;
  }

  function _fmtStatusText(status) {
    const texts = {
      'approved': 'Confirmado',
      'pending': 'Pendente',
      'failed': 'Falhou',
    };
    return texts[status] || status;
  }

  async function init(uid) {
    _uid = uid;
    console.log('[IAView] Inicializando para UID:', uid);
    
    try {
      if (typeof IAModule === 'undefined') {
        console.error('[IAView] IAModule não está definido!');
        _renderError('Erro: Módulo IA não carregado');
        return;
      }

      await IAModule.init(uid);
      console.log('[IAView] IAModule inicializado');
      await render();
    } catch (e) {
      console.error('[IAView] Erro ao inicializar:', e);
      _renderError(e.message || 'Erro ao carregar a página');
    }
  }

  function _renderError(msg) {
    const viewEl = document.getElementById('view-ia');
    if (viewEl) {
      viewEl.innerHTML = `<div style="padding:32px;text-align:center;color:#ef4444">
        <div style="margin-bottom:12px"><i class="ti ti-alert-circle" style="font-size:28px"></i></div>
        <div style="font-weight:500;margin-bottom:4px">${msg}</div>
      </div>`;
    }
  }

  async function render() {
    if (!_uid) {
      console.warn('[IAView] UID não definido');
      return;
    }
    _loading = true;

    try {
      let knowledge = '';
      let tokens = { planTokens: 0, tokensExtras: 0, totalAvailable: 0 };
      let purchases = [];
      let enabled = false;
      let isTrialPlan = false;

      if (typeof IAModule === 'undefined') {
        throw new Error('IAModule não está definido');
      }

      // Verificar plano
      try {
        const db = FirebaseCore.getDb();
        if (db && _uid) {
          const subSnap = await db.collection('workspaces').doc(_uid)
            .collection('settings').doc('subscription').get();
          if (subSnap.exists && subSnap.data().plan === 'trial') {
            isTrialPlan = true;
          }
        }
      } catch (e) {
        console.error('[IAView] Erro ao verificar plano:', e);
      }

      try {
        knowledge = await IAModule.getKnowledge() || '';
      } catch (e) {
        console.error('[IAView] Erro ao carregar conhecimento:', e);
      }

      try {
        tokens = await IAModule.getTokens() || { planTokens: 0, tokensExtras: 0, totalAvailable: 0 };
      } catch (e) {
        console.error('[IAView] Erro ao carregar tokens:', e);
      }

      try {
        purchases = await IAModule.getPurchases() || [];
      } catch (e) {
        console.error('[IAView] Erro ao carregar histórico:', e);
      }

      try {
        enabled = await IAModule.isEnabled() || false;
      } catch (e) {
        console.error('[IAView] Erro ao verificar status:', e);
      }

      const html = _buildHTML({ knowledge }, tokens, enabled, purchases, isTrialPlan);
      const viewEl = document.getElementById('view-ia');
      if (viewEl) {
        viewEl.innerHTML = html;
      }
    } catch (e) {
      console.error('[IAView] Erro ao renderizar:', e);
      _renderError(e.message || 'Tente recarregar a página');
    } finally {
      _loading = false;
    }
  }

  function _getStatusState(enabled, totalAvailable, isTrialPlan) {
    if (isTrialPlan) return 'blocked-by-plan';
    if (totalAvailable <= 0) return 'no-tokens';
    if (enabled) return 'active';
    return 'inactive';
  }

  function _getStatusBadge(state) {
    const badges = {
      'active': { text: 'Ativa', class: 'badge-active' },
      'inactive': { text: 'Desativada', class: 'badge-inactive' },
      'no-tokens': { text: 'Sem tokens disponíveis', class: 'badge-warning' },
      'blocked-by-plan': { text: 'Bloqueada - Plano Trial', class: 'badge-error' },
    };
    return badges[state] || badges['inactive'];
  }

  function _buildHTML(settings, tokens, enabled, purchases, isTrialPlan) {
    settings = settings || { knowledge: '' };
    tokens = tokens || { planTokens: 0, tokensExtras: 0, totalAvailable: 0 };
    purchases = purchases || [];
    isTrialPlan = isTrialPlan || false;

    const statusState = _getStatusState(enabled, tokens.totalAvailable, isTrialPlan);
    const statusBadge = _getStatusBadge(statusState);

    // Determinar botão do card 1
    let statusButton = '';
    if (statusState === 'blocked-by-plan') {
      statusButton = `<div class="ia-blocked-message" style="padding:16px;background:#fee2e2;border-radius:8px;border-left:4px solid #ef4444;margin-top:12px">
        <div style="font-weight:500;color:#991b1b;margin-bottom:8px">
          <i class="ti ti-lock" style="margin-right:6px"></i>IA não disponível no plano Trial
        </div>
        <div style="font-size:13px;color:#7f1d1d;line-height:1.5">
          Esta funcionalidade está disponível apenas nos planos Pro e Premium. Atualize sua subscrição para usar inteligência artificial.
        </div>
      </div>`;
    } else if (statusState === 'no-tokens') {
      statusButton = `<button class="ia-btn ia-btn-primary" onclick="TokenPurchasePanel.open()">
        <i class="ti ti-credit-card"></i>Recarregar Tokens
      </button>`;
    } else if (statusState === 'active') {
      statusButton = `<button id="ia-toggle-btn" class="ia-btn ia-btn-secondary" onclick="IAView.toggleStatus()">
        Desativar IA
      </button>`;
    } else {
      statusButton = `<button id="ia-toggle-btn" class="ia-btn ia-btn-primary" onclick="IAView.toggleStatus()">
        Ativar IA
      </button>`;
    }

    // Histórico
    let historyHTML = '';
    if (purchases && purchases.length > 0) {
      const lastPurchase = purchases[0];
      historyHTML = `
        <div class="ia-card-history-content">
          <div class="ia-card-history-row">
            <span class="ia-card-history-label">Última recarga:</span>
            <span class="ia-card-history-value">${_fmtDate(lastPurchase.date)}</span>
          </div>
          <div class="ia-card-history-row">
            <span class="ia-card-history-label">Tokens:</span>
            <span class="ia-card-history-value">${_fmt(lastPurchase.tokens || 0)}</span>
          </div>
          <div class="ia-card-history-row">
            <span class="ia-card-history-label">Valor:</span>
            <span class="ia-card-history-value">${lastPurchase.value || 0} MT</span>
          </div>
          <div class="ia-card-history-row">
            <span class="ia-card-history-label">Método:</span>
            <span class="ia-card-history-value">${_fmtMethod(lastPurchase.method)}</span>
          </div>
        </div>
      `;
    } else {
      historyHTML = '<div class="ia-card-history-empty">Nenhuma recarga encontrada</div>';
    }

    return `
      <div class="ia-container">
        
        <!-- HEADER -->
        <div class="ia-page-header">
          <h1>Inteligência Artificial</h1>
        </div>

        <!-- CARD 1: STATUS DA IA -->
        <div class="ia-card">
          <div class="ia-card-header">
            <h2 class="ia-card-title">Status da IA</h2>
            <div class="ia-badge ia-badge-${statusBadge.class}">
              <span class="ia-badge-dot"></span>${statusBadge.text}
            </div>
          </div>
          
          ${statusState === 'no-tokens' ? `
            <div class="ia-card-message ia-message-warning">
              <i class="ti ti-alert-circle"></i>
              <span>Os tokens disponíveis foram esgotados. Recarregue os tokens para continuar utilizando a IA.</span>
            </div>
          ` : ''}
          
          <div class="ia-card-actions">
            ${statusButton}
          </div>
        </div>

        <!-- CARD 2: TOKENS -->
        <div class="ia-card">
          <div class="ia-card-header">
            <h2 class="ia-card-title">Tokens</h2>
          </div>
          
          <div class="ia-tokens-blocks">
            <div class="ia-token-block">
              <div class="ia-token-label">Plano</div>
              <div class="ia-token-number">${_fmt(tokens.planTokens)}</div>
              <div class="ia-token-unit">Disponíveis</div>
            </div>
            <div class="ia-token-block">
              <div class="ia-token-label">Extras</div>
              <div class="ia-token-number">${_fmt(tokens.tokensExtras)}</div>
              <div class="ia-token-unit">Disponíveis</div>
            </div>
            <div class="ia-token-block">
              <div class="ia-token-label">Total</div>
              <div class="ia-token-number">${_fmt(tokens.totalAvailable)}</div>
              <div class="ia-token-unit">Disponíveis</div>
            </div>
          </div>

          <div class="ia-token-bar-container">
            <div class="ia-token-bar-track">
              <div class="ia-token-bar-fill" style="width: ${Math.min((tokens.planTokens / Math.max(tokens.plan?.limit || 1, 1)) * 100, 100)}%"></div>
            </div>
          </div>

          <div class="ia-card-actions">
            <button class="ia-btn ia-btn-primary" onclick="TokenPurchasePanel.open()">
              <i class="ti ti-credit-card"></i>Recarregar Tokens
            </button>
          </div>
        </div>

        <!-- CARD 3: CONHECIMENTO DA IA -->
        <div class="ia-card">
          <div class="ia-card-header">
            <h2 class="ia-card-title">Conhecimento da IA</h2>
          </div>
          
          <textarea
            id="ia-knowledge-input"
            class="ia-knowledge-textarea"
            placeholder=""
          >${settings.knowledge || ''}</textarea>
          
          <div class="ia-card-actions">
            <button id="ia-save-knowledge-btn" class="ia-btn ia-btn-primary" onclick="IAView.saveKnowledge()">
              <i class="ti ti-device-floppy"></i>Salvar
            </button>
            <span id="ia-save-msg" class="ia-save-msg"></span>
          </div>
        </div>

        <!-- CARD 4: HISTÓRICO DE RECARGAS -->
        <div class="ia-card">
          <div class="ia-card-header">
            <h2 class="ia-card-title">Histórico de Recargas</h2>
          </div>
          
          ${historyHTML}
        </div>

      </div>
    `;
  }

  async function saveKnowledge() {
    const input = document.getElementById('ia-knowledge-input');
    const msg = document.getElementById('ia-save-msg');
    const btn = document.getElementById('ia-save-knowledge-btn');
    if (!input || !msg || !btn) return;

    const text = input.value.trim();

    btn.disabled = true;
    msg.textContent = 'A guardar...';
    msg.style.color = 'var(--k-muted)';

    try {
      const success = await IAModule.saveKnowledge(text);
      if (success) {
        msg.textContent = '✓ Guardado';
        msg.style.color = '#22c55e';
        setTimeout(() => { msg.textContent = ''; }, 2000);
      } else {
        msg.textContent = 'Erro ao guardar';
        msg.style.color = '#ef4444';
      }
    } catch (e) {
      msg.textContent = 'Erro ao guardar';
      msg.style.color = '#ef4444';
    } finally {
      btn.disabled = false;
    }
  }

  async function toggleStatus() {
    const btn = document.getElementById('ia-toggle-btn');
    if (!btn) return;

    btn.disabled = true;

    try {
      const enabled = await IAModule.isEnabled();
      if (!enabled) {
        const tokens = await IAModule.getTokens();
        if (!tokens || tokens.totalAvailable <= 0) {
          alert('Você precisa de tokens para ativar a IA. Recarregue tokens primeiro.');
          btn.disabled = false;
          return;
        }
      }

      const success = await IAModule.setEnabled(!enabled);
      if (success) {
        await render();
      } else {
        alert('Erro ao atualizar status');
        btn.disabled = false;
      }
    } catch (e) {
      alert('Erro ao atualizar status');
      btn.disabled = false;
    }
  }

  return {
    init,
    render,
    saveKnowledge,
    toggleStatus,
  };
})();
