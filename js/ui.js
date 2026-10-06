function _authUpdateUI(user) {
  const authScreen = document.getElementById('auth-screen');
  const appEl      = document.getElementById('app');
  const emailEl    = document.getElementById('topbar-user-email');
  const avatarEl   = document.getElementById('topbar-avatar');
  const adminBtn   = document.getElementById('btn-admin');

  if (user) {
    authScreen.classList.add('hidden');
    // BUG FIX BUGFIX-01 — app só é mostrada após verificação de subscrição em app.js
    // appEl.style.display = ''; ← movido para app.js após canAccess()
    if (emailEl)  emailEl.textContent = user.email || '';
    if (avatarEl) avatarEl.textContent = (user.email || '?')[0].toUpperCase();

    // BUGFIX-02.3 — AdminGuard: provisionar super_admin + carregar cache de admin
    // Depois de check() carregar o cache, o botão admin é mostrado/ocultado.
    // adminBtn começa oculto e só aparece se confirmado como admin.
    if (adminBtn) adminBtn.style.display = 'none';
    (async () => {
      // 1. Garantir que super_admin existe na coleção admins (apenas para o email oficial)
      await AdminGuard.provision(user);
      // 2. Verificar admin e carregar cache
      const isAdm = await AdminGuard.check(user.uid);
      if (adminBtn) adminBtn.style.display = isAdm ? '' : 'none';
      console.info('[AdminGuard] uid:', user.uid, '| admin:', isAdm);
    })();

    // FASE 3.3 + BUGFIX-01 — Registar utilizador na coleção admin_users
    // Allows admin to search users by email and list all users.
    // Hardened: retry once after 2s on failure.
    // FASE 4.2 — incrementa o contador real de utilizadores apenas quando
    // o registo é efectivamente novo (evita contar logins repetidos).
    (async () => {
      const db = FirebaseCore.getDb();
      if (!db || !user.uid || !user.email) return;
      const createdAt = (() => {
        try {
          const t = user.metadata?.creationTime;
          return t ? new Date(t).getTime() : Date.now();
        } catch { return Date.now(); }
      })();
      const record = {
        uid:         user.uid,
        email:       user.email.toLowerCase().trim(),
        lastLoginAt: Date.now(),
        createdAt,
      };
      let isNewUser = false;
      try {
        const existing = await db.collection('admin_users').doc(user.uid).get();
        isNewUser = !existing.exists;
      } catch(e) {
        console.error('[TRACE ERROR] admin_users.check_existing', e);
        console.warn('[admin_users] Falha ao verificar registo existente:', e.message);
      }
      try {
        await db.collection('admin_users').doc(user.uid).set(record, { merge: true });
        console.info('[admin_users] Utilizador registado:', record.email);
        if (isNewUser && typeof DashboardStatsService !== 'undefined') {
          DashboardStatsService.incrementUserCount();
        }
      } catch (e) {
        console.error('[TRACE ERROR] admin_users.write_first', e);
        console.warn('[admin_users] Falha na escrita — a tentar novamente em 2s...', e.message);
        setTimeout(async () => {
          try {
            const db2 = FirebaseCore.getDb();
            if (db2) await db2.collection('admin_users').doc(user.uid).set(record, { merge: true });
            console.info('[admin_users] Retry bem-sucedido:', record.email);
            if (isNewUser && typeof DashboardStatsService !== 'undefined') {
              DashboardStatsService.incrementUserCount();
            }
          } catch (e2) {
            console.error('[TRACE ERROR] admin_users.write_retry', e2);
            console.error('[admin_users] Erro persistente ao registar utilizador:', e2.message);
          }
        }, 2000);
      }
    })();

    console.info('[Auth] Sessão activa:', user.email);
  } else {
    authScreen.classList.remove('hidden');
    appEl.style.display = 'none';
    if (emailEl)  emailEl.textContent = '';
    if (avatarEl) avatarEl.textContent = '?';
    if (adminBtn) adminBtn.style.display = 'none';
    // FASE 3.1 — limpar badge ao fazer logout
    SubscriptionService.renderBadge(null);
    // BUGFIX-02.3 — limpar cache AdminGuard ao fazer logout
    AdminGuard.invalidate();
    // FASE 3.3 — fechar painel admin se estiver aberto
    const adminOverlay = document.getElementById('admin-overlay');
    if (adminOverlay) adminOverlay.classList.remove('open');
    console.info('[Auth] Sem sessão — a mostrar ecrã de autenticação.');
  }
}

// Suporte a Enter nos campos de autenticação
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const target = e.target;
  const loginPanel    = document.getElementById('auth-panel-login');
  const registerPanel = document.getElementById('auth-panel-register');
  if (loginPanel    && loginPanel.style.display    !== 'none' && loginPanel.contains(target))    authDoLogin();
  if (registerPanel && registerPanel.style.display !== 'none' && registerPanel.contains(target)) authDoRegister();
});
