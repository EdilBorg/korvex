const AuthService = (() => {

  /**
   * Regista um novo utilizador com email + password.
   * @returns {Promise<{user, error}>}
   */
  async function register(email, password) {
    const a = FirebaseCore.getAuth();
    if (!a) return { user: null, error: 'Firebase não inicializado' };
    try {
      const cred = await a.createUserWithEmailAndPassword(email, password);
      // [FLIGHT RECORDER]
      if (typeof korvexFlightRecorder !== 'undefined') {
        korvexFlightRecorder.recordAuth('register', {
          uid: cred.user.uid,
          email: cred.user.email,
          authenticated: true,
          success: true
        });
      }
      return { user: cred.user, error: null };
    } catch (e) {
      console.error('[TRACE ERROR] AuthService.register', e);
      // [FLIGHT RECORDER]
      if (typeof korvexFlightRecorder !== 'undefined') {
        korvexFlightRecorder.recordAuth('register', {
          email,
          authenticated: false,
          error: e.message,
          success: false
        });
      }
      return { user: null, error: e.message };
    }
  }

  /**
   * Autentica um utilizador existente.
   * @returns {Promise<{user, error}>}
   */
  async function login(email, password) {
    const a = FirebaseCore.getAuth();
    if (!a) return { user: null, error: 'Firebase não inicializado' };
    try {
      const cred = await a.signInWithEmailAndPassword(email, password);
      // [FLIGHT RECORDER]
      if (typeof korvexFlightRecorder !== 'undefined') {
        korvexFlightRecorder.recordAuth('login', {
          uid: cred.user.uid,
          email: cred.user.email,
          authenticated: true,
          success: true
        });
      }
      return { user: cred.user, error: null };
    } catch (e) {
      console.error('[TRACE ERROR] AuthService.login', e);
      // [FLIGHT RECORDER]
      if (typeof korvexFlightRecorder !== 'undefined') {
        korvexFlightRecorder.recordAuth('login', {
          email,
          authenticated: false,
          error: e.message,
          success: false
        });
      }
      return { user: null, error: e.message };
    }
  }

  /**
   * Termina a sessão do utilizador actual.
   * @returns {Promise<{error}>}
   */
  async function logout() {
    const a = FirebaseCore.getAuth();
    if (!a) return { error: 'Firebase não inicializado' };
    try {
      const prevUser = a.currentUser;
      await a.signOut();
      // [FLIGHT RECORDER]
      if (typeof korvexFlightRecorder !== 'undefined') {
        korvexFlightRecorder.recordAuth('logout', {
          uid: prevUser ? prevUser.uid : null,
          email: prevUser ? prevUser.email : null,
          authenticated: false,
          success: true
        });
      }
      return { error: null };
    } catch (e) {
      console.error('[TRACE ERROR] AuthService.logout', e);
      // [FLIGHT RECORDER]
      if (typeof korvexFlightRecorder !== 'undefined') {
        korvexFlightRecorder.recordAuth('logout', {
          authenticated: true,
          error: e.message,
          success: false
        });
      }
      return { error: e.message };
    }
  }

  /**
   * Devolve o utilizador actualmente autenticado (ou null).
   * @returns {firebase.User | null}
   */
  function currentUser() {
    const a = FirebaseCore.getAuth();
    return a ? a.currentUser : null;
  }

  /**
   * Verifica se existe um utilizador autenticado.
   * @returns {boolean}
   */
  function isAuthenticated() {
    return currentUser() !== null;
  }

  /**
   * Regista um callback para mudanças de estado de autenticação.
   * Retorna a função unsubscribe.
   * @param {function} callback  fn(user | null)
   * @returns {function} unsubscribe
   */
  function onAuthChange(callback) {
    const a = FirebaseCore.getAuth();
    if (!a) {
      // Stub: invoca callback com null imediatamente
      callback(null);
      return () => {};
    }
    // [FLIGHT RECORDER]
    const wrappedCallback = (user) => {
      if (typeof korvexFlightRecorder !== 'undefined') {
        korvexFlightRecorder.recordAuth('onAuthStateChanged', {
          uid: user ? user.uid : null,
          email: user ? user.email : null,
          authenticated: user !== null
        });
      }
      callback(user);
    };
    return a.onAuthStateChanged(wrappedCallback);
  }

  /**
   * Devolve o userId do utilizador actual (ou 'local' como fallback).
   * Utilizado por FlowRepository para preencher o campo userId.
   */
  function getUserId() {
    const u = currentUser();
    return u ? u.uid : 'local';
  }

  /**
   * Devolve o email do utilizador actual (ou null).
   */
  function getEmail() {
    const u = currentUser();
    return u ? u.email : null;
  }

  return {
    register,
    login,
    logout,
    currentUser,
    isAuthenticated,
    onAuthChange,
    getUserId,
    getEmail,
  };
})();

/* ═══════════════════════════════════════════════
   KORVEX FLOW BUILDER  —  Professional Engine
   Inspired by BotPro for Mozambique & Lusophone Africa
   ═══════════════════════════════════════════════

   FASE 2.4 — PERSISTÊNCIA PROFISSIONAL DOS FLUXOS
   ─────────────────────────────────────────────────
   Arquitectura de dados isolada e preparada para Firebase.

   Módulos:
     FlowSerializer  — serializar / deserializar fluxos
     FlowValidator   — validar integridade dos dados
     FlowRepository  — fonte única de verdade do fluxo activo
     FlowStorage     — persistência (localStorage → Firebase-ready)

   Nenhuma alteração visual foi feita nesta fase.
   ═══════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════
   FlowSerializer
   Responsável por converter o estado interno em estruturas
   canónicas e vice-versa.  Toda a serialização passa aqui.
   ══════════════════════════════════════════════════════════ */

function authShowTab(tab) {
  const isLogin = tab === 'login';
  document.getElementById('auth-panel-login').style.display    = isLogin ? '' : 'none';
  document.getElementById('auth-panel-register').style.display = isLogin ? 'none' : '';
  document.getElementById('auth-tab-login').classList.toggle('active', isLogin);
  document.getElementById('auth-tab-register').classList.toggle('active', !isLogin);
  // Limpar erros ao trocar aba
  document.getElementById('auth-login-err').classList.remove('show');
  document.getElementById('auth-reg-err').classList.remove('show');
}

function _authSetError(elId, msg) {
  const el = document.getElementById(elId);
  el.textContent = msg;
  el.classList.add('show');
}

function _authClearError(elId) {
  document.getElementById(elId).classList.remove('show');
}

function _authFriendlyError(msg) {
  if (!msg) return 'Erro desconhecido.';
  if (msg.includes('invalid-email') || msg.includes('badly formatted'))
    return 'Email inválido. Verifique o formato.';
  if (msg.includes('user-not-found') || msg.includes('no user record'))
    return 'Utilizador não encontrado.';
  if (msg.includes('wrong-password') || msg.includes('invalid-credential') || msg.includes('INVALID_LOGIN_CREDENTIALS'))
    return 'Palavra-passe incorrecta.';
  if (msg.includes('email-already-in-use'))
    return 'Este email já está registado. Faça login.';
  if (msg.includes('weak-password') || msg.includes('at least 6'))
    return 'A palavra-passe deve ter pelo menos 6 caracteres.';
  if (msg.includes('too-many-requests'))
    return 'Demasiadas tentativas. Aguarde e tente novamente.';
  if (msg.includes('network-request-failed') || msg.includes('network'))
    return 'Sem ligação à internet. Verifique a sua conexão.';
  return msg;
}

async function authDoLogin() {
  const email = document.getElementById('auth-login-email').value.trim();
  const pass  = document.getElementById('auth-login-pass').value;
  _authClearError('auth-login-err');

  if (!email || !pass) {
    _authSetError('auth-login-err', 'Preencha o email e a palavra-passe.');
    return;
  }

  const btn = document.getElementById('auth-login-btn');
  btn.disabled = true;
  btn.textContent = 'A entrar…';

  const { user, error } = await AuthService.login(email, pass);

  btn.disabled = false;
  btn.textContent = 'Entrar';

  if (error) {
    _authSetError('auth-login-err', _authFriendlyError(error));
  } else if (user) {
    // ✅ REFACTOR: Executar handleAuthenticatedUser IMEDIATAMENTE
    // Não esperar pelo onAuthStateChanged — a UI responde instantaneamente
    handleAuthenticatedUser(user);
  }
}

async function authDoRegister() {
  const email = document.getElementById('auth-reg-email').value.trim();
  const pass  = document.getElementById('auth-reg-pass').value;
  const cb    = document.getElementById('auth-terms-cb');
  _authClearError('auth-reg-err');

  // FASE 2.7 — Validar aceitação dos Termos antes de criar conta
  if (!cb || !cb.checked) {
    _authSetError('auth-reg-err', 'É necessário aceitar os Termos de Uso e a Política de Privacidade.');
    return;
  }

  if (!email || !pass) {
    _authSetError('auth-reg-err', 'Preencha o email e a palavra-passe.');
    return;
  }
  if (pass.length < 6) {
    _authSetError('auth-reg-err', 'A palavra-passe deve ter pelo menos 6 caracteres.');
    return;
  }

  const btn = document.getElementById('auth-reg-btn');
  btn.disabled = true;
  btn.textContent = 'A criar conta…';

  const { user, error } = await AuthService.register(email, pass);

  btn.disabled = false;
  btn.textContent = 'Criar Conta';

  if (error) {
    _authSetError('auth-reg-err', _authFriendlyError(error));
    if (cb) btn.disabled = !cb.checked; // restaurar estado correcto
    return;
  }

  // FASE 2.7 — Registar aceitação dos Termos no Firestore
  if (user) {
    const db = typeof FirebaseCore !== 'undefined' ? FirebaseCore.getDb() : null;
    const termsVersion = typeof CURRENT_TERMS_VERSION !== 'undefined' ? CURRENT_TERMS_VERSION : '2026.1';
    if (db) {
      try {
        await db.collection('admin_users').doc(user.uid).set({
          acceptedTerms:        true,
          acceptedTermsVersion: termsVersion,
          acceptedAt:           Date.now(),
        }, { merge: true });
        console.info('[Terms] Aceitação registada para:', user.email, '| versão:', termsVersion);
      } catch(e) {
        console.error('[TRACE ERROR] Terms.register', e);
        console.warn('[Terms] Erro ao registar aceitação dos termos:', e.message);
      }
    }
    // ✅ REFACTOR: Executar handleAuthenticatedUser IMEDIATAMENTE
    // Não esperar pelo onAuthStateChanged — a UI responde instantaneamente
    handleAuthenticatedUser(user);
  }
}

async function authDoLogout() {
  await AuthService.logout();
  // ✅ REFACTOR: Executar handleLogout IMEDIATAMENTE
  // Não esperar pelo onAuthStateChanged — a UI responde instantaneamente
  handleLogout();
}

/* ═══════════════════════════════════════════════════════════════════════════════════════
   ✅ REFACTOR: AUTENTICAÇÃO HÍBRIDA — Arquitetura de Inicialização
   ───────────────────────────────────────────────────────────────────────────────────────
   
   Objetivo: Resposta imediata da UI após login, mantendo Firebase como fonte de verdade.
   
   • handleAuthenticatedUser(user)  → Inicialização centralizada do utilizador autenticado
   • handleLogout()                 → Limpeza centralizada após logout
   • onAuthChange (em app.js)       → Apenas sincronização, sem lógica duplicada
   
   Fluxo:
     1. Botão Entrar → authDoLogin() → AuthService.login() sucede
     2. handleAuthenticatedUser(user) chamada IMEDIATAMENTE (UI responde já)
     3. onAuthChange dispara → também chama handleAuthenticatedUser(user)
     4. Guard: _authInitialized previne duplicação de inicializações
   
   ═══════════════════════════════════════════════════════════════════════════════════════ */

let _authInitialized = false;
let _lastInitializedUserId = null;

/**
 * ✅ Função centralizada: ÚNICA responsável pela inicialização do utilizador autenticado.
 * Chamada em dois pontos:
 *   1. Imediatamente após signInWithEmailAndPassword suceder (resposta imediata)
 *   2. Quando onAuthStateChanged dispara (sincronização com Firebase)
 * 
 * Guard: _authInitialized previne que a sequência inteira execute mais de uma vez.
 * 
 * @param {firebase.User} user — utilizador autenticado
 */
async function handleAuthenticatedUser(user) {
  if (!user) {
    console.warn('[handleAuthenticatedUser] Utilizador nulo — nada a fazer');
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────────────
  // 1. Detecção de mudança de conta (limpar cache entre contas)
  // ─────────────────────────────────────────────────────────────────────────────────
  if (_lastInitializedUserId !== null && _lastInitializedUserId !== user.uid) {
    console.info('[Auth] Mudança de conta detectada — limpando cache...');
    _authInitialized = false;
    _canvasReady = false;
    FlowRepository.cancelPendingSave();
    nodes = []; edges = [];
    sel.clear(); activeId = null;
    if (typeof undoStack !== 'undefined') { undoStack = []; redoStack = []; }
    SubscriptionService.setCurrentEmail(null);
    if (typeof ConnectionService !== 'undefined') ConnectionService.destroy();
    if (typeof InboxView !== 'undefined') InboxView.destroy();
    if (typeof DashboardMain !== 'undefined') DashboardMain.destroy();
    try { localStorage.setItem('korvex_v2:index', '[]'); } catch(e) {}
  }

  _lastInitializedUserId = user.uid;

  // ─────────────────────────────────────────────────────────────────────────────────
  // 2. Guard: Se já inicializado para este utilizador, apenas sincronizar (não duplicar)
  // ─────────────────────────────────────────────────────────────────────────────────
  if (_authInitialized && _lastInitializedUserId === user.uid) {
    console.info('[Auth] Sessão já inicializada para:', user.email, '— apenas sincronizando com Firebase');
    _authUpdateUI(user); // Apenas sincronizar a UI, sem reinicializar serviços
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────────────
  // 3. Atualizar UI — esconder auth-screen, mostrar app
  // ─────────────────────────────────────────────────────────────────────────────────
  _authUpdateUI(user);
  console.log('[handleAuthenticatedUser] _authUpdateUI terminou');

  // ─────────────────────────────────────────────────────────────────────────────────
  // 4. Marcar como inicializado (antes de qualquer await para evitar race conditions)
  // ─────────────────────────────────────────────────────────────────────────────────
  _authInitialized = true;

  // ─────────────────────────────────────────────────────────────────────────────────
  // 5. Configurar serviço de subscrição
  // ─────────────────────────────────────────────────────────────────────────────────
  SubscriptionService.setCurrentEmail(user.email);
  console.log('[handleAuthenticatedUser] setCurrentEmail OK');

  let sub;

  // BUGFIX-02.4 — verificação de admin SÍNCRONA antes de qualquer await.
  const _isSuperAdmin = (user.email && user.email.toLowerCase().trim() === SUPER_ADMIN_EMAIL)
                     || user.uid === SUPER_ADMIN_UID;

  if (_isSuperAdmin) {
    AdminGuard.provision(user); // fire-and-forget
    AdminGuard._forceCache(user.uid);
    sub = {
      uid:           user.uid,
      plan:          'admin',
      trialUsed:     false,
      expiresAt:     null,
      createdAt:     Date.now(),
      updatedAt:     Date.now(),
      daysRemaining: Infinity,
    };
    console.info('[SubscriptionService] super_admin — acesso permanente:', user.email);
  } else {
    const isOtherAdmin = await AdminGuard.check(user.uid);
    if (isOtherAdmin) {
      sub = {
        uid:           user.uid,
        plan:          'admin',
        trialUsed:     false,
        expiresAt:     null,
        createdAt:     Date.now(),
        updatedAt:     Date.now(),
        daysRemaining: Infinity,
      };
      console.info('[SubscriptionService] admin (Firestore) — acesso permanente:', user.email);
    }
  }

  if (!sub) {
    sub = await SubscriptionService.get(user.uid);
    if (!sub) {
      console.info('[SubscriptionService] Sem subscription — a criar trial para:', user.uid);
      sub = await SubscriptionService.createDefault(user.uid);

      if (!sub) {
        console.warn('[SubscriptionService] Firestore indisponível — trial local temporário criado.');
        const now = Date.now();
        sub = {
          uid:           user.uid,
          plan:          'trial',
          trialUsed:     true,
          expiresAt:     now + 3 * 24 * 60 * 60 * 1000,
          createdAt:     now,
          updatedAt:     now,
          daysRemaining: 3,
          _local:        true,
        };
        SubscriptionService._setCachedPublic(sub);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────────
  // 6. Renderizar subscrição na UI
  // ─────────────────────────────────────────────────────────────────────────────────
  SubscriptionService.renderBadge(sub);
  console.log('[handleAuthenticatedUser] renderBadge OK');

  SubDashboard.render(user);
  console.log('[handleAuthenticatedUser] Dashboard render OK');

  // ─────────────────────────────────────────────────────────────────────────────────
  // 7. Inicializar Dashboard premium (se definido)
  // ─────────────────────────────────────────────────────────────────────────────────
  if (typeof DashboardMain !== 'undefined') {
    DashboardMain.init(user.uid);
  }

  // ─────────────────────────────────────────────────────────────────────────────────
  // 8. Inicializar ConnectionService (WhatsApp)
  // ─────────────────────────────────────────────────────────────────────────────────
  if (typeof ConnectionService !== 'undefined') {
    ConnectionService.init(user.uid);
    console.log('[handleAuthenticatedUser] ConnectionService OK');
  }

  // ─────────────────────────────────────────────────────────────────────────────────
  // 9. Inicializar Inbox (observadora)
  // ─────────────────────────────────────────────────────────────────────────────────
  if (typeof InboxView !== 'undefined') {
    InboxView.init(user.uid);
    console.log('[handleAuthenticatedUser] InboxView OK');
  }

  // ─────────────────────────────────────────────────────────────────────────────────
  // 10. Verificar acesso à subscrição (bloquear se expirada/suspensa)
  // ─────────────────────────────────────────────────────────────────────────────────
  if (!SubscriptionService.canAccess()) {
    _subEnforceBlock();
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────────────
  // 11. Mostrar app após verificação de subscrição
  // ─────────────────────────────────────────────────────────────────────────────────
  document.getElementById('app').style.display = '';
  console.log('[handleAuthenticatedUser] APP VISÍVEL');

  // ─────────────────────────────────────────────────────────────────────────────────
  // 12. Inicializar FlowRepository (carrega fluxos do Firestore)
  // ─────────────────────────────────────────────────────────────────────────────────
  console.log('[handleAuthenticatedUser] FlowRepository.init START');
  const result = await FlowRepository.init();
  console.log('[handleAuthenticatedUser] FlowRepository.init END', {
    restored: result?.restored,
    nodes: result?.nodes?.length,
    edges: result?.edges?.length
  });

  if (result.restored) {
    nodes = result.nodes;
    edges = result.edges;
    _rebuildIndex();
    _syncCounters();
    push();
  } else {
    nodes = [];
    edges = [];
    _rebuildIndex();
    _syncCounters();
  }

  // ─────────────────────────────────────────────────────────────────────────────────
  // 13. Preparar canvas para renderização
  // ─────────────────────────────────────────────────────────────────────────────────
  panX = 80; panY = 40; zoom = 0.82;
  setTimeout(() => {
    render(); updateTransform(); drawMini();
    _canvasReady = true;
  }, 120);

  console.info('[handleAuthenticatedUser] Inicialização completa para:', user.email);
}

/**
 * ✅ Função centralizada: ÚNICA responsável pela limpeza após logout.
 * Chamada em dois pontos:
 *   1. Imediatamente após AuthService.logout() suceder (resposta imediata)
 *   2. Quando onAuthStateChanged dispara user=null (sincronização com Firebase)
 * 
 * Guard: Apenas executa se _authInitialized === true para evitar limpeza duplicada.
 */
function handleLogout() {
  if (!_authInitialized) {
    console.info('[handleLogout] Nenhuma sessão ativa — nada a fazer');
    return;
  }

  console.info('[handleLogout] A desconectar utilizador:', _lastInitializedUserId);

  // ─────────────────────────────────────────────────────────────────────────────────
  // 1. Marcar como desconectado (evita re-execução)
  // ─────────────────────────────────────────────────────────────────────────────────
  _authInitialized = false;
  _lastInitializedUserId = null;

  // ─────────────────────────────────────────────────────────────────────────────────
  // 2. Atualizar UI — mostrar auth-screen, esconder app
  // ─────────────────────────────────────────────────────────────────────────────────
  _authUpdateUI(null);

  // ─────────────────────────────────────────────────────────────────────────────────
  // 3. Resetar estado do editor
  // ─────────────────────────────────────────────────────────────────────────────────
  _canvasReady = false;
  FlowRepository.cancelPendingSave();
  nodes = []; edges = [];
  sel.clear(); activeId = null;
  if (typeof undoStack !== 'undefined') { undoStack = []; redoStack = []; }

  // ─────────────────────────────────────────────────────────────────────────────────
  // 4. Limpar serviços
  // ─────────────────────────────────────────────────────────────────────────────────
  SubscriptionService.setCurrentEmail(null);
  if (typeof ConnectionService !== 'undefined') ConnectionService.destroy();
  if (typeof InboxView !== 'undefined') InboxView.destroy();
  if (typeof DashboardMain !== 'undefined') DashboardMain.destroy();

  // ─────────────────────────────────────────────────────────────────────────────────
  // 5. Limpar cache local
  // ─────────────────────────────────────────────────────────────────────────────────
  try { localStorage.setItem('korvex_v2:index', '[]'); } catch(e) {}

  console.info('[handleLogout] Logout completo');
}

/* ══════════════════════════════════════════════════════════════════════
   FASE 3.1 — SubscriptionService
   ────────────────────────────────────────────────────────────────────
   Gere o estado de assinatura de cada utilizador no Firestore.

   Estrutura Firestore:
     workspaces/{uid}/subscription/current

   Documento:
     { uid, plan, trialUsed, expiresAt, createdAt, updatedAt, daysRemaining }

   Planos:
     trial      → gratuito, 3 dias desde o registo
     active     → assinatura paga activa
     expired    → expirado (trial ou pago)
     suspended  → bloqueado pelo administrador

   Acesso activo:  plan === 'trial' || plan === 'active'
   ─────────────────────────────────────────────────────────────────────
   Métodos públicos:
     createDefault(uid)       → cria subscrição trial inicial
     get(uid)                 → devolve documento atual (ou null)
     isActive(uid)            → true se trial ou active
     getDaysRemaining(uid)    → dias inteiros restantes (mín. 0)
     extend(uid, days)        → adiciona dias à expiresAt
     expire(uid)              → força plan='expired'
     suspend(uid)             → força plan='suspended'
     activate(uid)            → força plan='active' + 30 dias
   ══════════════════════════════════════════════════════════════════════ */