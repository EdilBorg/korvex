// BUGFIX-02.4 — constantes duplicadas de admin.js (subscription.js carrega antes de admin.js)
// Manter sincronizadas com SUPER_ADMIN_EMAIL / SUPER_ADMIN_UID em admin.js
const _SUB_SUPER_ADMIN_EMAIL = 'korvexsuporte@gmail.com';
const _SUB_SUPER_ADMIN_UID   = 'R4Oy03GeNKbk5ucpYdNAFQoXB6p2';

const SubscriptionService = (() => {

  const TRIAL_DAYS = 3;

  // ── Helper: referência Firestore ────────────────────────────────────

  function _ref(uid) {
    const db = FirebaseCore.getDb();
    if (!db || !uid) return null;
    return db.collection('workspaces').doc(uid)
              .collection('settings').doc('subscription');
  }

  // ── Helper: calcular dias restantes ────────────────────────────────

  function _calcDays(expiresAt) {
    if (!expiresAt) return 0;
    const ms   = expiresAt - Date.now();
    const days = Math.ceil(ms / (1000 * 60 * 60 * 24));
    return Math.max(0, days);
  }

  // ── createDefault(uid) ──────────────────────────────────────────────
  // Cria subscrição trial de 3 dias para um novo utilizador.
  // Chamado em onAuthChange quando subscription não existe.

  async function createDefault(uid) {
    const ref = _ref(uid);
    if (!ref) {
      console.warn('[SubscriptionService] Firestore indisponível — createDefault ignorado');
      return null;
    }
    const now       = Date.now();
    const expiresAt = now + TRIAL_DAYS * 24 * 60 * 60 * 1000;
    const doc = {
      uid,
      plan:         'trial',
      trialUsed:    true,
      expiresAt,
      createdAt:    now,
      updatedAt:    now,
      daysRemaining: TRIAL_DAYS,
    };
    try {
      await ref.set(doc);
      _setCached(doc); // BUG FIX 3.3.6 — actualizar cache imediatamente após criar trial
      // [FLIGHT RECORDER]
      if (typeof korvexFlightRecorder !== 'undefined') {
        korvexFlightRecorder.recordSubscription('createDefault', {
          uid,
          plan: 'trial',
          expiresAt,
          daysRemaining: TRIAL_DAYS,
          cached: doc
        });
      }
      console.info('[SubscriptionService] Trial criado para:', uid, '| expira em', new Date(expiresAt).toLocaleDateString());
      return doc;
    } catch(e) {
      // [FLIGHT RECORDER]
      if (typeof korvexFlightRecorder !== 'undefined') {
        korvexFlightRecorder.recordSubscription('createDefault', {
          uid,
          error: e.message,
          success: false
        });
      }
      console.error('[TRACE ERROR] SubscriptionService.createDefault', e);
      console.error('[SubscriptionService] Erro ao criar subscription:', e);
      return null;
    }
  }

  // ── get(uid) ────────────────────────────────────────────────────────

  async function get(uid) {
    const ref = _ref(uid);
    if (!ref) return null;
    try {
      const snap = await ref.get();
      if (!snap.exists) return null;
      const data = snap.data();
      // Calcular daysRemaining em tempo real (não confiar no valor guardado)
      data.daysRemaining = _calcDays(data.expiresAt);
      _setCached(data); // FASE 3.2 — actualizar cache síncrona
      // [FLIGHT RECORDER]
      if (typeof korvexFlightRecorder !== 'undefined') {
        korvexFlightRecorder.recordSubscription('get', {
          uid,
          plan: data.plan,
          expiresAt: data.expiresAt,
          source: 'firestore',
          cached: data
        });
      }
      return data;
    } catch(e) {
      // [FLIGHT RECORDER]
      if (typeof korvexFlightRecorder !== 'undefined') {
        korvexFlightRecorder.recordSubscription('get', {
          uid,
          error: e.message,
          source: 'firestore'
        });
      }
      console.error('[TRACE ERROR] SubscriptionService.get', e);
      console.error('[SubscriptionService] Erro ao ler subscription:', e);
      return null;
    }
  }

  // ── isActive(uid) ───────────────────────────────────────────────────

  async function isActive(uid) {
    const sub = await get(uid);
    if (!sub) return false;
    if (sub.plan === 'trial')  return _calcDays(sub.expiresAt) > 0;
    if (sub.plan === 'pro' || sub.plan === 'premium') {
      return (sub.expiresAt == null || sub.expiresAt > Date.now());
    }
    return false;
  }

  // ── getDaysRemaining(uid) ───────────────────────────────────────────

  async function getDaysRemaining(uid) {
    const sub = await get(uid);
    if (!sub) return 0;
    // Todos os planos têm data de expiração — retornar dias reais
    return _calcDays(sub.expiresAt);
  }

  // ── extend(uid, days) ───────────────────────────────────────────────
  // Adiciona N dias à data de expiração actual.
  // Usado pelo Painel Admin e PaySuite.

  async function extend(uid, days) {
    const ref = _ref(uid);
    if (!ref) return false;
    try {
      const snap = await ref.get();
      const base = (snap.exists && snap.data().expiresAt > Date.now())
        ? snap.data().expiresAt
        : Date.now();
      const newExpiry = base + days * 24 * 60 * 60 * 1000;
      await ref.update({
        expiresAt:    newExpiry,
        updatedAt:    Date.now(),
        daysRemaining: _calcDays(newExpiry),
      });
      console.info(`[SubscriptionService] ${uid} extended by ${days} days → ${new Date(newExpiry).toLocaleDateString()}`);
      return true;
    } catch(e) {
      console.error('[SubscriptionService] Erro ao extender:', e);
      return false;
    }
  }

  // ── expire(uid) ─────────────────────────────────────────────────────

  async function expire(uid) {
    const ref = _ref(uid);
    if (!ref) return false;
    try {
      await ref.update({ plan: 'suspended', updatedAt: Date.now(), daysRemaining: 0 });
      console.info('[SubscriptionService] Expirado:', uid);
      return true;
    } catch(e) {
      console.error('[SubscriptionService] Erro ao expirar:', e);
      return false;
    }
  }

  // ── suspend(uid) ────────────────────────────────────────────────────

  async function suspend(uid) {
    const ref = _ref(uid);
    if (!ref) return false;
    try {
      await ref.update({ plan: 'suspended', updatedAt: Date.now() });
      console.info('[SubscriptionService] Suspenso:', uid);
      return true;
    } catch(e) {
      console.error('[SubscriptionService] Erro ao suspender:', e);
      return false;
    }
  }

  // ── activate(uid) ───────────────────────────────────────────────────
  // Activa assinatura paga com 30 dias de duração.
  // PaySuite chamará este método após pagamento confirmado.
  // [DEPRECIADO — usar activatePlan() em seu lugar]

  async function activate(uid) {
    const ref = _ref(uid);
    if (!ref) return false;
    try {
      const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
      await ref.update({
        plan:         'premium',
        expiresAt,
        updatedAt:    Date.now(),
        daysRemaining: 30,
      });
      console.info('[SubscriptionService] Activado:', uid);
      return true;
    } catch(e) {
      console.error('[SubscriptionService] Erro ao activar:', e);
      return false;
    }
  }

  // ── activatePlan(uid, newPlan, durationDays) ────────────────────────
  // Função genérica para ativar/alterar plano.
  // Regra 1: Mesmo plano → somar dias (ex: pro → pro = estender)
  // Regra 2: Plano diferente → reiniciar duração (ex: trial → pro = 30 dias novos)
  // Durationd: dias da subscrição (ex: pro/premium = 30, trial = 3)

  async function activatePlan(uid, newPlan, durationDays = 30) {
    const ref = _ref(uid);
    if (!ref) return false;

    try {
      const snap = await ref.get();
      const currentData = snap.exists ? snap.data() : null;
      const currentPlan = currentData ? currentData.plan : 'trial';

      let newExpiresAt;

      if (currentPlan === newPlan && currentPlan !== 'trial') {
        // Mesma plano (não trial) → somar dias à data existente
        const baseDate = (currentData && currentData.expiresAt > Date.now())
          ? currentData.expiresAt
          : Date.now();
        newExpiresAt = baseDate + durationDays * 24 * 60 * 60 * 1000;
        console.info(`[SubscriptionService] ${uid} extended ${newPlan} by ${durationDays} days → ${new Date(newExpiresAt).toLocaleDateString()}`);
      } else {
        // Plano diferente ou trial → nova subscrição
        newExpiresAt = Date.now() + durationDays * 24 * 60 * 60 * 1000;
        console.info(`[SubscriptionService] ${uid} upgraded/changed to ${newPlan} for ${durationDays} days → ${new Date(newExpiresAt).toLocaleDateString()}`);
      }

      await ref.update({
        plan:          newPlan,
        expiresAt:     newExpiresAt,
        updatedAt:     Date.now(),
        daysRemaining: durationDays,
      });

      // Invalidar cache do lado do servidor (se disponível)
      if (typeof invalidatePlanCache !== 'undefined') {
        invalidatePlanCache(uid);
      }

      return true;
    } catch (e) {
      console.error('[SubscriptionService] Erro ao activar plano:', e);
      return false;
    }
  }

  // ── FASE 3.2 — Cache interna ────────────────────────────────────────
  // Evita múltiplas leituras do Firestore por sessão.
  // Actualizada sempre que get() é chamado.

  let _cachedSub = null;
  let _currentAdminEmail = null; // BUG FIX 3.3.6 — email do utilizador actual para bypass admin

  // Chamado pelo app.js ao resolver o utilizador
  function setCurrentEmail(email) {
    _currentAdminEmail = email || null;
  }

  function _setCached(sub) {
    const oldCache = _cachedSub;
    _cachedSub = sub;
    // [FLIGHT RECORDER]
    if (typeof korvexFlightRecorder !== 'undefined') {
      korvexFlightRecorder.recordSubscription('_setCached', {
        uid: sub ? sub.uid : null,
        plan: sub ? sub.plan : null,
        expiresAt: sub ? sub.expiresAt : null,
        cachedSubscription: sub
      });
    }
  }

  function getCached() {
    // [FLIGHT RECORDER]
    if (typeof korvexFlightRecorder !== 'undefined') {
      korvexFlightRecorder.recordSubscription('getCached', {
        cached: _cachedSub,
        source: 'cache'
      });
    }
    return _cachedSub;
  }

  // ── FASE 3.2 — canAccess() ──────────────────────────────────────────
  // Retorna true se trial ou active COM expiresAt > agora.
  // Usa cache para ser síncrono (chamado em guards inline).

  function canAccess() {
    // BUG FIX 3.3.6 — administradores têm acesso permanente
    // BUGFIX-02.4 — verificação híbrida: super_admin por email/uid (síncrono) ou cache Firestore
    if (_currentAdminEmail) {
      // 1. Fallback hardcoded — super_admin sempre tem acesso mesmo sem Firestore
      if (_currentAdminEmail.toLowerCase().trim() === _SUB_SUPER_ADMIN_EMAIL) {
        // [FLIGHT RECORDER]
        if (typeof korvexFlightRecorder !== 'undefined') {
          korvexFlightRecorder.recordSubscription('canAccess', {
            email: _currentAdminEmail,
            result: true,
            reason: 'super_admin_hardcoded'
          });
        }
        return true;
      }
      // 2. Outros admins — via cache do AdminGuard (carregado no onAuthChange)
      const u = typeof AuthService !== 'undefined' ? AuthService.currentUser() : null;
      if (u && (u.uid === _SUB_SUPER_ADMIN_UID || AdminGuard.getCached(u.uid) === true)) {
        // [FLIGHT RECORDER]
        if (typeof korvexFlightRecorder !== 'undefined') {
          korvexFlightRecorder.recordSubscription('canAccess', {
            uid: u.uid,
            email: u.email,
            result: true,
            reason: 'admin_guard'
          });
        }
        return true;
      }
    }
    const sub = _cachedSub;
    if (!sub) {
      // [FLIGHT RECORDER]
      if (typeof korvexFlightRecorder !== 'undefined') {
        korvexFlightRecorder.recordSubscription('canAccess', {
          result: false,
          reason: 'no_cached_subscription'
        });
      }
      return false;
    }
    let result = false;
    let reason = '';
    if (sub.plan === 'admin')  { result = true; reason = 'admin_plan'; }
    else if (sub.plan === 'premium') { result = _calcDays(sub.expiresAt) > 0; reason = 'premium_plan'; }
    else if (sub.plan === 'pro') { result = _calcDays(sub.expiresAt) > 0; reason = 'pro_plan'; }
    else if (sub.plan === 'trial')  { result = _calcDays(sub.expiresAt) > 0; reason = 'trial_plan'; }
    else { result = false; reason = 'expired_or_suspended'; }
    
    // [FLIGHT RECORDER]
    if (typeof korvexFlightRecorder !== 'undefined') {
      korvexFlightRecorder.recordSubscription('canAccess', {
        uid: sub.uid,
        plan: sub.plan,
        result,
        reason,
        daysRemaining: _calcDays(sub.expiresAt)
      });
    }
    return result;
  }

  // ── FASE 3.2 — getStatus() ─────────────────────────────────────────
  // Retorna: 'trial' | 'pro' | 'premium' | 'expired' | 'suspended' | 'admin'

  function getStatus() {
    // BUG FIX 3.3.6 — admin email → status permanente
    // BUGFIX-02.4 — verificação híbrida: super_admin por email/uid (síncrono) ou cache Firestore
    if (_currentAdminEmail) {
      if (_currentAdminEmail.toLowerCase().trim() === _SUB_SUPER_ADMIN_EMAIL) return 'admin';
      const u = typeof AuthService !== 'undefined' ? AuthService.currentUser() : null;
      if (u && (u.uid === _SUB_SUPER_ADMIN_UID || AdminGuard.getCached(u.uid) === true)) return 'admin';
    }
    const sub = _cachedSub;
    if (!sub) return 'expired';
    if (sub.plan === 'admin') return 'admin';
    // Trial/pro/premium expirado → tratar como expired
    if ((sub.plan === 'trial' || sub.plan === 'pro' || sub.plan === 'premium') && _calcDays(sub.expiresAt) <= 0) {
      return 'expired';
    }
    return sub.plan;
  }

  // ── renderBadge(sub) ────────────────────────────────────────────────
  // Actualiza o indicador discreto na topbar.
  // Chamado por _authUpdateUI após carregar a subscription.

  function renderBadge(sub) {
    const el = document.getElementById('sub-badge');
    if (!el) return;

    if (!sub) {
      el.style.display = 'none';
      return;
    }

    const plan = sub.plan || 'expired';
    const days = _calcDays(sub.expiresAt);

    let cls  = plan;
    let text = '';

    switch(plan) {
      case 'admin':
        cls  = 'active';
        text = 'Administrador';
        break;
      case 'pro':
        text = sub.expiresAt
          ? `Pro • ${days} dia${days !== 1 ? 's' : ''}`
          : 'Pro';
        break;
      case 'trial':
        text = `Trial • ${days} dia${days !== 1 ? 's' : ''}`;
        break;
      case 'premium':
        text = sub.expiresAt
          ? `Premium • ${days} dia${days !== 1 ? 's' : ''}`
          : 'Premium';
        break;
      case 'expired':
        text = 'Expirado';
        break;
      case 'suspended':
        text = 'Suspenso';
        break;
      default:
        text = plan;
    }

    el.className   = `sub-badge ${cls}`;
    el.innerHTML   = `<span class="sub-badge-dot"></span>${text}`;
    el.style.display = '';
  }

  // BUG FIX BUGFIX-01 — expor _setCached para fallback local em app.js
  function _setCachedPublic(sub) { _setCached(sub); }

  return {
    createDefault,
    get,
    isActive,
    getDaysRemaining,
    extend,
    expire,
    suspend,
    activate,
    activatePlan,
    renderBadge,
    // FASE 3.2
    canAccess,
    getStatus,
    getCached,
    // BUG FIX 3.3.6
    setCurrentEmail,
    // BUG FIX BUGFIX-01
    _setCachedPublic,
  };
})();

/* ══════════════════════════════════════════════════════════════════════
   FASE 3.2 — Motor de Bloqueio de Subscrição
   ────────────────────────────────────────────────────────────────────
   Quando a subscrição expira ou é suspensa:
     1. Limpa o canvas (nodes, edges, sel, activeId)
     2. Fecha todos os modais e painéis
     3. Mostra o ecrã de bloqueio adequado
     4. Desconecta canais externos (preparação futura)
   ══════════════════════════════════════════════════════════════════════ */

// ── _subClearEditor() ───────────────────────────────────────────────────
// Limpa toda a memória operacional do editor. Dados no Firestore intactos.

function _subClearEditor() {
  // Canvas
  nodes        = [];
  edges        = [];
  activeId     = null;
  _canvasReady = false;
  if (sel) sel.clear();

  // Undo/redo
  if (typeof undoStack !== 'undefined') { undoStack = []; redoStack = []; }

  // Variáveis de interacção do canvas
  if (typeof connecting    !== 'undefined') connecting    = null;
  if (typeof selEdge       !== 'undefined') selEdge       = null;
  if (typeof _nodeIdCounter!== 'undefined') _nodeIdCounter = 0;
  if (typeof _edgeIdCounter!== 'undefined') _edgeIdCounter = 0;
  if (typeof NodeMap       !== 'undefined') NodeMap.clear();
  if (typeof _edgeIdSet    !== 'undefined') _edgeIdSet.clear();

  // Re-renderizar canvas vazio
  try { render(); } catch(e) {}
  try { updateTransform(); } catch(e) {}
  try { drawMini(); } catch(e) {}

  console.info('[SubBlock] Canvas e memória limpos.');
}

// ── _subCloseAllPanels() ────────────────────────────────────────────────
// Fecha modais, propriedades, simulador, publicação e lista de fluxos.

function _subCloseAllPanels() {
  const ids = [
    'pub-overlay', 'sim-overlay', 'props-panel',
    'flow-list-overlay', 'wf-diag-overlay', 'ctx-menu', 'ctx-edge-menu',
  ];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('open', 'active', 'visible');
    el.style.display = '';
  });

  // Fechar painel de propriedades via classe
  const propsPanels = document.querySelectorAll('.props-open, .panel-open');
  propsPanels.forEach(el => el.classList.remove('props-open', 'panel-open'));

  console.info('[SubBlock] Todos os painéis fechados.');
}

// ── _subDisconnectChannels() ────────────────────────────────────────────
// Desconecta integrações activas (WhatsApp, Telegram, Webhooks, etc).
// Preparado para quando as integrações forem implementadas.

function _subDisconnectChannels() {
  // WhatsApp / Baileys — quando implementado
  if (typeof WhatsAppService !== 'undefined') {
    try { WhatsAppService.disconnect?.(); } catch(e) {}
    try { WhatsAppService.stop?.();       } catch(e) {}
    try { WhatsAppService.destroy?.();    } catch(e) {}
  }
  // Telegram — quando implementado
  if (typeof TelegramService !== 'undefined') {
    try { TelegramService.disconnect?.(); } catch(e) {}
    try { TelegramService.stop?.();       } catch(e) {}
  }
  // Webhooks — quando implementado
  if (typeof WebhookService !== 'undefined') {
    try { WebhookService.removeListeners?.(); } catch(e) {}
    try { WebhookService.close?.();           } catch(e) {}
  }
  // WorkflowEngine workers/polling — quando implementado
  if (typeof WorkflowEngine !== 'undefined') {
    try { WorkflowEngine.stop?.();        } catch(e) {}
  }
  console.info('[SubBlock] Canais desconectados (ou prontos para desligar quando implementados).');
}

// ── _subRenderBlockScreen(status) ──────────────────────────────────────
// Gera o HTML do ecrã de bloqueio consoante o estado.

function _subRenderBlockScreen(status) {
  const card = document.getElementById('sub-block-card');
  if (!card) return;

  const isExpired   = status === 'expired';
  const isSuspended = status === 'suspended';

  const iconClass = isExpired ? 'expired' : 'suspended';
  const icon      = isExpired ? 'ti-clock-off' : 'ti-ban';
  const title     = isExpired   ? 'Assinatura Expirada' : 'Conta Suspensa';
  const msg       = isExpired
    ? 'O seu período de acesso terminou.\nRenove a sua assinatura para continuar a utilizar o Korvex.'
    : 'A sua conta encontra-se temporariamente suspensa.\nCaso considere existir algum erro, contacte o suporte.';

  const primaryBtn = isExpired
    ? `<button class="sub-block-btn primary" onclick="_subHandleRenew()">
        <i class="ti ti-credit-card"></i> Renovar Agora
       </button>`
    : `<button class="sub-block-btn primary" onclick="_subHandleSupport()">
        <i class="ti ti-headset"></i> Contactar Suporte
       </button>`;

  const supportBlock = isExpired ? '' : `
    <div class="sub-block-support">
      <p>Suporte</p>
      <a href="mailto:korvexsuporte@gmail.com" target="_blank">
        <i class="ti ti-mail" style="font-size:13px;color:var(--k-muted)"></i>
        korvexsuporte@gmail.com
      </a>
      <a href="https://wa.me/258834719829" target="_blank">
        <i class="ti ti-brand-whatsapp" style="font-size:13px;color:#22c55e"></i>
        +258 834719829
      </a>
    </div>`;

  card.innerHTML = `
    <div class="sub-block-logo">
      <img src="assets/logo.png" alt="Korvex" class="sub-block-logo-img">
    </div>
    <div class="sub-block-status-icon ${iconClass}"><i class="ti ${icon}"></i></div>
    <div class="sub-block-title">${title}</div>
    <div class="sub-block-msg">${msg.replace(/\n/g, '<br>')}</div>
    ${supportBlock}
    <div class="sub-block-actions">
      ${primaryBtn}
      <button class="sub-block-btn" onclick="_subHandleChangePassword()">
        <i class="ti ti-key"></i> Alterar Senha
      </button>
      <button class="sub-block-btn danger" onclick="authDoLogout()">
        <i class="ti ti-logout"></i> Terminar Sessão
      </button>
    </div>
  `;
}

// ── _subEnforceBlock() ──────────────────────────────────────────────────
// Ponto central de bloqueio. Chamado sempre que canAccess() = false.

function _subEnforceBlock() {
  const status = SubscriptionService.getStatus(); // 'expired' | 'suspended'

  console.warn(`[SubBlock] Acesso bloqueado — estado: ${status}`);

  // 1. Limpar editor
  _subClearEditor();

  // 2. Fechar painéis
  _subCloseAllPanels();

  // 3. Desconectar canais
  _subDisconnectChannels();

  // 4. Esconder editor, esconder auth
  const appEl      = document.getElementById('app');
  const authScreen = document.getElementById('auth-screen');
  if (appEl)      appEl.style.display      = 'none';
  if (authScreen) authScreen.classList.add('hidden');

  // 5. Renderizar e mostrar ecrã de bloqueio
  _subRenderBlockScreen(status);
  const blockScreen = document.getElementById('sub-block-screen');
  if (blockScreen) blockScreen.classList.remove('hidden');
}

// ── _subReleaseBlock() ──────────────────────────────────────────────────
// Chamado quando a subscrição é renovada (plan=active ou trial válido).
// Esconde o ecrã de bloqueio e devolve acesso ao editor.

function _subReleaseBlock() {
  const blockScreen = document.getElementById('sub-block-screen');
  if (blockScreen) blockScreen.classList.add('hidden');
  console.info('[SubBlock] Bloqueio levantado — acesso restaurado.');
  // O editor é re-inicializado via _authUpdateUI/onAuthChange no próximo ciclo
}

// ── Acções dos botões do ecrã de bloqueio ──────────────────────────────

function _subHandleRenew() {
  RenewPanel.open();
}

function _subHandleSupport() {
  window.open('https://wa.me/258834719829?text=A+minha+conta+Korvex+está+suspensa.+Podem+ajudar?', '_blank');
}

function _subHandleChangePassword() {
  // Usa a infra do AuthService — abre ecrã de auth e activa modo "recuperar senha"
  const blockScreen = document.getElementById('sub-block-screen');
  const authScreen  = document.getElementById('auth-screen');
  if (blockScreen) blockScreen.classList.add('hidden');
  if (authScreen)  {
    authScreen.classList.remove('hidden');
    // Mostrar aba de login para que o utilizador possa usar "recuperar senha"
    authShowTab('login');
  }
}

/* ══════════════════════════════════════════════════════════════════════
   FASE 3.3 — Painel Administrativo Korvex
   ────────────────────────────────────────────────────────────────────
   ADMIN_EMAILS  — lista de emails com acesso ao painel.
   AdminService  — operações Firestore: pesquisa, logs, gestão subs.
   AdminPanel    — controlador de UI: tabs, cards, formulários.

   Estrutura Firestore:
     admin_logs/{logId}  → { adminEmail, targetUid, targetEmail,
                              action, days, reason, createdAt }
   ══════════════════════════════════════════════════════════════════════ */
