/* ══════════════════════════════════════════════════════════════════════
   FASE 4.3 — Dashboard Financeiro + Arquitetura de Métricas Agregadas
   ────────────────────────────────────────────────────────────────────
   DashboardStatsService — gerencia métricas agregadas do Admin Dashboard.

   Firestore:
     admin_stats/current → {
       totalUsers, activeSubscriptions, expiredSubscriptions, breakdown,
       totalRevenue, monthlyRevenue, currentMonthKey, updatedAt
     }

   Arquitetura:
     • Dashboard lê SOMENTE admin_stats/current (1 documento)
     • Não escaneia admin_users para calcular estatísticas
     • Não faz N queries de subscription para obter contagens
     • Operações reais (criar user, alterar subscription, etc) atualizam
       admin_stats/current via eventos integrados

   Regras de receita:
     • Apenas planos oficiais (+30 / +60 / +90 dias) incrementam totalRevenue
     • Acções administrativas NUNCA alteram receita
     • Transações garantem consistência

   Métodos internos (_scanAllUsers, _subQuiet):
     • Usados APENAS para bootstrap/inicialização
     • NÃO chamados pelo Dashboard em operação normal
     • Preservados para compatibilidade e migração
   ══════════════════════════════════════════════════════════════════════ */

const DashboardStatsService = (() => {

  function _ref() {
    const db = FirebaseCore.getDb();
    return db ? db.collection('admin_stats').doc('current') : null;
  }

  function _monthKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function _emptyStats() {
    return {
      totalUsers:            0,
      activeSubscriptions:   0,
      expiredSubscriptions:  0,
      breakdown:             { trial: 0, pro: 0, premium: 0, expired: 0, suspended: 0, admin: 0 },
      totalRevenue:          0,
      monthlyRevenue:        0,
      currentMonthKey:       _monthKey(Date.now()),
      updatedAt:             Date.now(),
    };
  }

  // ── [INTERNAL] Percorre TODA a colecção admin_users ──────────────────
  // Garante que "Total Utilizadores" reflecte o número real.
  // USADO APENAS PARA: bootstrap inicial, refresh manual admin, validação
  // NÃO chamado pelo Dashboard em operação normal
  async function _scanAllUsers() {
    const db = FirebaseCore.getDb();
    if (!db) return [];
    const PAGE = 300;
    let all  = [];
    let last = null;
    try {
      while (true) {
        let q = db.collection('admin_users').orderBy('createdAt').limit(PAGE);
        if (last) q = q.startAfter(last);
        const snap = await q.get();
        if (snap.empty) break;
        all = all.concat(snap.docs.map(d => d.data()));
        last = snap.docs[snap.docs.length - 1];
        if (snap.docs.length < PAGE) break;
      }
    } catch(e) {
      console.error('[DashboardStatsService] _scanAllUsers:', e);
    }
    return all;
  }

  // ── [INTERNAL] Lê a subscrição real de um utilizador ──────────────────
  // USADO APENAS PARA: bootstrap inicial, refresh manual admin
  // NÃO chamado pelo Dashboard em operação normal
  async function _subQuiet(db, uid) {
    try {
      const snap = await db.collection('workspaces').doc(uid)
                           .collection('settings').doc('subscription').get();
      return snap.exists ? snap.data() : null;
    } catch { return null; }
  }

  // ── getStats() — leitura rápida do Dashboard (1 documento) ───────────
  // Dashboard chama EXCLUSIVAMENTE este método em operação normal
  // Sem varredura de users, sem loops de subscriptions
  async function getStats() {
    const ref = _ref();
    if (!ref) return _emptyStats();
    try {
      const snap = await ref.get();
      if (snap.exists) {
        // Reconciliar mês se necessário
        const data = snap.data();
        const nowKey = _monthKey(Date.now());
        if (data.currentMonthKey !== nowKey) {
          const updated = { ...data, monthlyRevenue: 0, currentMonthKey: nowKey, updatedAt: Date.now() };
          await ref.set(updated, { merge: true });
          return updated;
        }
        return data;
      }
      // Bootstrap: inicializar com scan (operação one-time)
      console.info('[DashboardStatsService] admin_stats/current não existe — iniciando bootstrap');
      return await refreshStats();
    } catch(e) {
      console.error('[DashboardStatsService] getStats:', e);
      return _emptyStats();
    }
  }

  // ── refreshStats() — recalcula COMPLETO (operação cara, raramente) ────
  // Chamado por:
  //   • getStats() se admin_stats/current não existir (bootstrap)
  //   • Admin manualmente clicando "Actualizar"
  //   • Reconciliação periódica se necessário
  // NÃO é operação normal do Dashboard
  async function refreshStats() {
    const db  = FirebaseCore.getDb();
    const ref = _ref();
    if (!db || !ref) return _emptyStats();

    try {
      const users = await _scanAllUsers();
      const breakdown = { trial: 0, pro: 0, premium: 0, expired: 0, suspended: 0, admin: 0 };

      // Ler subscrições em lotes pequenos
      const BATCH = 25;
      for (let i = 0; i < users.length; i += BATCH) {
        const slice = users.slice(i, i + BATCH);
        const valid = slice.filter(u => u && u.uid && u.uid !== 'undefined');
        const subs  = await Promise.all(valid.map(u => _subQuiet(db, u.uid)));
        subs.forEach(s => {
          if (!s) { breakdown.expired++; return; }
          const plan = s.plan || 'expired';
          const days = Math.max(0, Math.ceil(((s.expiresAt || 0) - Date.now()) / 86400000));
          if (plan === 'suspended')                        { breakdown.suspended++; return; }
          if (plan === 'trial'    && days > 0)             { breakdown.trial++;     return; }
          if (plan === 'pro'      && days > 0)             { breakdown.pro++;       return; }
          if (plan === 'premium'  && days > 0)             { breakdown.premium++;   return; }
          if (plan === 'active'   && days > 0)             { breakdown.premium++;   return; }
          if (plan === 'admin')                            { breakdown.admin++;     return; }
          breakdown.expired++;
        });
      }

      const activeSubscriptions  = breakdown.pro + breakdown.premium + breakdown.admin;
      const expiredSubscriptions = breakdown.expired + breakdown.suspended;

      // Preservar receita
      const prevSnap = await ref.get();
      let prev = prevSnap.exists ? prevSnap.data() : _emptyStats();

      // Reconciliar mês
      const nowKey = _monthKey(Date.now());
      if (prev.currentMonthKey !== nowKey) {
        prev = { ...prev, monthlyRevenue: 0, currentMonthKey: nowKey };
      }

      const updated = {
        totalUsers:            users.filter(u => u && u.uid && u.uid !== 'undefined' && u.email && u.email !== 'undefined').length,
        activeSubscriptions,
        expiredSubscriptions,
        breakdown,
        totalRevenue:          prev.totalRevenue   || 0,
        monthlyRevenue:        prev.monthlyRevenue || 0,
        currentMonthKey:       prev.currentMonthKey,
        updatedAt:             Date.now(),
      };

      await ref.set(updated, { merge: true });
      return updated;
    } catch(e) {
      console.error('[DashboardStatsService] refreshStats:', e);
      return _emptyStats();
    }
  }

  // ── incrementRevenue(amount) — soma receita REAL (transacção) ────────
  async function incrementRevenue(amount) {
    if (!amount || amount <= 0) return false;
    const db  = FirebaseCore.getDb();
    const ref = _ref();
    if (!db || !ref) return false;
    const nowKey = _monthKey(Date.now());
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const cur  = snap.exists ? snap.data() : _emptyStats();
        const sameMonth  = cur.currentMonthKey === nowKey;
        const newMonthly = (sameMonth ? (cur.monthlyRevenue || 0) : 0) + amount;
        const newTotal   = (cur.totalRevenue || 0) + amount;
        tx.set(ref, {
          totalUsers:            cur.totalUsers           || 0,
          activeSubscriptions:   cur.activeSubscriptions  || 0,
          expiredSubscriptions:  cur.expiredSubscriptions || 0,
          breakdown:             cur.breakdown            || { trial: 0, pro: 0, premium: 0, expired: 0, suspended: 0, admin: 0 },
          totalRevenue:          newTotal,
          monthlyRevenue:        newMonthly,
          currentMonthKey:       nowKey,
          updatedAt:             Date.now(),
        }, { merge: true });
      });
      console.info(`[DashboardStatsService] Receita real registada: +${amount} MT`);
      return true;
    } catch(e) {
      console.error('[DashboardStatsService] incrementRevenue:', e);
      return false;
    }
  }

  // ── incrementUserCount() — incremento ao registar novo utilizador ────
  async function incrementUserCount() {
    const ref = _ref();
    if (!ref) return false;
    try {
      const snap = await ref.get();
      if (!snap.exists) { await refreshStats(); return true; }
      await ref.set({
        totalUsers: (snap.data().totalUsers || 0) + 1,
        updatedAt:  Date.now(),
      }, { merge: true });
      return true;
    } catch(e) {
      console.error('[DashboardStatsService] incrementUserCount:', e);
      return false;
    }
  }

  // ── updateSubscriptionCountsIncremental(delta) — atualização incremental ──
  // Caminho NORMAL: atualiza apenas métricas alteradas
  // NUNCA faz scan completo
  // Recebe delta das mudanças reais (ex: pro-=1, premium+=1)
  async function updateSubscriptionCountsIncremental(delta) {
    const ref = _ref();
    if (!ref) return false;
    try {
      const snap = await ref.get();
      if (!snap.exists) {
        // Se não existir, fazer bootstrap uma única vez
        await refreshStats();
        return true;
      }
      const current = snap.data();
      const newBreakdown = { ...current.breakdown };

      // Aplicar delta ao breakdown
      if (delta.trial !== undefined) newBreakdown.trial = Math.max(0, (newBreakdown.trial || 0) + delta.trial);
      if (delta.pro !== undefined) newBreakdown.pro = Math.max(0, (newBreakdown.pro || 0) + delta.pro);
      if (delta.premium !== undefined) newBreakdown.premium = Math.max(0, (newBreakdown.premium || 0) + delta.premium);
      if (delta.expired !== undefined) newBreakdown.expired = Math.max(0, (newBreakdown.expired || 0) + delta.expired);
      if (delta.suspended !== undefined) newBreakdown.suspended = Math.max(0, (newBreakdown.suspended || 0) + delta.suspended);
      if (delta.admin !== undefined) newBreakdown.admin = Math.max(0, (newBreakdown.admin || 0) + delta.admin);

      // Recalcular totalizadores
      const activeSubscriptions = (newBreakdown.pro || 0) + (newBreakdown.premium || 0) + (newBreakdown.admin || 0);
      const expiredSubscriptions = (newBreakdown.expired || 0) + (newBreakdown.suspended || 0);

      const updated = {
        totalUsers:            current.totalUsers || 0,
        activeSubscriptions,
        expiredSubscriptions,
        breakdown:             newBreakdown,
        totalRevenue:          current.totalRevenue || 0,
        monthlyRevenue:        current.monthlyRevenue || 0,
        currentMonthKey:       current.currentMonthKey,
        updatedAt:             Date.now(),
      };

      await ref.set(updated, { merge: true });
      return true;
    } catch(e) {
      console.error('[DashboardStatsService] updateSubscriptionCountsIncremental:', e);
      return false;
    }
  }

  // ── updateSubscriptionCounts() — REBUILD COMPLETO ────────────────────
  // OPERAÇÃO CARA: O(N)
  // USO: Somente quando admin clica "Actualizar" ou bootstrap inicial
  // NÃO chamar de operações normais (suspender, restaurar, etc)
  // Preserve como método público para compatibilidade, mas claramente marcado
  async function updateSubscriptionCounts() {
    console.warn('[DashboardStatsService] updateSubscriptionCounts() chamado — REBUILD O(N)');
    return refreshStats();
  }

  // ── updateMonthlyRevenue() — garante mês correto ────────────────────
  async function updateMonthlyRevenue() {
    const ref = _ref();
    if (!ref) return false;
    const nowKey = _monthKey(Date.now());
    try {
      const snap = await ref.get();
      if (!snap.exists) return false;
      const data = snap.data();
      if (data.currentMonthKey === nowKey) return true;
      await ref.set({ monthlyRevenue: 0, currentMonthKey: nowKey, updatedAt: Date.now() }, { merge: true });
      return true;
    } catch(e) {
      console.error('[DashboardStatsService] updateMonthlyRevenue:', e);
      return false;
    }
  }

  // ── validateConsistency() — verifica TODAS as métricas ───────────────
  // IMPORTANTE: Sem tolerância — qualquer diferença = inválido
  // Verifica: totalUsers, breakdown completo, activeSubscriptions, expiredSubscriptions
  async function validateConsistency() {
    const db = FirebaseCore.getDb();
    const ref = _ref();
    if (!db || !ref) return { valid: false, error: 'Firestore indisponível', metrics: {} };

    try {
      const statsSnap = await ref.get();
      const stats = statsSnap.exists ? statsSnap.data() : null;

      if (!stats) {
        return { valid: false, error: 'admin_stats/current não existe', metrics: {} };
      }

      // Escanear dados reais para validação
      const users = await _scanAllUsers();
      const breakdown = { trial: 0, pro: 0, premium: 0, expired: 0, suspended: 0, admin: 0 };

      // Contar breakdown real
      const BATCH = 25;
      for (let i = 0; i < users.length; i += BATCH) {
        const slice = users.slice(i, i + BATCH);
        const valid = slice.filter(u => u && u.uid && u.uid !== 'undefined');
        const subs = await Promise.all(valid.map(u => _subQuiet(db, u.uid)));
        subs.forEach(s => {
          if (!s) { breakdown.expired++; return; }
          const plan = s.plan || 'expired';
          const days = Math.max(0, Math.ceil(((s.expiresAt || 0) - Date.now()) / 86400000));
          if (plan === 'suspended') { breakdown.suspended++; return; }
          if (plan === 'trial' && days > 0) { breakdown.trial++; return; }
          if (plan === 'pro' && days > 0) { breakdown.pro++; return; }
          if (plan === 'premium' && days > 0) { breakdown.premium++; return; }
          if (plan === 'active' && days > 0) { breakdown.premium++; return; }
          if (plan === 'admin') { breakdown.admin++; return; }
          breakdown.expired++;
        });
      }

      const realUserCount = users.filter(u => u && u.uid && u.uid !== 'undefined' && u.email && u.email !== 'undefined').length;
      const realActiveSubscriptions = breakdown.pro + breakdown.premium + breakdown.admin;
      const realExpiredSubscriptions = breakdown.expired + breakdown.suspended;

      // Comparar EXATAMENTE — sem tolerância
      const errors = [];
      const statsBreakdown = stats.breakdown || {};

      if ((stats.totalUsers || 0) !== realUserCount) {
        errors.push(`totalUsers: ${stats.totalUsers || 0} != ${realUserCount}`);
      }
      if ((statsBreakdown.trial || 0) !== breakdown.trial) {
        errors.push(`breakdown.trial: ${statsBreakdown.trial || 0} != ${breakdown.trial}`);
      }
      if ((statsBreakdown.pro || 0) !== breakdown.pro) {
        errors.push(`breakdown.pro: ${statsBreakdown.pro || 0} != ${breakdown.pro}`);
      }
      if ((statsBreakdown.premium || 0) !== breakdown.premium) {
        errors.push(`breakdown.premium: ${statsBreakdown.premium || 0} != ${breakdown.premium}`);
      }
      if ((statsBreakdown.expired || 0) !== breakdown.expired) {
        errors.push(`breakdown.expired: ${statsBreakdown.expired || 0} != ${breakdown.expired}`);
      }
      if ((statsBreakdown.suspended || 0) !== breakdown.suspended) {
        errors.push(`breakdown.suspended: ${statsBreakdown.suspended || 0} != ${breakdown.suspended}`);
      }
      if ((statsBreakdown.admin || 0) !== breakdown.admin) {
        errors.push(`breakdown.admin: ${statsBreakdown.admin || 0} != ${breakdown.admin}`);
      }
      if ((stats.activeSubscriptions || 0) !== realActiveSubscriptions) {
        errors.push(`activeSubscriptions: ${stats.activeSubscriptions || 0} != ${realActiveSubscriptions}`);
      }
      if ((stats.expiredSubscriptions || 0) !== realExpiredSubscriptions) {
        errors.push(`expiredSubscriptions: ${stats.expiredSubscriptions || 0} != ${realExpiredSubscriptions}`);
      }

      const valid = errors.length === 0;

      return {
        valid,
        errors: valid ? [] : errors,
        metrics: {
          stats: {
            totalUsers: stats.totalUsers || 0,
            activeSubscriptions: stats.activeSubscriptions || 0,
            expiredSubscriptions: stats.expiredSubscriptions || 0,
            breakdown: statsBreakdown
          },
          real: {
            totalUsers: realUserCount,
            activeSubscriptions: realActiveSubscriptions,
            expiredSubscriptions: realExpiredSubscriptions,
            breakdown
          }
        },
        timestamp: Date.now()
      };
    } catch(e) {
      console.error('[DashboardStatsService] validateConsistency:', e);
      return { valid: false, error: e.message, metrics: {} };
    }
  }

  return {
    getStats, refreshStats, incrementRevenue,
    incrementUserCount, updateSubscriptionCounts, updateSubscriptionCountsIncremental,
    updateMonthlyRevenue,
    validateConsistency,
  };
})();
