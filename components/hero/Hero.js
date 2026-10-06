/* ══════════════════════════════════════════════════════════════════════
   Hero — Landing Korvex (secção 02 do PLANO_FINAL.md)
   ────────────────────────────────────────────────────────────────────
   Foco: transformação (o problema real que o Korvex resolve), não
   lista de funcionalidades. Sem imagens, sem vídeos — apenas
   tipografia, layout e o Design System existente.

   Responsabilidades:
     • Renderizar o Hero dentro de #hero-root.
     • Reservar, no lado direito, o container #hero-canvas-root para o
       futuro componente Live Canvas (secção 03) — apenas o container,
       sem nenhuma lógica ou conteúdo do Live Canvas em si.
     • Disparar CustomEvent('korvex:navigate') para os CTAs — mesma
       regra da Navbar: não conhece a implementação do Auth.

   Todo o texto está centralizado em HERO_CONTENT — alterar copy não
   deve exigir tocar em template()/bindEvents().
   ══════════════════════════════════════════════════════════════════════ */

const Hero = (() => {
  const MOUNT_ID = 'hero-root';

  // ── Único ponto de configuração de texto do Hero ──────────────────
  // Micro-benefícios reflectem capacidades reais e já implementadas do
  // Korvex (motor de fluxos automático, flow builder visual, transição
  // bot → humano na Inbox) — sem números inventados nem prova social.
  const HERO_CONTENT = {
    eyebrow: 'Para empresas que atendem clientes pelo WhatsApp',

    headline: 'O seu WhatsApp deixa de depender de alguém estar online.',

    subheadline:
      'O Korvex assume o atendimento assim que a mensagem chega — organiza a ' +
      'conversa, responde automaticamente e só chama a sua equipa quando for ' +
      'mesmo necessário.',

    benefits: [
      {
        icon: 'ti-robot',
        text: 'Continua a atender mesmo fora do horário comercial',
      },
      {
        icon: 'ti-hierarchy',
        text: 'Fluxos de conversa construídos visualmente, sem código',
      },
      {
        icon: 'ti-arrows-exchange',
        text: 'Passa para um atendente humano sem perder o histórico da conversa',
      },
    ],

    primaryCta: {
      label: 'Começar agora',
      navigate: { to: 'auth', tab: 'register' },
    },
    secondaryCta: {
      label: 'Já tenho conta',
      navigate: { to: 'auth', tab: 'login' },
    },
  };

  function benefitTemplate(benefit) {
    return `
      <li class="hero__benefit">
        <span class="hero__benefit-icon"><i class="ti ${benefit.icon}"></i></span>
        <span class="hero__benefit-text">${benefit.text}</span>
      </li>
    `;
  }

  function template(content) {
    const benefits = content.benefits.map(benefitTemplate).join('');

    return `
      <section class="hero" id="hero">
        <div class="hero__container">

          <div class="hero__content">
            <span class="hero__eyebrow">${content.eyebrow}</span>
            <h1 class="hero__headline">${content.headline}</h1>
            <p class="hero__subheadline">${content.subheadline}</p>

            <ul class="hero__benefits">
              ${benefits}
            </ul>

            <div class="hero__actions">
              <button class="hero__btn hero__btn--primary" type="button" data-hero-cta="primary">
                ${content.primaryCta.label}
              </button>
              <button class="hero__btn hero__btn--ghost" type="button" data-hero-cta="secondary">
                ${content.secondaryCta.label}
              </button>
            </div>
          </div>

          <div class="hero__canvas-wrap">
            <!-- Container reservado para o Live Canvas (secção 03).
                 Implementação futura — apenas o container por agora. -->
            <div class="hero__canvas-dots" aria-hidden="true"></div>
            <div id="hero-canvas-root" class="hero-canvas"></div>
          </div>

        </div>
      </section>
    `;
  }

  function dispatchNavigate(payload) {
    document.dispatchEvent(new CustomEvent('korvex:navigate', { detail: payload }));
  }

  function bindEvents(root, content) {
    const ctaMap = {
      primary:   content.primaryCta.navigate,
      secondary: content.secondaryCta.navigate,
    };

    root.querySelectorAll('[data-hero-cta]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-hero-cta');
        const navigate = ctaMap[key];
        if (navigate) dispatchNavigate(navigate);
      });
    });
  }

  /**
   * Animação leve de entrada (CSS + JS): adiciona a classe 'hero--in'
   * um instante depois do mount, para o CSS fazer a transição de
   * opacidade/posição já definida em hero.css.
   */
  function playEntranceAnimation(root) {
    const heroEl = root.querySelector('#hero');
    if (!heroEl) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => heroEl.classList.add('hero--in'));
    });
  }

  /**
   * Monta o Hero dentro de #hero-root.
   * Idempotente: recria o innerHTML e religa os eventos a cada chamada.
   */
  function mount() {
    const root = document.getElementById(MOUNT_ID);
    if (!root) {
      console.warn('[Hero] Container #' + MOUNT_ID + ' não encontrado.');
      return;
    }
    root.innerHTML = template(HERO_CONTENT);
    bindEvents(root, HERO_CONTENT);
    playEntranceAnimation(root);
  }

  return { mount };
})();

document.addEventListener('DOMContentLoaded', Hero.mount);
