/* Hero — Landing Korvex
   Demonstração: máquina de estados JS + 5 cenários de conversa.
   CTAs via CustomEvent('korvex:navigate'). Sem dependências externas.
*/

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
      { icon: 'ti-robot', text: 'Continua a atender mesmo fora do horário comercial' },
      { icon: 'ti-hierarchy', text: 'Fluxos de conversa construídos visualmente, sem código' },
      {
        icon: 'ti-arrows-exchange',
        text: 'Passa para um atendente humano sem perder o histórico da conversa',
      },
    ],
    primaryCta: { label: 'Começar agora', navigate: { to: 'auth', tab: 'register' } },
    secondaryCta: { label: 'Já tenho conta', navigate: { to: 'auth', tab: 'login' } },
  };

  const SCENARIOS = [
    {
      id: 'precos',
      label: 'Consulta de preços',
      client: 'Olá! Gostaria de saber os preços dos vossos serviços.',
      bot: 'Olá! Claro. Que serviço gostaria de conhecer melhor?',
      intent: 'Consulta de preços',
      step3Label: 'Resposta automática',
      step3Icon: 'ti-message-chatbot',
      humanHandoff: false,
    },
    {
      id: 'horario',
      label: 'Horário de atendimento',
      client: 'Boa tarde. Até que horas fazem atendimento?',
      bot: 'Boa tarde! Posso ajudar com informações sobre o nosso horário de atendimento.',
      intent: 'Consulta de horário',
      step3Label: 'Resposta automática',
      step3Icon: 'ti-message-chatbot',
      humanHandoff: false,
    },
    {
      id: 'local',
      label: 'Localização',
      client: 'Olá! Onde fica a vossa loja?',
      bot: 'Olá! Claro, posso ajudar com informações sobre a localização.',
      intent: 'Consulta de localização',
      step3Label: 'Resposta automática',
      step3Icon: 'ti-message-chatbot',
      humanHandoff: false,
    },
    {
      id: 'agenda',
      label: 'Agendamento',
      client: 'Gostaria de marcar um atendimento.',
      bot: 'Com certeza! Que dia e horário seriam melhores para si?',
      intent: 'Agendamento',
      step3Label: 'Resposta automática',
      step3Icon: 'ti-message-chatbot',
      humanHandoff: false,
    },
    {
      id: 'humano',
      label: 'Atendimento humano',
      client: 'Gostaria de falar com alguém da vossa equipa.',
      bot: 'Claro! Vou encaminhar a sua conversa para a equipa de atendimento.',
      intent: 'Encaminhamento para atendimento humano',
      step3Label: 'Encaminhar para a equipa',
      step3Icon: 'ti-user-share',
      humanHandoff: true,
    },
  ];

  const TIMING = {
    msgIn: 1100,
    identify: 1100,
    typing: 1500,
    respond: 900,
    complete: 900,
    hold: 1800,
    transition: 600,
  };

  let timers = [];
  let running = false;
  let scenarioIndex = 0;
  let lastScenarioId = null;
  let introDone = false;
  let visibilityHandler = null;
  let screenHandler = null;
  let demoRoot = null;

  function clearTimers() {
    timers.forEach((id) => clearTimeout(id));
    timers = [];
  }

  function schedule(fn, ms) {
    const id = setTimeout(fn, ms);
    timers.push(id);
    return id;
  }

  function prefersReducedMotion() {
    return (
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  function landingVisible() {
    const screen = document.getElementById('landing-screen');
    if (!screen) return false;
    if (screen.classList.contains('hidden')) return false;
    if (document.hidden) return false;
    return true;
  }

  function benefitTemplate(benefit) {
    return (
      '\n      <li class="hero__benefit">\n        <span class="hero__benefit-icon"><i class="ti ' +
      benefit.icon +
      '"></i></span>\n        <span class="hero__benefit-text">' +
      benefit.text +
      '</span>\n      </li>\n    '
    );
  }

  function template(content) {
    const benefits = content.benefits.map(benefitTemplate).join('');
    return (
      '\n      <section class="hero" id="hero">\n        <div class="hero__container">\n          <div class="hero__content">\n            <span class="hero__eyebrow">' +
      content.eyebrow +
      '</span>\n            <h1 class="hero__headline">' +
      content.headline +
      '</h1>\n            <p class="hero__subheadline">' +
      content.subheadline +
      '</p>\n            <ul class="hero__benefits">' +
      benefits +
      '</ul>\n            <div class="hero__actions">\n              <button class="hero__btn hero__btn--primary" type="button" data-hero-cta="primary">\n                ' +
      content.primaryCta.label +
      '\n              </button>\n              <button class="hero__btn hero__btn--ghost" type="button" data-hero-cta="secondary">\n                ' +
      content.secondaryCta.label +
      '\n              </button>\n            </div>\n          </div>\n\n          <div class="hero__canvas-wrap">\n            <div class="hero__canvas-dots" aria-hidden="true"></div>\n            <div id="hero-canvas-root" class="hero-canvas">\n              <div class="hero-demo" role="group" aria-label="Demonstração do atendimento automático Korvex">\n                <div class="hero-demo__toolbar">\n                  <span class="hero-demo__badge">Demonstração</span>\n                  <span class="hero-demo__scenario" data-demo-scenario>—</span>\n                  <span class="hero-demo__runstate" data-demo-state>Em espera</span>\n                </div>\n\n                <div class="hero-demo__panels">\n                  <div class="hero-demo__chat">\n                    <div class="hero-demo__chat-head">\n                      <span class="hero-demo__chat-avatar" aria-hidden="true">K</span>\n                      <div class="hero-demo__chat-meta">\n                        <span class="hero-demo__chat-name">Atendimento Korvex</span>\n                        <span class="hero-demo__chat-status">\n                          <span class="hero-demo__online" aria-hidden="true"></span>\n                          Automático\n                        </span>\n                      </div>\n                    </div>\n                    <div class="hero-demo__chat-body" data-demo-messages></div>\n                  </div>\n\n                  <div class="hero-demo__flow">\n                    <div class="hero-demo__flow-label">Fluxo de automação</div>\n                    <div class="hero-demo__intent" data-demo-intent></div>\n                    <div class="hero-demo__nodes">\n                      <div class="hero-demo__node" data-node="1" data-state="pending">\n                        <span class="hero-demo__node-icon"><i class="ti ti-inbox"></i></span>\n                        <div class="hero-demo__node-body">\n                          <span class="hero-demo__node-step">1</span>\n                          <span class="hero-demo__node-text">Mensagem recebida</span>\n                        </div>\n                      </div>\n                      <div class="hero-demo__connector" data-conn="1" aria-hidden="true"><span></span></div>\n                      <div class="hero-demo__node" data-node="2" data-state="pending">\n                        <span class="hero-demo__node-icon"><i class="ti ti-brain"></i></span>\n                        <div class="hero-demo__node-body">\n                          <span class="hero-demo__node-step">2</span>\n                          <span class="hero-demo__node-text">Identificar intenção</span>\n                        </div>\n                      </div>\n                      <div class="hero-demo__connector" data-conn="2" aria-hidden="true"><span></span></div>\n                      <div class="hero-demo__node" data-node="3" data-state="pending">\n                        <span class="hero-demo__node-icon" data-node3-icon><i class="ti ti-message-chatbot"></i></span>\n                        <div class="hero-demo__node-body">\n                          <span class="hero-demo__node-step">3</span>\n                          <span class="hero-demo__node-text" data-node3-label>Resposta automática</span>\n                        </div>\n                      </div>\n                      <div class="hero-demo__connector" data-conn="3" aria-hidden="true"><span></span></div>\n                      <div class="hero-demo__node" data-node="4" data-state="pending">\n                        <span class="hero-demo__node-icon"><i class="ti ti-circle-check"></i></span>\n                        <div class="hero-demo__node-body">\n                          <span class="hero-demo__node-step">4</span>\n                          <span class="hero-demo__node-text">Finalizar</span>\n                        </div>\n                      </div>\n                    </div>\n                  </div>\n                </div>\n              </div>\n            </div>\n          </div>\n        </div>\n      </section>\n    '
    );
  }

  function demoEls(root) {
    return {
      scenario: root.querySelector('[data-demo-scenario]'),
      state: root.querySelector('[data-demo-state]'),
      messages: root.querySelector('[data-demo-messages]'),
      intent: root.querySelector('[data-demo-intent]'),
      node3Label: root.querySelector('[data-node3-label]'),
      node3Icon: root.querySelector('[data-node3-icon]'),
    };
  }

  function setNodeState(root, n, state) {
    const el = root.querySelector('[data-node="' + n + '"]');
    if (el) el.setAttribute('data-state', state);
  }

  function setConnState(root, n, state) {
    const el = root.querySelector('[data-conn="' + n + '"]');
    if (el) el.setAttribute('data-state', state);
  }

  function resetFlow(root, scenario) {
    const d = demoEls(root);
    if (d.scenario) d.scenario.textContent = scenario.label;
    if (d.state) d.state.textContent = 'Em execução';
    if (d.intent) d.intent.textContent = '';
    if (d.messages) d.messages.innerHTML = '';
    if (d.node3Label) d.node3Label.textContent = scenario.step3Label;
    if (d.node3Icon) {
      d.node3Icon.innerHTML = '<i class="ti ' + scenario.step3Icon + '"></i>';
    }
    for (let i = 1; i <= 4; i++) setNodeState(root, i, 'pending');
    for (let i = 1; i <= 3; i++) setConnState(root, i, 'pending');
  }

  function appendMessageSafe(container, role, text, timeLabel, handoff) {
    const div = document.createElement('div');
    let cls = 'hero-demo__msg hero-demo__msg--' + (role === 'client' ? 'in' : 'out');
    if (handoff) cls += ' hero-demo__msg--handoff';
    div.className = cls;
    const p = document.createElement('p');
    p.textContent = text;
    const t = document.createElement('span');
    t.className = 'hero-demo__time';
    t.textContent = timeLabel || '';
    div.appendChild(p);
    div.appendChild(t);
    container.appendChild(div);
    requestAnimationFrame(() => div.classList.add('hero-demo__msg--show'));
    container.scrollTop = container.scrollHeight;
    return div;
  }

  function showTypingIndicator(container) {
    const el = document.createElement('div');
    el.className = 'hero-demo__typing';
    el.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'hero-demo__typing-label';
    label.textContent = 'Korvex está a escrever…';
    const dots = document.createElement('span');
    dots.className = 'hero-demo__typing-dots';
    for (let i = 0; i < 3; i++) {
      dots.appendChild(document.createElement('span'));
    }
    el.appendChild(label);
    el.appendChild(dots);
    container.appendChild(el);
    requestAnimationFrame(() => el.classList.add('hero-demo__typing--show'));
    container.scrollTop = container.scrollHeight;
    return el;
  }

  function removeTypingIndicator(el) {
    if (!el || !el.parentNode) return;
    el.parentNode.removeChild(el);
  }

  function renderStaticScenario(root, scenario) {
    resetFlow(root, scenario);
    const d = demoEls(root);
    if (d.state) d.state.textContent = 'Concluído';
    if (d.intent) d.intent.textContent = 'Intenção: ' + scenario.intent;
    appendMessageSafe(d.messages, 'client', scenario.client, '09:41', false);
    appendMessageSafe(d.messages, 'bot', scenario.bot, '09:41', scenario.humanHandoff);
    for (let i = 1; i <= 4; i++) setNodeState(root, i, 'done');
    for (let i = 1; i <= 3; i++) setConnState(root, i, 'done');
  }

  function pickNextIndex(current) {
    if (!introDone) {
      const next = current + 1;
      if (next < SCENARIOS.length) return next;
      introDone = true;
    }
    const pool = SCENARIOS.map((_, i) => i).filter((i) => SCENARIOS[i].id !== lastScenarioId);
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function runScenario(root, index) {
    if (!running || !root) return;
    if (!landingVisible()) {
      pauseDemo();
      return;
    }

    const scenario = SCENARIOS[index];
    scenarioIndex = index;
    lastScenarioId = scenario.id;
    clearTimers();
    resetFlow(root, scenario);

    const d = demoEls(root);
    const t = TIMING;
    let elapsed = 0;
    let typingEl = null;

    schedule(() => {
      if (!running) return;
      appendMessageSafe(d.messages, 'client', scenario.client, '09:41', false);
      setNodeState(root, 1, 'active');
    }, elapsed);

    elapsed += t.msgIn;
    schedule(() => {
      if (!running) return;
      setNodeState(root, 1, 'done');
      setConnState(root, 1, 'done');
      setNodeState(root, 2, 'active');
      if (d.intent) d.intent.textContent = 'A identificar intenção…';
    }, elapsed);

    elapsed += t.identify;
    schedule(() => {
      if (!running) return;
      setNodeState(root, 2, 'done');
      setConnState(root, 2, 'done');
      if (d.intent) d.intent.textContent = 'Intenção: ' + scenario.intent;
      setNodeState(root, 3, 'active');
      typingEl = showTypingIndicator(d.messages);
    }, elapsed);

    elapsed += t.typing;
    schedule(() => {
      if (!running) return;
      removeTypingIndicator(typingEl);
      typingEl = null;
      appendMessageSafe(d.messages, 'bot', scenario.bot, '09:42', scenario.humanHandoff);
    }, elapsed);

    elapsed += t.respond;
    schedule(() => {
      if (!running) return;
      setNodeState(root, 3, 'done');
      setConnState(root, 3, 'done');
      setNodeState(root, 4, 'active');
    }, elapsed);

    elapsed += t.complete;
    schedule(() => {
      if (!running) return;
      setNodeState(root, 4, 'done');
      if (d.state) d.state.textContent = 'Concluído';
    }, elapsed);

    elapsed += t.hold;
    schedule(() => {
      if (!running) return;
      if (d.state) d.state.textContent = 'A mudar de cenário…';
      if (d.messages) d.messages.classList.add('hero-demo__chat-body--fade');
    }, elapsed);

    elapsed += t.transition;
    schedule(() => {
      if (!running) return;
      if (d.messages) d.messages.classList.remove('hero-demo__chat-body--fade');
      const next = pickNextIndex(index);
      runScenario(root, next);
    }, elapsed);
  }

  function pauseDemo() {
    running = false;
    clearTimers();
  }

  function resumeDemo() {
    if (!demoRoot || prefersReducedMotion()) return;
    if (!landingVisible()) return;
    if (running) return;
    running = true;
    clearTimers();
    schedule(() => {
      if (!running || !demoRoot) return;
      runScenario(demoRoot, scenarioIndex);
    }, 200);
  }

  function startDemo(root) {
    stopDemo();
    demoRoot = root;

    if (prefersReducedMotion()) {
      renderStaticScenario(root, SCENARIOS[0]);
      return;
    }

    visibilityHandler = () => {
      if (document.hidden) {
        pauseDemo();
      } else if (landingVisible()) {
        resumeDemo();
      }
    };
    document.addEventListener('visibilitychange', visibilityHandler);

    screenHandler = (ev) => {
      const name = ev && ev.detail ? ev.detail.screen : null;
      if (name === 'landing') {
        resumeDemo();
      } else {
        pauseDemo();
      }
    };
    document.addEventListener('korvex:screen-changed', screenHandler);

    introDone = false;
    scenarioIndex = 0;
    lastScenarioId = null;
    running = true;
    runScenario(root, 0);
  }

  function stopDemo() {
    running = false;
    clearTimers();
    if (visibilityHandler) {
      document.removeEventListener('visibilitychange', visibilityHandler);
      visibilityHandler = null;
    }
    if (screenHandler) {
      document.removeEventListener('korvex:screen-changed', screenHandler);
      screenHandler = null;
    }
  }

  function dispatchNavigate(payload) {
    document.dispatchEvent(new CustomEvent('korvex:navigate', { detail: payload }));
  }

  function bindEvents(root, content) {
    const ctaMap = {
      primary: content.primaryCta.navigate,
      secondary: content.secondaryCta.navigate,
    };
    root.querySelectorAll('[data-hero-cta]').forEach((btn) => {
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
    stopDemo();
    root.innerHTML = template(HERO_CONTENT);
    bindEvents(root, HERO_CONTENT);
    playEntranceAnimation(root);
    startDemo(root);
  }

  return { mount, stopDemo };
})();

document.addEventListener('DOMContentLoaded', Hero.mount);
