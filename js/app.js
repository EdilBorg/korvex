// ─── Init ─────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // O editor começa oculto até onAuthChange confirmar sessão
  document.getElementById('app').style.display = 'none';

  // Inicializar Firebase (falha silenciosamente se SDK não carregado)
  FirebaseCore.init();

  // Palette e canvas são preparados logo (independem de auth)
  buildPalette();
  initCanvas();

  if (FirebaseCore.isReady()) {
    console.log('[Firebase] Inicializado');

    // ✅ REFACTOR: onAuthChange — apenas sincronização
    // Toda a lógica de inicialização foi centralizada em handleAuthenticatedUser() e handleLogout()
    // Esse callback é mantido apenas para:
    //   - Restaurar sessão após F5 (refresh)
    //   - Sincronizar logout quando o Firebase termina a sessão
    //   - Detectar expiração da sessão
    //   - Sincronizar múltiplas abas
    AuthService.onAuthChange(user => {
      console.log('[Auth] onAuthStateChanged dispara:', user?.email || 'logout');
      
      if (user) {
        // Utilizador autenticado — chamar handleAuthenticatedUser
        // Se já foi inicializado, handleAuthenticatedUser detectará e apenas sincronizará
        handleAuthenticatedUser(user);
      } else {
        // Logout — chamar handleLogout
        // Se já foi desconectado, handleLogout retornará cedo
        handleLogout();
      }
    });

  } else {
    // Firebase não disponível — bloquear acesso
    console.warn('[Auth] Firebase indisponível — a bloquear acesso.');
    _authUpdateUI(null);
  }
});

/**
 * Remove fluxos demo de versões anteriores (Sabonete, COD, etc.)
 * Detecta pelo conteúdo do nó e apaga do localStorage.
 * Corre apenas uma vez — depois o utilizador tem controlo total.
 */
// FASE 3.1.1 — _clearLegacyDemoFlows() removido.
// Não existem mais fluxos demo a limpar.
