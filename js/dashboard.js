// ── SubDashboard — renderiza o card de subscrição no dashboard ──────────
const SubDashboard = (() => {

  function _fmt(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleDateString('pt-PT', { day:'2-digit', month:'2-digit', year:'numeric' });
  }

  function _planLabel(plan) {
    return { trial:'Trial', pro:'Pro', premium:'Premium', expired:'Expirado', suspended:'Suspenso', admin:'Administrador' }[plan] || plan;
  }

  function _statusLabel(plan, days) {
    if (plan === 'admin')     return 'Acesso Permanente'; // BUG FIX 3.3.6
    if (plan === 'suspended') return 'Suspenso';
    if (plan === 'expired')   return 'Expirado';
    if ((plan === 'trial' || plan === 'pro' || plan === 'premium') && days <= 0) return 'Expirado';
    return 'Activo';
  }

  // Renderiza alerta de renovação consoante dias restantes e plano
  function _renderAlert(plan, days) {
    const el = document.getElementById('sub-dash-alert');
    if (!el) return;

    // BUG FIX 3.3.6 — admin nunca vê alertas de renovação
    if (plan === 'admin') { el.innerHTML = ''; return; }

    if (plan === 'suspended') {
      el.innerHTML = `<div class="sub-alert danger"><i class="ti ti-ban"></i> A sua conta está suspensa. Contacte o suporte.</div>`;
      return;
    }
    if (plan === 'expired' || ((plan === 'trial' || plan === 'pro' || plan === 'premium') && days <= 0)) {
      el.innerHTML = `<div class="sub-alert critical"><i class="ti ti-clock-off"></i> A sua assinatura expirou. Renove para continuar a utilizar o Korvex.</div>`;
      return;
    }
    if (days <= 3) {
      el.innerHTML = `<div class="sub-alert critical"><i class="ti ti-alert-triangle"></i> A sua assinatura termina em <strong>${days} dia${days!==1?'s':''}</strong>. Renove agora para não perder o acesso.</div>`;
      return;
    }
    if (days <= 7) {
      el.innerHTML = `<div class="sub-alert warn"><i class="ti ti-clock"></i> A sua assinatura termina em breve — faltam <strong>${days} dias</strong>.</div>`;
      return;
    }
    el.innerHTML = '';
  }

  // Renderiza o card completo com dados da subscrição
  async function render(user) {
    if (!user) return;

    // Preencher dados de conta (imediato)
    const emailEl   = document.getElementById('sub-acct-email');
    const loginEl   = document.getElementById('sub-acct-login');
    const createdEl = document.getElementById('sub-acct-created');
    if (emailEl)   emailEl.textContent   = user.email || '—';
    if (loginEl)   loginEl.textContent   = user.metadata?.lastSignInTime
                                           ? _fmt(new Date(user.metadata.lastSignInTime).getTime()) : '—';
    if (createdEl) createdEl.textContent = user.metadata?.creationTime
                                           ? _fmt(new Date(user.metadata.creationTime).getTime()) : '—';

    // Obter subscription (já em cache — sem nova leitura Firestore)
    const sub = SubscriptionService.getCached();
    if (!sub) {
      // Ainda a carregar — mostrar placeholder
      document.getElementById('sub-dash-plan').textContent   = '…';
      document.getElementById('sub-dash-status').textContent = '…';
      document.getElementById('sub-dash-days').textContent   = '…';
      document.getElementById('sub-dash-expiry').textContent = '…';
      return;
    }

    const plan = sub.plan || 'expired';
    const days = Math.max(0, Math.ceil(((sub.expiresAt || 0) - Date.now()) / 86400000));
    const status = _statusLabel(plan, days);

    // Preencher métricas
    const planEl   = document.getElementById('sub-dash-plan');
    const statusEl = document.getElementById('sub-dash-status');
    const daysEl   = document.getElementById('sub-dash-days');
    const expiryEl = document.getElementById('sub-dash-expiry');
    const badgeEl  = document.getElementById('sub-dash-plan-badge');
    const acctPlan = document.getElementById('sub-acct-plan');

    if (planEl)   planEl.textContent   = _planLabel(plan);
    if (statusEl) statusEl.textContent = status;
    // BUG FIX 3.3.6 — admin: mostrar ∞ em vez de dias numéricos
    if (daysEl)   daysEl.textContent   = plan === 'admin' ? '∞' : `Faltam ${days} dia${days !== 1 ? 's' : ''}`;
    if (expiryEl) expiryEl.textContent = plan === 'admin' ? 'Nunca' : (sub.expiresAt ? _fmt(sub.expiresAt) : '—');
    if (acctPlan) acctPlan.textContent = _planLabel(plan);

    if (badgeEl) {
      // BUG FIX 3.3.6 — admin badge sempre 'active' (verde)
      const effectivePlan = plan === 'admin' ? 'active'
                          : (plan === 'trial' || plan === 'pro' || plan === 'premium') && days <= 0 ? 'expired'
                          : plan;
      badgeEl.className   = `sub-dash-plan-badge ${effectivePlan}`;
      badgeEl.textContent = _planLabel(plan);
    }

    _renderAlert(plan, days);
  }

  return { render };
})();

// ── TokenPurchasePanel — modal de compra de tokens IA ──────────────────
const TokenPurchasePanel = (() => {
  const BACKEND_URL = (typeof window !== 'undefined' && window.KORVEX_BACKEND_URL)
    ? window.KORVEX_BACKEND_URL
    : 'http://localhost:3001';

  let _selectedPackage = null;
  let _selectedMethod = null;
  let _pollTimer = null;

  function open() {
    document.getElementById('token-purchase-overlay').classList.add('open');
    _resetStatus();
    document.querySelectorAll('.token-package-btn').forEach(b => b.classList.remove('selected'));
    document.querySelectorAll('.token-method-btn').forEach(b => b.classList.remove('selected'));
    _selectedPackage = null;
    _selectedMethod = null;
    _setSubmitting(false);
  }

  function close() {
    document.getElementById('token-purchase-overlay').classList.remove('open');
    _stopPolling();
  }

  function selectPackage(packageId, btn) {
    _selectedPackage = packageId;
    document.querySelectorAll('.token-package-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    _resetStatus();
  }

  function selectMethod(method, btn) {
    _selectedMethod = method;
    document.querySelectorAll('.token-method-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    _resetStatus();
  }

  function _resetStatus() {
    const el = document.getElementById('token-status-msg');
    if (el) { el.textContent = ''; el.className = 'token-status-msg'; }
  }

  function _showStatus(msg, type) {
    const el = document.getElementById('token-status-msg');
    if (!el) return;
    el.textContent = msg;
    el.className = 'token-status-msg open' + (type ? ` ${type}` : '');
  }

  function _setSubmitting(isSubmitting) {
    const btn = document.getElementById('token-purchase-btn');
    if (!btn) return;
    btn.disabled = isSubmitting;
    btn.innerHTML = isSubmitting
      ? `<i class="ti ti-loader-2" style="animation:spin .8s linear infinite"></i> A processar...`
      : `<i class="ti ti-credit-card"></i> Comprar agora`;
  }

  async function submit() {
    if (!_selectedPackage) {
      _showStatus('Escolha um pacote.', 'error');
      return;
    }
    if (!_selectedMethod) {
      _showStatus('Escolha um método de pagamento.', 'error');
      return;
    }

    const user = typeof AuthService !== 'undefined' ? AuthService.currentUser() : null;
    if (!user) {
      _showStatus('Sessão inválida. Inicie sessão novamente.', 'error');
      return;
    }

    const host = window.location.hostname;
    const isRealHost = window.location.protocol.startsWith('http')
      && host
      && host !== '0.0.0.0'
      && host !== 'localhost'
      && !/^127\./.test(host)
      && !/^192\.168\./.test(host)
      && !/^10\./.test(host);

    const payload = {
      uid: user.uid,
      packageId: _selectedPackage,
      method: _selectedMethod,
      ...(isRealHost ? { returnUrl: window.location.origin + window.location.pathname } : {}),
    };

    _setSubmitting(true);
    _showStatus('A processar...', '');

    try {
      const res = await fetch(`${BACKEND_URL}/payments/buyTokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (!data.ok) {
        _setSubmitting(false);
        _showStatus(data.error || 'Não foi possível iniciar o pagamento.', 'error');
        return;
      }

      if (data.checkoutUrl) {
        try {
          localStorage.setItem('korvex_pending_payment', JSON.stringify({ uid: user.uid, ts: Date.now() }));
        } catch (e) {}
        _showStatus('A processar...', 'pending');
        window.location.href = data.checkoutUrl;
        return;
      }

      _showStatus('A processar...', 'pending');
      _startPolling(user.uid);
    } catch (e) {
      _setSubmitting(false);
      _showStatus('Não foi possível contactar o servidor Korvex.', 'error');
    }
  }

  function _startPolling(uid) {
    _stopPolling();
    const startedAt = Date.now();
    _pollTimer = setInterval(async () => {
      if (Date.now() - startedAt > 90000) {
        _stopPolling();
        _setSubmitting(false);
        _showStatus('A processar...', 'pending');
        return;
      }
      const tokens = await (typeof IAModule !== 'undefined' ? IAModule.getTokens() : null);
      if (tokens && tokens.totalAvailable > 0) {
        _stopPolling();
        _setSubmitting(false);
        try { localStorage.removeItem('korvex_pending_payment'); } catch (e) {}
        _showStatus('Pagamento confirmado! Os tokens foram adicionados à sua conta.', 'success');
        setTimeout(() => { close(); if (typeof IAView !== 'undefined') IAView.render(); }, 1800);
      }
    }, 4000);
  }

  function _stopPolling() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  }

  return { open, close, selectPackage, selectMethod, submit };
})();

// ── RenewPanel — modal de assinatura com seleção de plano (Korvex PRO/PREMIUM via PaySuite) ─────
const RenewPanel = (() => {
  const BACKEND_URL = (typeof window !== 'undefined' && window.KORVEX_BACKEND_URL)
    ? window.KORVEX_BACKEND_URL
    : 'http://localhost:3001';

  // Estado
  let _selectedPlan = null;
  let _selectedMethod = null;
  let _pollTimer = null;

  // Planos disponíveis
  const PLANS = {
    pro: { name: 'Pro', price: 800, features: ['1 número WhatsApp', 'IA desbloqueada', '4M tokens IA'] },
    premium: { name: 'Premium', price: 1500, features: ['2 números WhatsApp', 'IA desbloqueada', '10M tokens IA'] }
  };

  function open() {
    document.getElementById('renew-overlay').classList.add('open');
    _resetToPlansStep();
  }

  function close() {
    document.getElementById('renew-overlay').classList.remove('open');
    _stopPolling();
    _resetState();
  }

  function _resetState() {
    _selectedPlan = null;
    _selectedMethod = null;
    document.querySelectorAll('.renew-plan-card').forEach(c => c.classList.remove('selected'));
    document.querySelectorAll('.renew-method-btn').forEach(b => b.classList.remove('selected'));
  }

  function _resetToPlansStep() {
    _resetState();
    _showStepPlans();
    const el = document.getElementById('renew-status-msg-plans');
    if (el) { el.textContent = ''; el.className = 'renew-status-msg'; }
  }

  function _showStepPlans() {
    document.getElementById('renew-step-plans').classList.add('renew-step-active');
    document.getElementById('renew-step-plans').classList.remove('renew-step-hidden');
    document.getElementById('renew-step-payment').classList.remove('renew-step-active');
    document.getElementById('renew-step-payment').classList.add('renew-step-hidden');
  }

  function _showStepPayment() {
    document.getElementById('renew-step-plans').classList.remove('renew-step-active');
    document.getElementById('renew-step-plans').classList.add('renew-step-hidden');
    document.getElementById('renew-step-payment').classList.add('renew-step-active');
    document.getElementById('renew-step-payment').classList.remove('renew-step-hidden');
    
    // Mostrar resumo do plano
    if (_selectedPlan && PLANS[_selectedPlan]) {
      const plan = PLANS[_selectedPlan];
      const summary = document.getElementById('renew-plan-summary');
      if (summary) {
        summary.innerHTML = `
          <div class="renew-summary-item">
            <span>Plano selecionado:</span>
            <strong>${plan.name}</strong>
          </div>
          <div class="renew-summary-item">
            <span>Valor:</span>
            <strong>${plan.price} MT/mês</strong>
          </div>
        `;
      }
    }
  }

  function selectPlan(plan, element) {
    if (!['pro', 'premium'].includes(plan)) return;
    
    _selectedPlan = plan;
    
    // Remover seleção anterior
    document.querySelectorAll('.renew-plan-card').forEach(c => c.classList.remove('selected'));
    
    // Adicionar seleção ao card clicado
    element.classList.add('selected');
    
    // Habilitar botão continuar
    const continueBtn = document.getElementById('renew-continue-btn');
    if (continueBtn) {
      continueBtn.disabled = false;
    }
  }

  function goToPayment() {
    if (!_selectedPlan) {
      const el = document.getElementById('renew-status-msg-plans');
      if (el) {
        el.textContent = 'Por favor, selecione um plano.';
        el.className = 'renew-status-msg open error';
      }
      return;
    }
    
    _selectedMethod = null;
    document.querySelectorAll('.renew-method-btn').forEach(b => b.classList.remove('selected'));
    _resetStatusMsg();
    _showStepPayment();
  }

  function goBackToPlan() {
    _selectedMethod = null;
    document.querySelectorAll('.renew-method-btn').forEach(b => b.classList.remove('selected'));
    const submitBtn = document.getElementById('renew-submit-btn');
    if (submitBtn) submitBtn.disabled = true;
    _resetStatusMsg();
    _showStepPlans();
  }

  function selectMethod(method, btn) {
    _selectedMethod = method;
    document.querySelectorAll('.renew-method-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    
    // Habilitar botão submit
    const submitBtn = document.getElementById('renew-submit-btn');
    if (submitBtn) {
      submitBtn.disabled = false;
    }
    
    _resetStatusMsg();
  }

  function _resetStatusMsg() {
    const el = document.getElementById('renew-status-msg');
    if (el) { el.textContent = ''; el.className = 'renew-status-msg'; }
  }

  function _showStatus(msg, type) {
    const el = document.getElementById('renew-status-msg');
    if (!el) return;
    el.textContent = msg;
    el.className = 'renew-status-msg open' + (type ? ` ${type}` : '');
  }

  function _setSubmitting(isSubmitting) {
    const btn = document.getElementById('renew-submit-btn');
    if (!btn) return;
    btn.disabled = isSubmitting;
    btn.innerHTML = isSubmitting
      ? `<i class="ti ti-loader-2" style="animation:spin .8s linear infinite"></i> A processar...`
      : `<i class="ti ti-lock"></i> Confirmar pagamento`;
  }

  async function submit() {
    if (!_selectedPlan) {
      _showStatus('Selecione um plano.', 'error');
      return;
    }

    if (!_selectedMethod) {
      _showStatus('Escolha um método de pagamento.', 'error');
      return;
    }

    const user = typeof AuthService !== 'undefined' ? AuthService.currentUser() : null;
    if (!user) {
      _showStatus('Sessão inválida. Inicie sessão novamente.', 'error');
      return;
    }

    // 0.0.0.0, localhost, 127.x e file:// não são URLs que a PaySuite
    // (ou qualquer serviço externo) consiga aceitar como return_url —
    // não existem na internet, só fazem sentido dentro da tua máquina.
    // Por isso só enviamos returnUrl quando a página estiver a ser
    // servida por um domínio real. Caso contrário, omitimos o campo:
    // é opcional na PaySuite, e ela usa o comportamento padrão dela.
    const host = window.location.hostname;
    const isRealHost = window.location.protocol.startsWith('http')
      && host
      && host !== '0.0.0.0'
      && host !== 'localhost'
      && !/^127\./.test(host)
      && !/^192\.168\./.test(host)
      && !/^10\./.test(host);

    const payload = {
      uid: user.uid,
      method: _selectedMethod,
      plan: _selectedPlan,  // ✅ AGORA ENVIA O PLANO ESCOLHIDO
      ...(isRealHost ? { returnUrl: window.location.origin + window.location.pathname } : {}),
    };

    _setSubmitting(true);
    _showStatus('A processar...', '');

    try {
      const res  = await fetch(`${BACKEND_URL}/payments/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (!data.ok) {
        _setSubmitting(false);
        _showStatus(data.error || 'Não foi possível iniciar o pagamento.', 'error');
        return;
      }

      if (data.checkoutUrl) {
        // A PaySuite devolve sempre um checkout_url real — é lá que o
        // pagamento é efectivamente confirmado (PIN M-Pesa/e-Mola ou
        // dados de cartão). Redireccionamos sempre para lá; nada disto
        // é simulado.
        try {
          localStorage.setItem('korvex_pending_payment', JSON.stringify({ uid: user.uid, ts: Date.now() }));
        } catch (e) {}
        _showStatus('A abrir o pagamento na PaySuite...', 'pending');
        window.location.href = data.checkoutUrl;
        return;
      }

      _showStatus('Pagamento iniciado. A confirmar automaticamente assim que for aprovado...', 'pending');
      _startPolling(user.uid);
    } catch (e) {
      _setSubmitting(false);
      _showStatus('Não foi possível contactar o servidor Korvex.', 'error');
    }
  }

  // Após iniciar o pagamento, a activação chega via webhook da PaySuite
  // (server/payments/index.js → activateSubscription). Aqui apenas
  // verificamos periodicamente se a assinatura já foi activada, para dar
  // feedback imediato ao utilizador sem que ele precise de recarregar.
  function _startPolling(uid) {
    _stopPolling();
    const startedAt = Date.now();
    _pollTimer = setInterval(async () => {
      if (Date.now() - startedAt > 90000) { // 90s de tentativa
        _stopPolling();
        _setSubmitting(false);
        _showStatus('O pagamento continua a ser processado. A sua assinatura será activada automaticamente assim que for confirmado — pode fechar esta janela.', 'pending');
        return;
      }
      const sub = await SubscriptionService.get(uid);
      if (sub && (sub.plan === 'pro' || sub.plan === 'premium')) {
        _stopPolling();
        _setSubmitting(false);
        try { localStorage.removeItem('korvex_pending_payment'); } catch (e) {}
        const planName = sub.plan === 'pro' ? 'Pro' : 'Premium';
        const planPrice = sub.plan === 'pro' ? '800' : '1500';
        _showStatus(`Pagamento confirmado! A sua assinatura Korvex ${planName} (${planPrice} MT) está activa.`, 'success');
        setTimeout(() => { close(); location.reload(); }, 1800);
      }
    }, 4000);
  }

  function _stopPolling() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  }

  // Ao voltar da página de checkout da PaySuite (return_url), retomamos
  // automaticamente a confirmação, mesmo que a aba tenha sido fechada e
  // reaberta entretanto. Expira ao fim de 15 min para não ficar preso.
  function _resumePendingPaymentIfAny() {
    let pending;
    try { pending = JSON.parse(localStorage.getItem('korvex_pending_payment') || 'null'); } catch (e) { pending = null; }
    if (!pending || !pending.uid) return;
    if (Date.now() - (pending.ts || 0) > 15 * 60 * 1000) {
      try { localStorage.removeItem('korvex_pending_payment'); } catch (e) {}
      return;
    }
    open();
    _showStatus('A confirmar o seu pagamento na PaySuite...', 'pending');
    _setSubmitting(true);
    _startPolling(pending.uid);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _resumePendingPaymentIfAny);
  } else {
    _resumePendingPaymentIfAny();
  }

  return { 
    open, 
    close, 
    selectPlan, 
    selectMethod, 
    submit,
    goToPayment,
    goBackToPlan
  };
})();
