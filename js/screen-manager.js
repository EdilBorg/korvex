/* ══════════════════════════════════════════════════════════════════════
   ScreenManager — Korvex SPA
   ────────────────────────────────────────────────────────────────────
   Único módulo responsável por decidir qual "tela" de topo está visível
   na arquitetura:  Landing → Auth → Dashboard.

   Regras (aprovadas em revisão, não alterar sem nova aprovação):
     1. Troca de tela feita EXCLUSIVAMENTE via classe CSS 'hidden'
        (nunca style.display) — mesmo padrão já usado por #auth-screen
        e #sub-block-screen no resto do projecto.
     2. Todos os componentes (Navbar, Hero, …) trocam de tela apenas
        disparando CustomEvent('korvex:navigate', {detail:{to, ...}})
        no document. Nenhum componente chama ScreenManager.show()
        directamente nem conhece a implementação do Auth.
        Nome do evento propositalmente prefixado com 'korvex:' para
        evitar colisões com outros eventos globais do documento.
     3. O Dashboard (#app) NÃO é gerido por este módulo. A sua própria
        lógica de inicialização/visibilidade (js/app.js) permanece
        totalmente isolada e inalterada.
   ══════════════════════════════════════════════════════════════════════ */

const ScreenManager = (() => {

  // Ecrãs geridos por este módulo. #app (Dashboard) fica de fora —
  // continua sob responsabilidade exclusiva do seu próprio código.
  const SCREENS = {
    landing: 'landing-screen',
    auth:    'auth-screen',
  };

  let current = null;

  function getEl(name) {
    const id = SCREENS[name];
    return id ? document.getElementById(id) : null;
  }

  /**
   * Mostra a tela `name` e esconde as restantes tela geridas por este
   * módulo. Usa exclusivamente classList — nunca style.display.
   * @param {string} name    'landing' | 'auth'
   * @param {object} [params] parâmetros opcionais de navegação (ex.: {tab:'login'})
   */
  function show(name, params) {
    if (!SCREENS[name]) {
      console.warn('[ScreenManager] Tela desconhecida:', name);
      return;
    }

    Object.keys(SCREENS).forEach(key => {
      const el = getEl(key);
      if (!el) return;
      if (key === name) el.classList.remove('hidden');
      else el.classList.add('hidden');
    });

    current = name;

    // Ponte controlada com o Auth: o ScreenManager conhece o Auth,
    // os componentes da Landing não. Só actua se a função global já
    // existir (definida em js/auth.js) — sem acoplamento rígido.
    if (name === 'auth' && params && params.tab && typeof authShowTab === 'function') {
      authShowTab(params.tab);
    }

    document.dispatchEvent(new CustomEvent('korvex:screen-changed', { detail: { screen: name } }));
  }

  function getCurrent() {
    return current;
  }

  function handleNavigate(e) {
    const detail = (e && e.detail) || {};
    if (!detail.to) return;
    show(detail.to, detail);
  }

  function init() {
    document.addEventListener('korvex:navigate', handleNavigate);
    // Estado inicial da SPA — a Landing é sempre o primeiro ecrã.
    show('landing');
  }

  document.addEventListener('DOMContentLoaded', init);

  return { show, getCurrent };
})();
