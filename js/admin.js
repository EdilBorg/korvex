/* ══════════════════════════════════════════════════════════════════════
   BUGFIX-02.3 — AdminGuard
   ────────────────────────────────────────────────────────────────────
   Substitui emails hardcoded por verificação Firestore na coleção:
     admins/{uid}  →  { uid, email, role, createdAt }

   Cache em memória por sessão — evita leituras repetidas.
   Auto-provisiona korvexsuporte@gmail.com como super_admin no login.

   API pública:
     AdminGuard.check(uid)        → Promise<boolean>
     AdminGuard.checkEmail(email) → Promise<boolean>  (usa uid da sessão)
     AdminGuard.isSuperAdmin(uid) → Promise<boolean>
     AdminGuard.getCached(uid)    → boolean | null (síncrono, pode ser null)
     AdminGuard.invalidate()      → limpa cache (após logout)
     AdminGuard.provision(user)   → garante que super_admin existe
   ══════════════════════════════════════════════════════════════════════ */

// ── BUGFIX-02.4 — Sistema híbrido: hardcoded fallback + Firestore ──────
// Super admin reconhecido imediatamente via email/uid hardcoded.
// Administradores adicionais suportados via coleção admins/{uid}.
const SUPER_ADMIN_EMAIL = 'korvexsuporte@gmail.com';
const SUPER_ADMIN_UID   = 'R4Oy03GeNKbk5ucpYdNAFQoXB6p2';

// ── FASE 4.2 — Planos oficiais Korvex (valores reais em MT) ────────────
// Receita SÓ é incrementada quando um destes planos é aplicado através
// do botão rápido do painel. Nunca calculado proporcionalmente.
const PLAN_PRICES = { 30: 800, 60: 1600, 90: 2400 };

const AdminGuard = (() => {
  // Cache: uid → { isAdmin: bool, role: string, ts: number }
  const _cache = new Map();
  const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

  // Pré-carregar super_admin no cache imediatamente (sem Firestore)
  _cache.set(SUPER_ADMIN_UID, { isAdmin: true, role: 'super_admin', ts: Date.now() });

  function _db() { return FirebaseCore.getDb(); }

  // ── Verificação síncrona imediata: é super_admin por uid ou email? ──
  function _isSuperAdminHardcoded(uid, email) {
    if (uid  && uid  === SUPER_ADMIN_UID)                          return true;
    if (email && email.toLowerCase().trim() === SUPER_ADMIN_EMAIL) return true;
    return false;
  }

  // ── Verifica admin: hardcoded primeiro, Firestore como extensão ─────
  async function check(uid, email) {
    if (!uid) return false;
    // Fallback imediato para super_admin — nunca depende de Firestore
    if (_isSuperAdminHardcoded(uid, email)) {
      _cache.set(uid, { isAdmin: true, role: 'super_admin', ts: Date.now() });
      return true;
    }
    // Para outros admins: verificar cache, depois Firestore
    const cached = _cache.get(uid);
    if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.isAdmin;
    const db = _db();
    if (!db) return false;
    try {
      const snap = await db.collection('admins').doc(uid).get();
      const isAdmin = snap.exists;
      const role = isAdmin ? (snap.data().role || 'admin') : null;
      _cache.set(uid, { isAdmin, role, ts: Date.now() });
      return isAdmin;
    } catch(e) {
      console.warn('[AdminGuard] Erro ao verificar admin:', e.message);
      return false;
    }
  }

  // ── Verifica se uid é super_admin ──────────────────────────────────
  async function isSuperAdmin(uid) {
    if (!uid) return false;
    if (uid === SUPER_ADMIN_UID) return true;
    const cached = _cache.get(uid);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      return cached.isAdmin && cached.role === 'super_admin';
    }
    const db = _db();
    if (!db) return false;
    try {
      const snap = await db.collection('admins').doc(uid).get();
      if (!snap.exists) return false;
      const role = snap.data().role;
      _cache.set(uid, { isAdmin: true, role, ts: Date.now() });
      return role === 'super_admin';
    } catch { return false; }
  }

  // ── Verificação síncrona via cache ─────────────────────────────────
  // Super_admin retorna true imediatamente (cache pré-carregado).
  // Outros admins retornam null se cache não carregado ainda.
  function getCached(uid) {
    if (!uid) return false;
    if (uid === SUPER_ADMIN_UID) return true; // sempre true, sem depender de cache
    const cached = _cache.get(uid);
    if (!cached || Date.now() - cached.ts >= CACHE_TTL) return null;
    return cached.isAdmin;
  }

  // ── Limpar cache (logout) — preserva super_admin hardcoded ─────────
  function invalidate() {
    _cache.clear();
    // Re-seed super_admin para que o próximo login seja imediato
    _cache.set(SUPER_ADMIN_UID, { isAdmin: true, role: 'super_admin', ts: Date.now() });
  }

  // ── Auto-provisionar admins/{uid} para super_admin ─────────────────
  // Garante que o doc existe mesmo que tenha sido apagado acidentalmente.
  async function provision(user) {
    if (!user?.uid || !user?.email) return;
    // Apenas para super_admin (uid ou email)
    if (!_isSuperAdminHardcoded(user.uid, user.email)) return;
    const db = _db();
    if (!db) {
      console.warn('[AdminGuard] Firestore indisponível — provision ignorado (acesso garantido por hardcoded).');
      return;
    }
    try {
      const ref = db.collection('admins').doc(SUPER_ADMIN_UID);
      await ref.set({
        uid:       SUPER_ADMIN_UID,
        email:     SUPER_ADMIN_EMAIL,
        role:      'super_admin',
        createdAt: Date.now(),
      }, { merge: true });
      _cache.set(SUPER_ADMIN_UID, { isAdmin: true, role: 'super_admin', ts: Date.now() });
      console.info('[AdminGuard] super_admin provisionado/verificado em admins/');
    } catch(e) {
      console.warn('[AdminGuard] Erro ao provisionar (acesso garantido por hardcoded):', e.message);
    }
  }

  // ── Forçar cache imediatamente (sem leitura Firestore) ───────────────
  // Usado pelo super_admin para garantir acesso mesmo antes de provision() completar.
  function _forceCache(uid) {
    _cache.set(uid, { isAdmin: true, role: 'super_admin', ts: Date.now() });
  }

  return { check, isSuperAdmin, getCached, invalidate, provision, _forceCache };
})();

// ── _isAdmin(email) — compatibilidade síncrona ─────────────────────────
// Super_admin reconhecido imediatamente via email hardcoded.
// Outros admins usam cache do AdminGuard.
function _isAdmin(email) {
  if (!email) return false;
  // Fallback imediato para super_admin
  if (email.toLowerCase().trim() === SUPER_ADMIN_EMAIL) return true;
  const u = AuthService.currentUser();
  if (!u) return false;
  const cached = AdminGuard.getCached(u.uid);
  return cached === true;
}

// ── _isSuperAdminEmail(email) — proteção de conta super_admin ─────────
// Usado para impedir remoção/suspensão/expiração do super_admin.
function _isSuperAdminEmail(email) {
  return !!email && email.toLowerCase().trim() === SUPER_ADMIN_EMAIL;
}

// ══════════════════════════════════════════════════════════════════════
// AdminService — operações Firestore com validação de admin
// ══════════════════════════════════════════════════════════════════════
const AdminService = (() => {

  function _db()       { return FirebaseCore.getDb(); }
  function _adminUser(){ return AuthService.currentUser(); }

  // Validar que quem chama é admin autenticado (usa cache do AdminGuard)
  async function _validateAdmin() {
    const u = _adminUser();
    if (!u) { console.error('[AdminService] Sem utilizador autenticado.'); return false; }
    const ok = await AdminGuard.check(u.uid);
    if (!ok) console.error('[AdminService] Acesso não autorizado:', u.email);
    return ok;
  }

  // ── Obter subscription de qualquer utilizador por UID ───────────────
  async function getSubByUid(uid) {
    if (!_validateAdmin()) return null;
    const db = _db();
    if (!db || !uid) return null;
    try {
      const snap = await db.collection('workspaces').doc(uid)
                           .collection('settings').doc('subscription').get();
      if (!snap.exists) return null;
      const data = snap.data();
      data.daysRemaining = Math.max(0, Math.ceil((data.expiresAt - Date.now()) / 86400000));
      return data;
    } catch(e) {
      console.error('[AdminService] getSubByUid:', e);
      return null;
    }
  }

  // ── Pesquisar utilizador por email usando auth list (workaround via admin_users) ──
  // Estratégia: o utilizador ao fazer login cria/actualiza um registo em
  //   admin_users/{uid} = { uid, email, createdAt, lastLoginAt }
  // O admin pode então pesquisar por email nessa coleção.
  async function searchByEmail(email) {
    if (!_validateAdmin()) return null;
    const db = _db();
    if (!db || !email) return null;
    try {
      const snap = await db.collection('admin_users')
                           .where('email', '==', email.trim().toLowerCase())
                           .limit(1).get();
      if (snap.empty) return null;
      const userData = snap.docs[0].data();
      const sub      = await getSubByUid(userData.uid);
      return { ...userData, subscription: sub };
    } catch(e) {
      console.error('[AdminService] searchByEmail:', e);
      return null;
    }
  }

  // ── Listar todos os utilizadores (para dashboard) ───────────────────
  async function listAllUsers() {
    if (!_validateAdmin()) return [];
    const db = _db();
    if (!db) return [];
    try {
      const snap = await db.collection('admin_users').limit(200).get();
      const users = snap.docs
        .map(d => d.data())
        // Filtrar utilizadores fantasma (sem email ou uid válido)
        .filter(u => u && u.uid && u.email && u.uid !== 'undefined' && u.email !== 'undefined' && typeof u.uid === 'string' && typeof u.email === 'string');
      // BUG FIX BUGFIX-01 — ordenar client-side
      users.sort((a, b) => (b.lastLoginAt || 0) - (a.lastLoginAt || 0));
      return users;
    } catch(e) {
      console.error('[AdminService] listAllUsers:', e);
      return [];
    }
  }

  // ── Guardar log administrativo ──────────────────────────────────────
  // FASE 4.2 — campo `amount`: valor real de receita (apenas planos oficiais
  // aplicados via botão rápido). null em todas as outras acções.
  async function _log(targetUid, targetEmail, action, days, reason, amount) {
    const db = _db();
    const u  = _adminUser();
    if (!db || !u) return;
    try {
      await db.collection('admin_logs').add({
        adminEmail:   u.email,
        targetUid,
        targetEmail,
        action,
        days:         days || null,
        reason:       reason || '',
        amount:       amount || null,
        createdAt:    Date.now(),
      });
    } catch(e) {
      console.error('[AdminService] _log:', e);
    }
  }

  // ── Carregar logs ───────────────────────────────────────────────────
  async function getLogs(limit = 50) {
    if (!_validateAdmin()) return [];
    const db = _db();
    if (!db) return [];
    try {
      const snap = await db.collection('admin_logs').limit(limit).get();
      const logs = snap.docs.map(d => d.data());
      // BUG FIX BUGFIX-01 — ordenar client-side (evita índice composto no Firestore)
      logs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return logs;
    } catch(e) {
      console.error('[AdminService] getLogs:', e);
      return [];
    }
  }

  // ── Extender dias ───────────────────────────────────────────────────
  // FASE 4.3.1 — `source`: 'quick' (botões +30/+60/+90 = planos oficiais,
  // geram receita real) ou 'manual' (campo de dias manual, NUNCA gera receita).
  // Atualização incremental O(1) — não faz rebuild
  async function extendDays(targetUid, targetEmail, days, reason, source) {
    if (!_validateAdmin()) return false;
    if (!reason || !reason.trim()) return 'reason';
    if (!days || days <= 0) return 'days';

    // Ler estado anterior para determinar delta
    const db = _db();
    if (!db) return false;
    const subBefore = await getSubByUid(targetUid);

    const ok = await SubscriptionService.extend(targetUid, days);
    if (ok) {
      const amount = (source === 'quick' && PLAN_PRICES[days]) ? PLAN_PRICES[days] : null;
      await _log(targetUid, targetEmail, `+${days} dias`, days, reason, amount);
      if (amount) await DashboardStatsService.incrementRevenue(amount);

      // FASE 4.3.1 — Atualização incremental
      // Se o usuário estava expirado e passa a ativo, ajustar breakdown
      // Caso contrário, nenhuma mudança no breakdown (apenas expiração muda)
      if (subBefore && subBefore.plan === 'suspended') {
        // Era expirado, passa a ativo no seu plano original (ou pro se não souber)
        const newPlan = subBefore.previousPlan || 'pro';
        const delta = {};
        delta.suspended = -1;
        if (newPlan === 'trial') delta.trial = 1;
        else if (newPlan === 'pro') delta.pro = 1;
        else if (newPlan === 'premium' || newPlan === 'active') delta.premium = 1;
        await DashboardStatsService.updateSubscriptionCountsIncremental(delta);
      }
      // Caso contrário, se era ativo, continua ativo — sem mudança no breakdown
    }
    return ok;
  }

  // ── Remover dias ────────────────────────────────────────────────────
  // FASE 4.3.1 — Atualização incremental O(1) — não faz rebuild
  async function removeDays(targetUid, targetEmail, days, currentDays, reason) {
    if (!_validateAdmin()) return false;
    if (!reason || !reason.trim()) return 'reason';
    if (!days || days <= 0) return 'days';
    if (_isSuperAdminEmail(targetEmail)) return 'protected';
    if (days > currentDays) return 'overflow';
    const db = _db();
    if (!db) return false;
    try {
      const ref = db.collection('workspaces').doc(targetUid)
                    .collection('settings').doc('subscription');
      const snap = await ref.get();
      if (!snap.exists) return false;
      const subData = snap.data();
      const current = subData.expiresAt;
      const newExpiry = current - days * 86400000;

      // Determinar se vai expirar
      const willExpire = newExpiry <= Date.now();
      const plan = subData.plan || 'expired';

      await ref.set({ expiresAt: newExpiry, updatedAt: Date.now(),
                      daysRemaining: Math.max(0, Math.ceil((newExpiry - Date.now()) / 86400000)) }, { merge: true });
      await _log(targetUid, targetEmail, `-${days} dias`, -days, reason);

      // FASE 4.3.1 — Atualização incremental
      if (willExpire && plan !== 'suspended') {
        // Passa a expirado
        const delta = {};
        if (plan === 'trial') delta.trial = -1;
        else if (plan === 'pro') delta.pro = -1;
        else if (plan === 'premium' || plan === 'active') delta.premium = -1;
        delta.expired = 1;
        await DashboardStatsService.updateSubscriptionCountsIncremental(delta);
      }
      // Caso contrário, apenas a data muda, sem impacto no breakdown

      return true;
    } catch(e) {
      console.error('[AdminService] removeDays:', e);
      return false;
    }
  }

  // ── Activar conta (genérico) ────────────────────────────────────────
  // FASE 4.3.1 — Atualização incremental O(1)
  async function activateAccount(targetUid, targetEmail, reason, plan = 'pro') {
    if (!_validateAdmin()) return false;
    if (!reason || !reason.trim()) return 'reason';
    
    const subBefore = await getSubByUid(targetUid);
    const oldPlan = subBefore?.plan || 'expired';
    
    const ok = await SubscriptionService.activatePlan(targetUid, plan, 30);
    if (ok) {
      const planLabel = plan === 'trial' ? 'Trial' : plan === 'pro' ? 'Pro' : 'Premium';
      await _log(targetUid, targetEmail, `Plano ${planLabel} activado`, 30, reason);
      
      // FASE 4.3.1 — Calcular delta
      const delta = {};
      // Remover do plano antigo
      if (oldPlan === 'trial') delta.trial = -1;
      else if (oldPlan === 'pro') delta.pro = -1;
      else if (oldPlan === 'premium' || oldPlan === 'active') delta.premium = -1;
      else if (oldPlan === 'suspended') delta.suspended = -1;
      else if (oldPlan === 'expired') delta.expired = -1;
      
      // Adicionar ao novo plano
      if (plan === 'trial') delta.trial = (delta.trial || 0) + 1;
      else if (plan === 'pro') delta.pro = (delta.pro || 0) + 1;
      else if (plan === 'premium') delta.premium = (delta.premium || 0) + 1;
      
      await DashboardStatsService.updateSubscriptionCountsIncremental(delta);
    }
    return ok;
  }

  // ── Activar Trial ────────────────────────────────────────────────────
  // FASE 4.3.1 — Atualização incremental O(1)
  async function activateTrial(targetUid, targetEmail, reason) {
    if (!_validateAdmin()) return false;
    if (!reason || !reason.trim()) return 'reason';
    
    const subBefore = await getSubByUid(targetUid);
    const oldPlan = subBefore?.plan || 'expired';
    
    const ok = await SubscriptionService.activatePlan(targetUid, 'trial', 3);
    if (ok) {
      await _log(targetUid, targetEmail, 'Trial activado', 3, reason);
      
      // FASE 4.3.1 — Calcular delta
      const delta = { trial: 1 };
      if (oldPlan === 'pro') delta.pro = -1;
      else if (oldPlan === 'premium' || oldPlan === 'active') delta.premium = -1;
      else if (oldPlan === 'suspended') delta.suspended = -1;
      else if (oldPlan === 'expired') delta.expired = -1;
      
      await DashboardStatsService.updateSubscriptionCountsIncremental(delta);
    }
    return ok;
  }

  // ── Activar Pro ──────────────────────────────────────────────────────
  // FASE 4.3.1 — Atualização incremental O(1)
  async function activatePro(targetUid, targetEmail, reason) {
    if (!_validateAdmin()) return false;
    if (!reason || !reason.trim()) return 'reason';
    
    const subBefore = await getSubByUid(targetUid);
    const oldPlan = subBefore?.plan || 'expired';
    
    const ok = await SubscriptionService.activatePlan(targetUid, 'pro', 30);
    if (ok) {
      await _log(targetUid, targetEmail, 'Pro activado', 30, reason);
      
      // FASE 4.3.1 — Calcular delta
      const delta = { pro: 1 };
      if (oldPlan === 'trial') delta.trial = -1;
      else if (oldPlan === 'premium' || oldPlan === 'active') delta.premium = -1;
      else if (oldPlan === 'suspended') delta.suspended = -1;
      else if (oldPlan === 'expired') delta.expired = -1;
      
      await DashboardStatsService.updateSubscriptionCountsIncremental(delta);
    }
    return ok;
  }

  // ── Activar Premium ──────────────────────────────────────────────────
  // FASE 4.3.1 — Atualização incremental O(1)
  async function activatePremium(targetUid, targetEmail, reason) {
    if (!_validateAdmin()) return false;
    if (!reason || !reason.trim()) return 'reason';
    
    const subBefore = await getSubByUid(targetUid);
    const oldPlan = subBefore?.plan || 'expired';
    
    const ok = await SubscriptionService.activatePlan(targetUid, 'premium', 30);
    if (ok) {
      await _log(targetUid, targetEmail, 'Premium activado', 30, reason);
      
      // FASE 4.3.1 — Calcular delta
      const delta = { premium: 1 };
      if (oldPlan === 'trial') delta.trial = -1;
      else if (oldPlan === 'pro') delta.pro = -1;
      else if (oldPlan === 'suspended') delta.suspended = -1;
      else if (oldPlan === 'expired') delta.expired = -1;
      
      await DashboardStatsService.updateSubscriptionCountsIncremental(delta);
    }
    return ok;
  }

  // ── Suspender conta ─────────────────────────────────────────────────
  // ── Suspender conta ─────────────────────────────────────────────────
  // FASE 4.3.1 — Atualização incremental O(1)
  async function suspendAccount(targetUid, targetEmail, reason) {
    if (!_validateAdmin()) return false;
    if (!reason || !reason.trim()) return 'reason';
    if (_isSuperAdminEmail(targetEmail)) return 'protected';
    
    const subBefore = await getSubByUid(targetUid);
    const oldPlan = subBefore?.plan || 'expired';
    
    const ok = await SubscriptionService.suspend(targetUid);
    if (ok) {
      await _log(targetUid, targetEmail, 'Conta suspensa', null, reason);
      
      // FASE 4.3.1 — Calcular delta (planoPrior → suspended)
      const delta = { suspended: 1 };
      if (oldPlan === 'trial') delta.trial = -1;
      else if (oldPlan === 'pro') delta.pro = -1;
      else if (oldPlan === 'premium' || oldPlan === 'active') delta.premium = -1;
      else if (oldPlan === 'admin') delta.admin = -1;
      else if (oldPlan === 'expired') delta.expired = -1;
      
      await DashboardStatsService.updateSubscriptionCountsIncremental(delta);
    }
    return ok;
  }

  // ── Expirar conta ───────────────────────────────────────────────────
  // FASE 4.3.1 — Atualização incremental O(1)
  async function expireAccount(targetUid, targetEmail, reason) {
    if (!_validateAdmin()) return false;
    if (!reason || !reason.trim()) return 'reason';
    if (_isSuperAdminEmail(targetEmail)) return 'protected';
    
    const subBefore = await getSubByUid(targetUid);
    const oldPlan = subBefore?.plan || 'expired';
    
    const ok = await SubscriptionService.expire(targetUid);
    if (ok) {
      await _log(targetUid, targetEmail, 'Conta expirada', null, reason);
      
      // FASE 4.3.1 — Calcular delta (planoPrior → expired/suspended)
      const delta = { expired: 1 };
      if (oldPlan === 'trial') delta.trial = -1;
      else if (oldPlan === 'pro') delta.pro = -1;
      else if (oldPlan === 'premium' || oldPlan === 'active') delta.premium = -1;
      else if (oldPlan === 'admin') delta.admin = -1;
      else if (oldPlan === 'suspended') {
        // Já estava suspenso, não muda breakdown
        return ok;
      }
      
      await DashboardStatsService.updateSubscriptionCountsIncremental(delta);
    }
    return ok;
  }

  // ── Restaurar trial ─────────────────────────────────────────────────
  // FASE 4.3.1 — Atualização incremental O(1)
  async function restoreTrial(targetUid, targetEmail, reason) {
    if (!_validateAdmin()) return false;
    if (!reason || !reason.trim()) return 'reason';
    
    const subBefore = await getSubByUid(targetUid);
    const oldPlan = subBefore?.plan || 'expired';
    
    const db = _db();
    if (!db) return false;
    try {
      const now       = Date.now();
      const expiresAt = now + 3 * 86400000;
      await db.collection('workspaces').doc(targetUid)
              .collection('settings').doc('subscription')
              .set({ plan: 'trial', trialUsed: true, expiresAt,
                    updatedAt: now, daysRemaining: 3 }, { merge: true });
      await _log(targetUid, targetEmail, 'Trial restaurado', 3, reason);
      
      // FASE 4.3.1 — Calcular delta (planoPrior → trial)
      const delta = { trial: 1 };
      if (oldPlan === 'pro') delta.pro = -1;
      else if (oldPlan === 'premium' || oldPlan === 'active') delta.premium = -1;
      else if (oldPlan === 'admin') delta.admin = -1;
      else if (oldPlan === 'suspended') delta.suspended = -1;
      else if (oldPlan === 'expired') delta.expired = -1;
      
      await DashboardStatsService.updateSubscriptionCountsIncremental(delta);
      return true;
    } catch(e) {
      console.error('[AdminService] restoreTrial:', e);
      return false;
    }
  }

  return { searchByEmail, listAllUsers, getLogs, extendDays, removeDays,
           activateAccount, activateTrial, activatePro, activatePremium,
           suspendAccount, expireAccount, restoreTrial };
})();

// ══════════════════════════════════════════════════════════════════════
// AdminPanel — controlador de UI
// ══════════════════════════════════════════════════════════════════════
const AdminPanel = (() => {

  let _currentUser = null; // utilizador admin logado

  // ── Tab navigation ──────────────────────────────────────────────────
  function setTab(tab) {
    document.querySelectorAll('.admin-tab').forEach((el, i) => {
      // FASE 2.7 — 4 tabs: dashboard, users, logs, compliance
      const tabs = ['dashboard', 'users', 'logs', 'compliance'];
      el.classList.toggle('active', tabs[i] === tab);
    });
    document.querySelectorAll('.admin-panel').forEach(el => el.classList.remove('active'));
    const panel = document.getElementById(`admin-panel-${tab}`);
    if (panel) {
      panel.classList.add('active');
      
      // AUTO REFRESH — Chamar a mesma função que o botão Atualizar usa
      if (tab === 'dashboard') {
        // Carregar dados + renderizar gráficos
        refreshDashboard();
        setTimeout(() => {
          if (typeof DashboardAdminRedesign !== 'undefined' && DashboardAdminRedesign.init) {
            DashboardAdminRedesign.init().catch(e => console.error('[Dashboard Init]', e));
          }
        }, 100);
      } else if (tab === 'users') {
        // Carregar lista de utilizadores (reutiliza refreshDashboard que carrega ambos)
        refreshDashboard();
      } else if (tab === 'logs') {
        // Carregar logs
        _loadLogs();
      } else if (tab === 'compliance') {
        // Carregar conformidade
        loadCompliancePanel();
      }
    }
  }

  // ── Open / Close ────────────────────────────────────────────────────
  function open() {
    const u = AuthService.currentUser();
    if (!u || !_isAdmin(u.email)) return;
    _currentUser = u;
    document.getElementById('admin-overlay').classList.add('open');
    // setTab('dashboard') vai chamar refreshDashboard() automaticamente
    setTab('dashboard');
  }

  function close() {
    document.getElementById('admin-overlay').classList.remove('open');
  }

  // ── Format helpers ──────────────────────────────────────────────────
  function _fmtDate(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleDateString('pt-PT', { day:'2-digit', month:'2-digit', year:'numeric' });
  }

  function _fmtDateTime(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString('pt-PT', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
  }

  function _planBadge(plan) {
    const labels = {
      trial:     'Trial',
      pro:       'Pro',
      premium:   'Premium',
      active:    'Premium',      // retrocompatibilidade
      expired:   'Expirado',
      suspended: 'Suspenso',
      admin:     'Admin'
    };
    // Mapeamento de classes CSS para os estilos visuais corretos
    const cssMap = {
      trial:     'trial',
      pro:       'pro',
      premium:   'active',       // verde
      active:    'active',       // verde
      expired:   'expired',      // cinzento
      suspended: 'suspended',    // vermelho
      admin:     'admin'         // vermelho escuro/vinho para admin
    };
    const cssClass = cssMap[plan] || plan;
    return `<span class="admin-plan-badge ${cssClass}">${labels[plan] || plan}</span>`;
  }

  // ── Formatação de moeda (MT) ─────────────────────────────────────────
  function _fmtMT(value) {
    const n = Math.round(value || 0);
    return n.toLocaleString('pt-PT') + ' MT';
  }

  // ── Dashboard ───────────────────────────────────────────────────────
  // ── PERF FIX: flag para evitar re-carregamento enquanto já está a carregar ──
  let _dashboardLoading = false;

  async function _loadDashboard(forceRefresh = false) {
    if (_dashboardLoading) return; // evita chamadas concorrentes ao trocar de tab
    _dashboardLoading = true;

    const grid = document.getElementById('admin-stats-grid');
    const list = document.getElementById('admin-all-users-list');
    
    // Mostrar loading — detectar se usa novo layout (cards individuais) ou antigo
    const hasNewLayout = document.getElementById('admin-stat-total-users') !== null;
    if (!hasNewLayout) {
      grid.innerHTML = '<div class="admin-loading">A carregar estatísticas…</div>';
    }
    list.innerHTML = '<div class="admin-loading">A carregar lista…</div>';

    try {
      // ARQUITETURA 4.3: Dashboard SEMPRE usa getStats() (leitura rápida)
      // forceRefresh=true: admin clica botão "Actualizar" explicitamente
      // Ambos os casos leem APENAS admin_stats/current (1 documento)
      // Nenhuma varredura de admin_users, nenhum loop de subscriptions
      const stats = forceRefresh
        ? await DashboardStatsService.refreshStats()
        : await DashboardStatsService.getStats();

      const b = stats.breakdown || { trial: 0, pro: 0, premium: 0, expired: 0, suspended: 0, admin: 0 };
      b.active = (b.active || 0) + (b.premium || 0);

      const updatedAt = stats.updatedAt ? _fmtDateTime(stats.updatedAt) : '—';
      
      // SE usa novo layout com cards individuais, atualizar cada elemento
      if (hasNewLayout) {
        const totalUsersEl = document.getElementById('admin-stat-total-users');
        const activeUsersEl = document.getElementById('admin-stat-active-users');
        const totalRevenueEl = document.getElementById('admin-stat-total-revenue');
        const mrrEl = document.getElementById('admin-stat-mrr');
        const trialEl = document.getElementById('admin-stat-trial');
        const expiredEl = document.getElementById('admin-stat-expired');
        
        if (totalUsersEl) totalUsersEl.textContent = stats.totalUsers;
        if (activeUsersEl) activeUsersEl.textContent = stats.activeSubscriptions;
        if (totalRevenueEl) totalRevenueEl.textContent = _fmtMT(stats.totalRevenue);
        if (mrrEl) mrrEl.textContent = _fmtMT(stats.monthlyRevenue);
        if (trialEl) trialEl.textContent = b.trial !== undefined ? b.trial : '—';
        if (expiredEl) expiredEl.textContent = stats.expiredSubscriptions;
        
        // Atualizar indicadores de mudança
        const usersChangeEl = document.getElementById('admin-stat-users-change');
        if (usersChangeEl) usersChangeEl.textContent = '+12%';
        
        const activePercentEl = document.getElementById('admin-stat-active-percent');
        if (activePercentEl && stats.totalUsers > 0) {
          const pct = Math.round((stats.activeSubscriptions / stats.totalUsers) * 100);
          activePercentEl.textContent = pct + '%';
        }
        
        const trialChangeEl = document.getElementById('admin-stat-trial-change');
        if (trialChangeEl && stats.totalUsers > 0) {
          const pct = Math.round((b.trial / stats.totalUsers) * 100);
          trialChangeEl.textContent = pct + '%';
        }
        
        const expiredChangeEl = document.getElementById('admin-stat-expired-change');
        if (expiredChangeEl && stats.totalUsers > 0) {
          const pct = Math.round((stats.expiredSubscriptions / stats.totalUsers) * 100);
          expiredChangeEl.textContent = pct + '%';
        }
      } else {
        // SENÃO usa layout antigo, preencher grid.innerHTML
        grid.innerHTML = `
          <div class="admin-stat"><div class="admin-stat-val">${stats.totalUsers}</div><div class="admin-stat-lbl">Total Utilizadores</div></div>
          <div class="admin-stat trial"><div class="admin-stat-val">${b.trial !== undefined ? b.trial : '—'}</div><div class="admin-stat-lbl">Trial</div></div>
          <div class="admin-stat active"><div class="admin-stat-val">${stats.activeSubscriptions}</div><div class="admin-stat-lbl">Assinaturas Activas</div></div>
          <div class="admin-stat expired"><div class="admin-stat-val">${stats.expiredSubscriptions}</div><div class="admin-stat-lbl">Assinaturas Expiradas</div></div>
          <div class="admin-stat suspended"><div class="admin-stat-val">${b.suspended !== undefined ? b.suspended : '—'}</div><div class="admin-stat-lbl">Suspensos</div></div>
          <div class="admin-stat revenue"><div class="admin-stat-val">${_fmtMT(stats.totalRevenue)}</div><div class="admin-stat-lbl">Receita Total</div></div>
          <div class="admin-stat revenue-month"><div class="admin-stat-val">${_fmtMT(stats.monthlyRevenue)}</div><div class="admin-stat-lbl">Receita Este Mês</div></div>
          <div style="grid-column:1/-1;text-align:right;font-size:10px;color:var(--k-muted);margin-top:4px">
            Actualizado: ${updatedAt}
            &nbsp;·&nbsp;
            <button class="admin-btn secondary" style="font-size:10px;padding:2px 8px"
              onclick="AdminPanel.refreshDashboard()">⟳ Actualizar</button>
          </div>
        `;
      }
      
      // Guardar breakdown para aba de utilizadores
      window._adminStats = stats;
      
      // Renderizar cartões de resumo na aba de utilizadores
      const summaryContainer = document.getElementById('admin-users-summary-stats');
      if (summaryContainer) {
        summaryContainer.innerHTML = `
          <div class="admin-stat"><div class="admin-stat-val">${stats.totalUsers}</div><div class="admin-stat-lbl">Total Utilizadores</div></div>
          <div class="admin-stat trial"><div class="admin-stat-val">${b.trial !== undefined ? b.trial : '—'}</div><div class="admin-stat-lbl">Trial</div></div>
          <div class="admin-stat pro"><div class="admin-stat-val">${b.pro !== undefined ? b.pro : '—'}</div><div class="admin-stat-lbl">PRO</div></div>
          <div class="admin-stat premium"><div class="admin-stat-val">${b.premium !== undefined ? b.premium : '—'}</div><div class="admin-stat-lbl">Premium</div></div>
          <div class="admin-stat expired"><div class="admin-stat-val">${b.expired !== undefined ? b.expired : '—'}</div><div class="admin-stat-lbl">Expirados</div></div>
        `;
      }

      // PERF FIX: carregar utilizadores (limit 200) sem buscar subscriptions de todos —
      // a subscription é carregada apenas ao clicar "Gerir" (lazy via openUserByUid).
      const users = await AdminService.listAllUsers();

      if (!users.length) {
        list.innerHTML = '<div class="admin-empty">Nenhum utilizador registado ainda.</div>';
        return;
      }

      // PERF FIX: carregar subscriptions em micro-batches de 10 (era all-at-once),
      // e renderizar os primeiros 10 imediatamente para resposta visual rápida.
      const VISIBLE_BATCH = 10;
      const firstSlice = users.slice(0, VISIBLE_BATCH);
      const firstSubs  = await Promise.all(firstSlice.map(u => _getSubQuiet(u.uid)));

      function _renderRow(u, s) {
        // Se for admin, usar 'admin' como plano
        let plan = u.email === SUPER_ADMIN_EMAIL ? 'admin' : (s?.plan || 'expired');
        const days = s ? Math.max(0, Math.ceil(((s.expiresAt || 0) - Date.now()) / 86400000)) : 0;
        
        // Determinar estado: Ativo, Expirado ou Suspenso
        let estado = 'Expirado';
        let estadoColor = '#F87171';
        
        if (plan === 'suspended') {
          estado = 'Suspenso';
          estadoColor = '#A78BFA';
        } else if (days > 0) {
          estado = 'Ativo';
          estadoColor = '#22C55E';
        }
        return `
          <div class="admin-users-table-row">
            <div class="admin-users-table-cell email">
              <span class="admin-users-table-label">Email</span>
              <span class="admin-users-table-value">${u.email}</span>
            </div>
            <div class="admin-users-table-cell plan">
              <span class="admin-users-table-label">Plano</span>
              ${_planBadge(plan)}
            </div>
            <div class="admin-users-table-cell dias">
              <span class="admin-users-table-label">Dias</span>
              <span class="admin-users-table-value">${days} dias</span>
            </div>
            <div class="admin-users-table-cell estado">
              <span class="admin-users-table-label">Estado</span>
              <span class="admin-users-table-value" style="color:${estadoColor}">${estado}</span>
            </div>
            <div class="admin-users-table-cell acoes">
              <button class="admin-btn secondary" style="font-size:11px;padding:4px 10px"
                onclick="AdminPanel.openUserByUid('${u.uid}','${u.email}')">Gerir</button>
            </div>
          </div>`;
      }

      // Renderizar primeiros imediatamente
      list.innerHTML = firstSlice.map((u, i) => _renderRow(u, firstSubs[i])).join('');

      // Carregar o resto em background sem bloquear o UI
      if (users.length > VISIBLE_BATCH) {
        const rest = users.slice(VISIBLE_BATCH);
        const restSubs = await Promise.all(rest.map(u => _getSubQuiet(u.uid)));
        list.innerHTML += rest.map((u, i) => _renderRow(u, restSubs[i])).join('');
      }
    } finally {
      _dashboardLoading = false;
    }
  }

  // ── Botão "Actualizar" — força refreshStats() completo ──────────────
  async function refreshDashboard() {
    _dashboardLoading = false; // reset para permitir re-entrada
    await _loadDashboard(true);
  }

  async function _getSubQuiet(uid) {
    const db = FirebaseCore.getDb();
    if (!db) return null;
    try {
      const snap = await db.collection('workspaces').doc(uid)
                           .collection('settings').doc('subscription').get();
      if (!snap.exists) return null;
      return snap.data();
    } catch { return null; }
  }

  // ── Logs ────────────────────────────────────────────────────────────
  async function _loadLogs() {
    const el = document.getElementById('admin-logs-list');
    el.innerHTML = '<div class="admin-loading">A carregar…</div>';
    const logs = await AdminService.getLogs(50);
    if (!logs.length) {
      el.innerHTML = '<div class="admin-empty">Nenhuma acção registada.</div>';
      return;
    }
    el.innerHTML = logs.map(l => `
      <div class="admin-log-row">
        <div class="admin-log-action">${l.action}</div>
        <div class="admin-log-meta" style="flex:1">
          <div>${l.targetEmail}</div>
          <div class="admin-log-reason">${l.reason}</div>
          <div style="font-size:10px">${_fmtDateTime(l.createdAt)} · por ${l.adminEmail}</div>
        </div>
      </div>`).join('');
  }

  // ── Search ──────────────────────────────────────────────────────────
  async function search() {
    const email  = (document.getElementById('admin-search-input').value || '').trim();
    const result = document.getElementById('admin-search-result');
    if (!email) { result.innerHTML = '<div class="admin-error">Insira um email.</div>'; return; }
    result.innerHTML = '<div class="admin-loading">A pesquisar…</div>';
    const user = await AdminService.searchByEmail(email);
    if (!user) {
      result.innerHTML = `<div class="admin-error">Utilizador não encontrado. Certifique-se que o utilizador fez login pelo menos uma vez.</div>`;
      return;
    }
    result.innerHTML = _buildUserCard(user.uid, user.email, user.subscription, user.createdAt);
  }

  // ── Open user by UID (from dashboard list) ──────────────────────────
  async function openUserByUid(uid, email) {
    // Abrir em tela full-screen (nova interface)
    const content = document.getElementById('admin-manage-user-content');
    if (!content) { 
      // Fallback para interface antiga se elemento não existir
      setTab('users');
      const input = document.getElementById('admin-search-input');
      if (input) input.value = email;
      const result = document.getElementById('admin-search-result');
      result.innerHTML = '<div class="admin-loading">A carregar…</div>';
      const sub = await _getSubQuiet(uid);
      result.innerHTML = _buildUserCard(uid, email, sub, sub?.createdAt);
      return;
    }
    
    // Nova interface full-screen
    content.innerHTML = '<div class="admin-loading">A carregar…</div>';
    const sub = await _getSubQuiet(uid);
    content.innerHTML = _buildUserCard(uid, email, sub, sub?.createdAt);
    
    // Ocultar tabs e mostrar painel de gestão
    const tabs = document.querySelector('.admin-tabs');
    if (tabs) tabs.style.display = 'none';
    
    const panels = document.querySelectorAll('.admin-panel');
    panels.forEach(p => p.classList.remove('active'));
    
    const managePanel = document.getElementById('admin-panel-manage-user');
    if (managePanel) managePanel.classList.add('active');
    
    // Guardar estado anterior para voltar
    window._adminPreviousPanelState = { uid, email };
  }
  
  function _closeManageUser() {
    // Restaurar estado anterior (aba de utilizadores)
    const tabs = document.querySelector('.admin-tabs');
    if (tabs) tabs.style.display = 'flex';
    
    const panels = document.querySelectorAll('.admin-panel');
    panels.forEach(p => p.classList.remove('active'));
    
    const usersPanel = document.getElementById('admin-panel-users');
    if (usersPanel) usersPanel.classList.add('active');
    
    // Restaurar input de pesquisa se existir estado anterior
    if (window._adminPreviousPanelState) {
      const input = document.getElementById('admin-search-input');
      if (input) input.value = window._adminPreviousPanelState.email;
    }
    
    // Limpar conteúdo
    const content = document.getElementById('admin-manage-user-content');
    if (content) content.innerHTML = '';
  }

  // ── Build user management card ──────────────────────────────────────
  function _buildUserCard(uid, email, sub, createdAt) {
    const plan = sub?.plan || 'expired';
    const days = sub ? Math.max(0, Math.ceil(((sub.expiresAt||0) - Date.now()) / 86400000)) : 0;
    const expiresAt = sub?.expiresAt ? _fmtDate(sub.expiresAt) : '—';
    const created   = _fmtDate(createdAt || sub?.createdAt);
    const cardId    = 'ucard_' + uid.slice(0,8);

    return `
    <div class="admin-manage-user-wrapper" id="${cardId}">
      <!-- ÁREA 2: Grid Principal (42% + 58%) -->
      <div class="admin-manage-user-grid">
        <!-- Coluna Esquerda: Detalhes da Conta (42%) -->
        <div class="admin-manage-user-left">
          <div class="admin-card-section-header">
            <div class="admin-card-section-title">Detalhes da Conta</div>
          </div>
          <div class="admin-card-info">
            <div class="admin-info-row">
              <span class="admin-info-label-left">Email</span>
              <span class="admin-info-value-left">${email}</span>
            </div>
            <div class="admin-info-row">
              <span class="admin-info-label-left">Plano</span>
              <span class="admin-info-value-left">${_planBadge(plan)}</span>
            </div>
            <div class="admin-info-row">
              <span class="admin-info-label-left">Trial Usado</span>
              <span class="admin-info-value-left">${sub?.trialUsed ? 'Sim' : 'Não'}</span>
            </div>
            <div class="admin-info-row">
              <span class="admin-info-label-left">Expira em</span>
              <span class="admin-info-value-left">${expiresAt}</span>
            </div>
            <div class="admin-info-row">
              <span class="admin-info-label-left">Dias Restantes</span>
              <span class="admin-info-value-left">${days}</span>
            </div>
            <div class="admin-info-row">
              <span class="admin-info-label-left">Criado em</span>
              <span class="admin-info-value-left">${created}</span>
            </div>
          </div>
          <div class="admin-account-actions-separator"></div>
          <div class="admin-account-actions-label">Ações da Conta</div>
          ${_isSuperAdminEmail(email) ? `
          <div class="admin-alert-info">
            <i class="ti ti-shield-check"></i>
            <span>Conta administrativa protegida.</span>
          </div>` : `
          <div class="admin-account-actions">
            <button class="admin-btn admin-btn-danger-large" onclick="AdminPanel._stateAction('${uid}','${email}','${cardId}','suspend')">
              <i class="ti ti-ban"></i> Suspender
            </button>
            <button class="admin-btn admin-btn-warn-large" onclick="AdminPanel._stateAction('${uid}','${email}','${cardId}','expire')">
              <i class="ti ti-clock-off"></i> Expirar
            </button>
            <button class="admin-btn admin-btn-secondary-large" onclick="AdminPanel._stateAction('${uid}','${email}','${cardId}','restore_trial')">
              <i class="ti ti-refresh"></i> Restaurar Trial
            </button>
          </div>`}
        </div>

        <!-- Coluna Direita: Gestão de Assinatura (62%) -->
        <div class="admin-manage-user-right">
          <div class="admin-card-section-header">
            <div class="admin-card-section-title">Gerir Assinatura</div>
          </div>
          
          <!-- Subsection 1: Adicionar Dias -->
          <div class="admin-card-subsection">
            <div class="admin-action-subtitle">Adicionar Dias Rápido</div>
            <div class="admin-day-btns-grid">
              <button class="admin-btn-day" onclick="AdminPanel._quickAdd('${uid}','${email}','${cardId}',7)">+7</button>
              <button class="admin-btn-day" onclick="AdminPanel._quickAdd('${uid}','${email}','${cardId}',15)">+15</button>
              <button class="admin-btn-day" onclick="AdminPanel._quickAdd('${uid}','${email}','${cardId}',30)">+30</button>
              <button class="admin-btn-day" onclick="AdminPanel._quickAdd('${uid}','${email}','${cardId}',60)">+60</button>
              <button class="admin-btn-day" onclick="AdminPanel._quickAdd('${uid}','${email}','${cardId}',90)">+90</button>
            </div>
            
            <div class="admin-action-row-inline">
              <input class="admin-input-inline" id="${cardId}_add_days" type="number" min="1" max="3650" placeholder="Nº de dias">
              <button class="admin-btn admin-btn-success" onclick="AdminPanel._manualAdd('${uid}','${email}','${cardId}','${days}')">
                <i class="ti ti-plus"></i> Adicionar
              </button>
            </div>
          </div>

          <div class="admin-subsection-divider"></div>

          <!-- Subsection 2: Remover Dias -->
          <div class="admin-card-subsection">
            <div class="admin-action-subtitle">Remover Dias</div>
            <div class="admin-action-row-inline">
              <input class="admin-input-inline" id="${cardId}_rem_days" type="number" min="1" max="${days}" placeholder="Nº de dias">
              <button class="admin-btn admin-btn-danger" onclick="AdminPanel._manualRemove('${uid}','${email}','${cardId}','${days}')">
                <i class="ti ti-minus"></i> Remover
              </button>
            </div>
          </div>

          <div class="admin-subsection-divider"></div>

          <!-- Subsection 3: Alterar Plano -->
          <div class="admin-card-subsection">
            <div class="admin-action-subtitle">Alterar Plano</div>
            <div class="admin-plan-buttons-horizontal">
              <button class="admin-btn admin-btn-trial" onclick="AdminPanel._stateAction('${uid}','${email}','${cardId}','activate_trial')">
                <i class="ti ti-star"></i> Trial
              </button>
              <button class="admin-btn admin-btn-pro" onclick="AdminPanel._stateAction('${uid}','${email}','${cardId}','activate_pro')">
                <i class="ti ti-rocket"></i> Pro
              </button>
              <button class="admin-btn admin-btn-premium" onclick="AdminPanel._stateAction('${uid}','${email}','${cardId}','activate_premium')">
                <i class="ti ti-crown"></i> Premium
              </button>
            </div>
            
            <!-- Mensagens de Confirmação -->
            <div id="${cardId}_feedback" class="admin-feedback-container-inline"></div>
          </div>
        </div>
      </div>

      <!-- ÁREA 3: Motivo (obrigatório) -->
      <div class="admin-manage-user-reason">
        <div class="admin-card-section-header">
          <div class="admin-card-section-title">Motivo (Obrigatório para qualquer ação)</div>
        </div>
        <div class="admin-card-section-content">
          <input class="admin-input-section" id="${cardId}_reason" type="text"
            placeholder="Ex: Pagamento confirmado Korvex"
            list="${cardId}_reasons">
          <datalist id="${cardId}_reasons">
            <option value="Pagamento confirmado Korvex">
            <option value="Renovação manual">
            <option value="Correcção administrativa">
            <option value="Compensação de serviço">
            <option value="Oferta promocional">
            <option value="Extensão de suporte">
            <option value="Conta restaurada">
            <option value="Migração de plano">
            <option value="Ajuste de subscrição">
          </datalist>
        </div>
      </div>

    </div>`;
  }

  // ── Feedback helpers ────────────────────────────────────────────────
  function _feedback(cardId, ok, msg) {
    const el = document.getElementById(`${cardId}_feedback`);
    if (!el) return;
    el.innerHTML = `<div class="${ok ? 'admin-success' : 'admin-error'}">${msg}</div>`;
    if (ok) setTimeout(() => { el.innerHTML = ''; }, 4000);
  }

  function _getReasonAndValidate(cardId) {
    const r = (document.getElementById(`${cardId}_reason`)?.value || '').trim();
    if (!r) { _feedback(cardId, false, 'Motivo obrigatório.'); return null; }
    return r;
  }

  // ── Quick add days ──────────────────────────────────────────────────
  async function _quickAdd(uid, email, cardId, days) {
    const reason = _getReasonAndValidate(cardId);
    if (!reason) return;
    _feedback(cardId, null, 'A processar…');
    const ok = await AdminService.extendDays(uid, email, days, reason, 'quick');
    if (ok === true) {
      _feedback(cardId, true, `✓ +${days} dias adicionados.`);
      _refreshCard(uid, email, cardId);
    } else if (ok === 'reason') {
      _feedback(cardId, false, 'Motivo obrigatório.');
    } else {
      _feedback(cardId, false, 'Erro ao estender subscrição.');
    }
  }

  // ── Manual add days ─────────────────────────────────────────────────
  async function _manualAdd(uid, email, cardId) {
    const reason = _getReasonAndValidate(cardId);
    if (!reason) return;
    const days = parseInt(document.getElementById(`${cardId}_add_days`)?.value || '0');
    if (!days || days <= 0) { _feedback(cardId, false, 'Indique um número de dias válido.'); return; }
    _feedback(cardId, null, 'A processar…');
    const ok = await AdminService.extendDays(uid, email, days, reason, 'manual');
    if (ok === true) {
      _feedback(cardId, true, `✓ +${days} dias adicionados.`);
      _refreshCard(uid, email, cardId);
    } else {
      _feedback(cardId, false, 'Erro ao adicionar dias.');
    }
  }

  // ── Manual remove days ──────────────────────────────────────────────
  async function _manualRemove(uid, email, cardId, currentDays) {
    const reason = _getReasonAndValidate(cardId);
    if (!reason) return;
    const days = parseInt(document.getElementById(`${cardId}_rem_days`)?.value || '0');
    const cur  = parseInt(currentDays) || 0;
    if (!days || days <= 0) { _feedback(cardId, false, 'Indique um número de dias válido.'); return; }
    if (days > cur) { _feedback(cardId, false, `Não pode remover ${days} dias. Disponíveis: ${cur}.`); return; }
    _feedback(cardId, null, 'A processar…');
    const ok = await AdminService.removeDays(uid, email, days, cur, reason);
    if (ok === true) {
      _feedback(cardId, true, `✓ -${days} dias removidos.`);
      _refreshCard(uid, email, cardId);
    } else if (ok === 'overflow') {
      _feedback(cardId, false, `Não pode remover mais dias do que o utilizador possui (${cur}).`);
    } else {
      _feedback(cardId, false, 'Erro ao remover dias.');
    }
  }

  // ── State actions (activate_trial / activate_pro / activate_premium / suspend / expire) ────
  async function _stateAction(uid, email, cardId, action) {
    // BUG FIX 3.3.6 — bloquear acções destrutivas em contas admin
    if (_isSuperAdminEmail(email) && ['suspend','expire'].includes(action)) {
      _feedback(cardId, false, 'Conta administrativa protegida. Esta acção não é permitida.');
      return;
    }
    const reason = _getReasonAndValidate(cardId);
    if (!reason) return;
    _feedback(cardId, null, 'A processar…');
    let ok;
    if (action === 'activate_trial') ok = await AdminService.activateTrial(uid, email, reason);
    if (action === 'activate_pro')   ok = await AdminService.activatePro(uid, email, reason);
    if (action === 'activate_premium') ok = await AdminService.activatePremium(uid, email, reason);
    if (action === 'suspend')  ok = await AdminService.suspendAccount(uid, email, reason);
    if (action === 'expire')   ok = await AdminService.expireAccount(uid, email, reason);
    if (action === 'restore_trial')    ok = await AdminService.restoreTrial(uid, email, reason);
    if (ok === 'reason') {
      _feedback(cardId, false, 'Motivo obrigatório.');
    } else if (ok === 'protected') {
      _feedback(cardId, false, 'Conta administrativa protegida. Operação recusada.');
    } else if (ok === true) {
      const labels = { 
        activate_trial: 'Trial activado',
        activate_pro: 'Pro activado',
        activate_premium: 'Premium activado',
        suspend: 'Conta suspensa',
        expire: 'Conta expirada',
        restore_trial: 'Trial restaurado'
      };
      _feedback(cardId, true, `✓ ${labels[action] || 'Operação concluída'}.`);
      _refreshCard(uid, email, cardId);
    } else {
      _feedback(cardId, false, 'Erro ao actualizar estado.');
    }
  }

  // ── Refresh user card after action ─────────────────────────────────
  async function _refreshCard(uid, email, cardId) {
    const sub = await _getSubQuiet(uid);
    const card = document.getElementById(cardId);
    if (!card) return;
    const tmpFeedback = document.getElementById(`${cardId}_feedback`)?.innerHTML || '';
    card.outerHTML = _buildUserCard(uid, email, sub, sub?.createdAt);
    // Restore feedback
    const newFB = document.getElementById(`${cardId}_feedback`);
    if (newFB && tmpFeedback) { newFB.innerHTML = tmpFeedback; }
  }

  return { open, close, setTab, search, openUserByUid, refreshDashboard,
           _quickAdd, _manualAdd, _manualRemove, _stateAction, _closeManageUser };
})();

/* ══════════════════════════════════════════════════════════════════════
   FASE 4.3.1 — Nota sobre Sincronização

   REMOVIDO: AdminStatsSyncService (setInterval periódico)

   RAZÃO: A consistência de admin_stats/current agora é mantida pelas
   próprias operações que alteram os dados (updateSubscriptionCountsIncremental).
   Não há mais necessidade de sincronização em background ou dependência
   do frontend estar aberto para manter o sistema consistente.

   Validação de consistência está disponível via:
     await DashboardStatsService.validateConsistency()
   para testes/diagnósticos, mas não é usada em operação normal.
   ════════════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════════════
   FASE 3.4 — Dashboard de Subscrição + Renovação
   ════════════════════════════════════════════════════════════════════ */

// ── Checkout URL ────────────────────────────────────────────────────────
// Deixar vazio até o link oficial do Paysuite estar disponível.
// Quando disponível, alterar apenas esta constante.