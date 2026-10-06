/* ══════════════════════════════════════════════════════════════════════
   Navbar — Landing Korvex (secção 01 do PLANO_FINAL.md)
   ────────────────────────────────────────────────────────────────────
   Responsabilidades:
     • Renderizar a barra de navegação dentro de #navbar-root.
     • Gerir o menu mobile (abrir/fechar) e o efeito visual de scroll.
     • Disparar CustomEvent('korvex:navigate') no document para pedir
       mudança de tela — NUNCA troca de tela directamente.

   Regras (aprovadas em revisão, não alterar sem nova aprovação):
     • Não conhece a implementação do Auth (não chama authShowTab,
       AuthService, etc.) nem do Dashboard.
     • Quem decide qual tela abrir é sempre o ScreenManager
       (js/screen-manager.js), que escuta o evento 'navigate'.

   Dependências: nenhuma por agora — components/shared/Button.js ainda
   não existe neste projecto; quando for criado, os botões abaixo devem
   ser migrados para o componente Button partilhado.
   ══════════════════════════════════════════════════════════════════════ */

const Navbar = (() => {
  const MOUNT_ID = 'navbar-root';

  // Links da secções da Landing. Apontam para âncoras que serão
  // preenchidas pelas próximas secções (Fase 3 em diante do plano);
  // por enquanto podem não corresponder a nenhum elemento — isso é
  // seguro (o browser simplesmente não faz scroll).
  const LINKS = [
    { label: 'Como funciona', href: '#how-it-works' },
    { label: 'Recursos',      href: '#solution' },
    { label: 'Planos',        href: '#pricing' },
    { label: 'FAQ',           href: '#faq' },
  ];

  function template() {
    const links = LINKS
      .map(link => `<a class="navbar__menu-item" href="${link.href}">${link.label}</a>`)
      .join('');

    return `
      <nav class="navbar" id="navbar">
        <div class="navbar__container">

          <a class="navbar__logo" href="#landing-screen" data-nav-home aria-label="Korvex — página inicial">
            <span class="navbar__logo-icon">
              <img src="assets/logo.png" alt="" width="28" height="28">
            </span>
            <span class="navbar__logo-text">Korvex</span>
          </a>

          <div class="navbar__menu" id="navbar-menu">
            <div class="navbar__links">
              ${links}
            </div>
            <div class="navbar__actions">
              <button class="navbar__btn navbar__btn--ghost" type="button" data-nav-action="login">
                Entrar
              </button>
              <button class="navbar__btn navbar__btn--primary" type="button" data-nav-action="register">
                Começar agora
              </button>
            </div>
          </div>

          <button class="navbar__toggle" id="navbar-toggle" type="button"
                  aria-label="Abrir menu" aria-expanded="false" aria-controls="navbar-menu">
            <span class="navbar__toggle-bar"></span>
            <span class="navbar__toggle-bar"></span>
            <span class="navbar__toggle-bar"></span>
          </button>

        </div>
      </nav>
    `;
  }

  function dispatchNavigate(payload) {
    document.dispatchEvent(new CustomEvent('korvex:navigate', { detail: payload }));
  }

  function closeMobileMenu(navEl, toggleBtn) {
    if (!navEl) return;
    navEl.classList.remove('navbar--menu-open');
    if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'false');
  }

  function bindEvents(root) {
    const navEl     = root.querySelector('#navbar');
    const toggleBtn = root.querySelector('#navbar-toggle');

    // ── Botões de acção — apenas manifestam intenção de navegação ──
    root.querySelectorAll('[data-nav-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-nav-action'); // 'login' | 'register'
        closeMobileMenu(navEl, toggleBtn);
        dispatchNavigate({ to: 'auth', tab: action });
      });
    });

    // ── Logo — pede o regresso ao topo da Landing ──
    const logoEl = root.querySelector('[data-nav-home]');
    if (logoEl) {
      logoEl.addEventListener('click', e => {
        e.preventDefault();
        closeMobileMenu(navEl, toggleBtn);
        dispatchNavigate({ to: 'landing' });
      });
    }

    // ── Menu mobile (abrir/fechar) ──
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        const isOpen = navEl.classList.toggle('navbar--menu-open');
        toggleBtn.setAttribute('aria-expanded', String(isOpen));
      });
    }

    // Fecha o menu mobile ao clicar num link de secção
    root.querySelectorAll('.navbar__menu-item').forEach(link => {
      link.addEventListener('click', () => closeMobileMenu(navEl, toggleBtn));
    });

    // ── Efeito de scroll — fundo sólido após rolar a página ──
    window.addEventListener('scroll', () => {
      if (window.scrollY > 8) navEl.classList.add('navbar--scrolled');
      else navEl.classList.remove('navbar--scrolled');
    }, { passive: true });
  }

  /**
   * Monta a Navbar dentro de #navbar-root.
   * Idempotente: pode ser chamado novamente sem duplicar listeners,
   * porque o innerHTML é sempre recriado antes de religar os eventos.
   */
  function mount() {
    const root = document.getElementById(MOUNT_ID);
    if (!root) {
      console.warn('[Navbar] Container #' + MOUNT_ID + ' não encontrado.');
      return;
    }
    root.innerHTML = template();
    bindEvents(root);
  }

  return { mount };
})();

document.addEventListener('DOMContentLoaded', Navbar.mount);
