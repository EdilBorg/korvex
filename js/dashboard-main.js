/* ══════════════════════════════════════════════════════════════════════
   KORVEX — Dashboard Principal (dashboard-main.js)
   ──────────────────────────────────────────────────────────────────
   Carrega estatísticas reais do Firestore.
   Nunca usa dados fictícios — estado vazio elegante quando não há dados.

   Indicadores:
     • IA Premium (créditos restantes, barra, alerta)
     • Fluxos Criados
     • Contactos (total)
     • Conversas Activas
     • Números WhatsApp ligados (gerido pelo ConnectionService)
   ══════════════════════════════════════════════════════════════════════ */

const DashboardMain = (() => {

  let _uid = null;

  // ── Escrever valor num elemento ─────────────────────────────────────
  function _set(id, val, isEmpty) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = val;
    if (isEmpty) el.classList.add('kd-empty');
    else         el.classList.remove('kd-empty');
  }

  function _fmt(n) {
    if (n === null || n === undefined) return '—';
    return Number(n).toLocaleString('pt-PT');
  }

  // ── 1. Créditos IA ──────────────────────────────────────────────────
  async function _loadAiCredits(db) {
    try {
      const wsSnap = await db.collection('workspaces').doc(_uid).get();
      if (!wsSnap.exists) { _aiEmpty(); return; }

      const credits = wsSnap.data().ai_credits || {};
      const used    = credits.monthly_used  || 0;
      const limit   = credits.monthly_limit || 0;
      const daily   = credits.daily_used    || 0;

      if (!limit) { _aiEmpty(); return; }

      const remaining = Math.max(0, limit - used);
      const pct       = Math.min(100, Math.round((used / limit) * 100));

      // Dias até renovação (1º do próximo mês)
      const now     = new Date();
      const nxtMth  = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      const days    = Math.ceil((nxtMth - now) / 86400000);

      // Barra de progresso
      const barEl = document.getElementById('kd-ai-bar');
      if (barEl) {
        barEl.style.width = pct + '%';
        barEl.classList.remove('warn', 'critical');
        if (pct >= 90)      barEl.classList.add('critical');
        else if (pct >= 70) barEl.classList.add('warn');
      }

      _set('kd-ai-used',       _fmt(remaining) + ' restantes');
      _set('kd-ai-label-used', _fmt(used));
      _set('kd-ai-label-total','/ ' + _fmt(limit) + ' tokens (' + pct + '%)');
      _set('kd-ai-days',       days.toString());

      // Alerta < 500 000 créditos
      const alertEl  = document.getElementById('kd-ai-alert');
      const alertMsg = document.getElementById('kd-ai-alert-msg');
      if (alertEl) {
        if (remaining < 500000) {
          alertEl.style.display = 'flex';
          if (alertMsg) alertMsg.textContent = 'Restam apenas ' + _fmt(remaining) + ' tokens.';
        } else {
          alertEl.style.display = 'none';
        }
      }
    } catch(e) {
      console.error('[DashboardMain] _loadAiCredits:', e);
      _aiEmpty();
    }
  }

  function _aiEmpty() {
    _set('kd-ai-used',       'Sem dados', true);
    _set('kd-ai-label-used', '0');
    _set('kd-ai-label-total','/ —');
    _set('kd-ai-days',       '—', true);
  }

  // ── 2. Fluxos criados ───────────────────────────────────────────────
  async function _loadFlows(db) {
    try {
      const snap = await db.collection('workspaces').doc(_uid)
                           .collection('flows').get();
      _set('kd-flows-total', snap.empty ? '0' : _fmt(snap.size));
    } catch(e) {
      console.error('[DashboardMain] _loadFlows:', e);
      _set('kd-flows-total', '—', true);
    }
  }

  // ── 3. Contactos totais ─────────────────────────────────────────────
  async function _loadContacts(db) {
    try {
      const snap = await db.collection('workspaces').doc(_uid)
                           .collection('conversations').get();
      _set('kd-clients-new', snap.empty ? '0' : _fmt(snap.size));
    } catch(e) {
      console.error('[DashboardMain] _loadContacts:', e);
      _set('kd-clients-new', '—', true);
    }
  }

  // ── 4. Conversas activas ────────────────────────────────────────────
  async function _loadActiveConversations(db) {
    try {
      // "Activa" = status != 'done' && status != 'finished'
      const snap = await db.collection('workspaces').doc(_uid)
                           .collection('conversations').get();

      if (snap.empty) { _set('kd-conv-active', '0'); return; }

      const active = snap.docs.filter(d => {
        const s = d.data().status;
        return s !== 'done' && s !== 'finished';
      }).length;

      _set('kd-conv-active', _fmt(active));
    } catch(e) {
      console.error('[DashboardMain] _loadActiveConversations:', e);
      _set('kd-conv-active', '—', true);
    }
  }

  // ── init ─────────────────────────────────────────────────────────────
  async function init(uid) {
    if (!uid) return;
    _uid = uid;
    const db = FirebaseCore.getDb();
    if (!db) return;

    await Promise.all([
      _loadAiCredits(db),
      _loadFlows(db),
      _loadContacts(db),
      _loadActiveConversations(db),
    ]);
  }

  // ── refresh ao voltar ao dashboard ──────────────────────────────────
  async function refresh() {
    if (!_uid) return;
    const db = FirebaseCore.getDb();
    if (!db) return;
    await Promise.all([
      _loadAiCredits(db),
      _loadFlows(db),
      _loadContacts(db),
      _loadActiveConversations(db),
    ]);
  }

  function destroy() { _uid = null; }

  return { init, refresh, destroy };
})();
