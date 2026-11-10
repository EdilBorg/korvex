/* ══════════════════════════════════════════════════════════════════════
   FASE 4.2 — Dashboard Financeiro + Estatísticas Reais
   ────────────────────────────────────────────────────────────────────
   DashboardStatsService — única fonte de verdade para as métricas
   administrativas exibidas no painel.

   Firestore:
     admin_stats/current → {
       totalUsers, activeSubscriptions, expiredSubscriptions,
       totalRevenue, monthlyRevenue, currentMonthKey, updatedAt
     }

   Regras de receita:
     • Apenas planos oficiais (+30 / +60 / +90 dias, aplicados via botão
       rápido do painel) incrementam totalRevenue / monthlyRevenue.
     • NUNCA calculada proporcionalmente (dias / 30 × 500). Cada plano
       tem um valor fixo (ver PLAN_PRICES em admin.js).
     • Acções administrativas (dias manuais, remoção de dias, suspender,
       expirar, restaurar trial, activar conta) NUNCA alteram receita.

   Contagem de utilizadores / subscrições:
     • Sempre recalculada a partir de dados reais do Firestore
       (varrendo TODA a colecção admin_users, sem limite de 200),
       nunca um valor "fictício" ou parado em cache.
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
      totalRevenue:          0,
      monthlyRevenue:        0,
      currentMonthKey:       _monthKey(Date.now()),
      updatedAt:             Date.now(),
    };
  }

  // ── Percorre TODA a colecção admin_users — sem limite de 200 ────────
  // Garante que "Total Utilizadores" reflecte o número real, mesmo
  // com mais de 200 contas registadas.
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

  // ── Lê a subscrição real de um utilizador (silencioso) ───────────────
  async function _subQuiet(db, uid) {
    try {
      const snap = await db.collection('workspaces').doc(uid)
                           .collection('settings').doc('subscription').get();
      return snap.exists ? snap.data() : null;
    } catch { return null; }
  }

  // ── getStats() — leitura rápida; cria a partir de dados reais se não existir ──
  async function getStats() {
    const ref = _ref();
    if (!ref) return _emptyStats();
    try {
      const snap = await ref.get();
      if (snap.exists) return snap.data();
      return await refreshStats(); // bootstrap com valores reais, não fictícios
    } catch(e) {
      console.error('[DashboardStatsService] getStats:', e);
      return _emptyStats();
    }
  }

  // ── refreshStats() — recalcula totalUsers / activeSubscriptions /
  //    expiredSubscriptions directamente a partir do Firestore real.
  //    totalRevenue / monthlyRevenue são preservados aqui (a fonte real
  //    desses valores é sempre incrementRevenue, nunca um cálculo
  //    derivado de dias ou de subscrições).
  async function refreshStats() {
    const db  = FirebaseCore.getDb();
    const ref = _ref();
    if (!db || !ref) return _emptyStats();

    try {
      const users = await _scanAllUsers();
      const breakdown = { trial: 0, pro: 0, premium: 0, expired: 0, suspended: 0, admin: 0 };

      // Ler subscrições em lotes pequenos para não sobrecarregar o Firestore
      const BATCH = 25;
      for (let i = 0; i < users.length; i += BATCH) {
        const slice = users.slice(i, i + BATCH);
        // Filtrar utilizadores fantasma antes de ler subscrições
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
          if (plan === 'active'   && days > 0)             { breakdown.premium++;   return; } // retrocompatibilidade: 'active' é premium
          // admin não tem expiração
          if (plan === 'admin')                            { breakdown.admin++;     return; }
          breakdown.expired++;
        });
      }

      // Contar assinaturas activas (pro + premium)
      const activeSubscriptions  = breakdown.pro + breakdown.premium + breakdown.admin;
      const expiredSubscriptions = breakdown.expired + breakdown.suspended;

      // Preservar receita real acumulada — nunca recalculada a partir de dias/subscrições
      const prevSnap = await ref.get();
      let prev = prevSnap.exists ? prevSnap.data() : _emptyStats();

      // Reconciliação de mês: se mudou de mês sem nenhuma venda, zera Receita Este Mês
      const nowKey = _monthKey(Date.now());
      if (prev.currentMonthKey !== nowKey) {
        prev = { ...prev, monthlyRevenue: 0, currentMonthKey: nowKey };
      }

      const updated = {
        // Filtrar fantasmas antes de contar
        totalUsers:            users.filter(u => u && u.uid && u.uid !== 'undefined' && u.email && u.email !== 'undefined').length,
        activeSubscriptions,
        expiredSubscriptions,
        totalRevenue:          prev.totalRevenue   || 0,
        monthlyRevenue:        prev.monthlyRevenue || 0,
        currentMonthKey:       prev.currentMonthKey,
        updatedAt:             Date.now(),
      };

      await ref.set(updated, { merge: true });
      return { ...updated, breakdown };
    } catch(e) {
      console.error('[DashboardStatsService] refreshStats:', e);
      return _emptyStats();
    }
  }

  // ── incrementRevenue(amount) — soma receita REAL de um plano oficial ──
  // Usa transacção Firestore: evita perder incrementos concorrentes e
  // trata correctamente a passagem de mês em monthlyRevenue.
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

  // ── incrementUserCount() — incremento imediato ao registar um utilizador novo.
  //    A contagem oficial é sempre reconciliada por refreshStats() (varredura real).
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

  // ── updateSubscriptionCounts() — reconcilia Activas/Expiradas com dados reais ──
  async function updateSubscriptionCounts() {
    return refreshStats();
  }

  // ── updateMonthlyRevenue() — garante que Receita Este Mês corresponde
  //    sempre ao mês corrente, mesmo sem nenhuma venda nova ──
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

  return {
    getStats, refreshStats, incrementRevenue,
    incrementUserCount, updateSubscriptionCounts, updateMonthlyRevenue,
  };
})();
