/* ══════════════════════════════════════════════════════════════════════
   Hero — Landing Korvex (secção 02 do PLANO_FINAL.md)
   ───────────────────────────────────────────────────────────────────
   Foco: transformação (o problema real que o Korvex resolve), não
   lista de funcionalidades. Sem imagens, sem vídeos — apenas
   tipografia, layout e o Design System existente.

   Responsabilidades:
     • Renderizar o Hero dentro de #hero-root.
     • Preencher #hero-canvas-root com uma demonstração visual estática
       (conversa de atendimento + fluxo de automação) — apenas HTML/CSS,
       sem lógica de produto nem dependências externas.
     • Disparar CustomEvent('korvex:navigate') para os CTAs — mesma
       regra da Navbar: não conhece a implementação do Auth.

   Todo o texto está centralizado em HERO_CONTENT — alterar copy não
   deve exigir tocar em template()/bindEvents().
   ══════════════════════════════════════════════════════════════════════ */

const Hero = (() => {
  const MOUNT_ID = 'hero-root';

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
            <div class="hero__canvas-dots" aria-hidden="true"></div>
            <div id="hero-canvas-root" class="hero-canvas" role="img" aria-label="Demonstração: mensagem do cliente processada por um fluxo de automação e respondida automaticamente">
              <div class="hero-demo">
                <div class="hero-demo__chat">
                  <div class="hero-demo__chat-head">
                    <span class="hero-demo__chat-avatar" aria-hidden="true">K</span>
                    <div class="hero-demo__chat-meta">
                      <span class="hero-demo__chat-name">Atendimento Korvex</span>
                      <span class="hero-demo__chat-status">Automático</span>
                    </div>
                  </div>
                  <div class="hero-demo__chat-body">
                    <div class="hero-demo__msg hero-demo__msg--in hero-demo__msg--1">
                      <p>Olá, gostaria de saber os preços.</p>
                      <span class="hero-demo__time">09:41</span>
                    </div>
                    <div class="hero-demo__msg hero-demo__msg--out hero-demo__msg--2">
                      <p>Olá! Seja bem-vindo. Posso ajudar com informações sobre os nossos serviços.</p>
                      <span class="hero-demo__time">09:41</span>
                    </div>
                    <div class="hero-demo__msg hero-demo__msg--in hero-demo__msg--3">
                      <p>Quero fazer uma encomenda.</p>
                      <span class="hero-demo__time">09:42</span>
                    </div>
                    <div class="hero-demo__msg hero-demo__msg--out hero-demo__msg--4">
                      <p>Perfeito! Vou ajudar a registar o seu pedido.</p>
                      <span class="hero-demo__time">09:42</span>
                    </div>
                  </div>
                </div>

                <div class="hero-demo__bridge" aria-hidden="true">
                  <span class="hero-demo__bridge-dot"></span>
                  <span class="hero-demo__bridge-line"></span>
                </div>

                <div class="hero-demo__flow">
                  <div class="hero-demo__flow-label">Fluxo de automação</div>
                  <div class="hero-demo__nodes">
                    <div class="hero-demo__node hero-demo__node--1">
                      <span class="hero-demo__node-step">1</span>
                      <span class="hero-demo__node-text">Mensagem recebida</span>
                    </div>
                    <div class="hero-demo__connector" aria-hidden="true"></div>
                    <div class="hero-demo__node hero-demo__node--2">
                      <span class="hero-demo__node-step">2</span>
                      <span class="hero-demo__node-text">Identificar intenção</span>
                    </div>
                    <div class="hero-demo__connector" aria-hidden="true"></div>
                    <div class="hero-demo__node hero-demo__node--3">
                      <span class="hero-demo__node-step">3</span>
                      <span class="hero-demo__node-text">Resposta automática</span>
                    </div>
                    <div class="hero-demo__connector" aria-hidden="true"></div>
                    <div class="hero-demo__node hero-demo__node--4">
                      <span class="hero-demo__node-step">4</span>
                      <span class="hero-demo__node-text">Finalizar</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
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

  function playEntranceAnimation(root) {
    const heroEl = root.querySelector('#hero');
    if (!heroEl) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => heroEl.classList.add('hero--in'));
    });
  }

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
