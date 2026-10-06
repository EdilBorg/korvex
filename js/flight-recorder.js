/**
 * KORVEX FLIGHT RECORDER
 * Sistema temporário de auditoria - sem alteração de lógica
 * Registra eventos críticos para análise de comportamento
 * 
 * REMOVÍVEL: Delete este arquivo e remova as chamadas de recordEvent() dos outros módulos
 */

class FlightRecorder {
  constructor() {
    this.enabled = true;
    this.events = [];
    this.maxEvents = 5000;
    this.startTime = Date.now();
    this.state = {
      auth: {},
      subscription: {},
      cachedSubscription: {},
      adminGuard: {},
      currentUser: {},
      firestore: { operations: [] },
      ui: { screens: [], current: null, previous: null },
      connections: { active: 0, listeners: [] },
      inbox: { active: false, listeners: 0 },
      flowRepository: { active: false }
    };
  }

  /**
   * Registra um evento crítico
   * @param {string} category - AUTH, SUBSCRIPTION, FIRESTORE, ADMINGUARD, UI, CONNECTIONS, INBOX, FLOW
   * @param {string} event - Nome do evento
   * @param {object} data - Dados do evento (uid, email, etc)
   * @param {string} module - Módulo que originou o evento
   */
  recordEvent(category, event, data = {}, module = 'unknown') {
    if (!this.enabled) return;

    const timestamp = this._getTimestamp();
    const record = {
      timestamp,
      category,
      event,
      module,
      data,
      seq: this.events.length + 1
    };

    this.events.push(record);
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }

    this._logToConsole(timestamp, category, event, module, data);
  }

  /**
   * Registra transição de tela
   */
  recordUITransition(fromScreen, toScreen) {
    this.state.ui.previous = this.state.ui.current;
    this.state.ui.current = toScreen;
    
    this.recordEvent('UI', 'screen_transition', {
      from: fromScreen,
      to: toScreen,
      timestamp: Date.now()
    }, 'ScreenManager');
  }

  /**
   * Registra operação Firestore
   */
  recordFirestore(operation, path, sentDoc = null, receivedDoc = null, duration = 0, error = null) {
    const record = {
      operation,
      path,
      sentDoc,
      receivedDoc,
      duration,
      error,
      timestamp: Date.now()
    };

    this.state.firestore.operations.push(record);
    if (this.state.firestore.operations.length > 500) {
      this.state.firestore.operations.shift();
    }

    const success = error === null;
    this.recordEvent('FIRESTORE', `${operation.toUpperCase()}`, {
      path,
      success,
      duration: `${duration}ms`,
      error: error ? error.message : null,
      docSize: sentDoc ? JSON.stringify(sentDoc).length : 0
    }, 'FirestoreService');
  }

  /**
   * Registra listener de Firestore
   */
  recordFirestoreListener(path, action, count = 0) {
    this.recordEvent('FIRESTORE', `listener_${action}`, {
      path,
      activeListeners: count
    }, 'FirestoreListeners');
  }

  /**
   * Registra Auth event
   */
  recordAuth(event, data = {}) {
    if (data.uid) this.state.auth.uid = data.uid;
    if (data.email) this.state.auth.email = data.email;
    if (typeof data.authenticated !== 'undefined') {
      this.state.auth.previousAuth = this.state.auth.authenticated;
      this.state.auth.authenticated = data.authenticated;
    }

    this.recordEvent('AUTH', event, data, 'AuthService');
  }

  /**
   * Registra Subscription event
   */
  recordSubscription(event, data = {}) {
    this.recordEvent('SUBSCRIPTION', event, {
      uid: data.uid,
      plan: data.plan,
      expiresAt: data.expiresAt,
      source: data.source,
      cachedSubscription: data.cachedSubscription
    }, 'SubscriptionService');

    if (data.cached !== undefined) {
      this.state.cachedSubscription = { ...this.state.cachedSubscription, ...data.cached };
    }
  }

  /**
   * Registra AdminGuard event
   */
  recordAdminGuard(event, data = {}) {
    const cacheEntry = {
      uid: data.uid,
      result: data.result,
      previousCache: data.previousCache,
      newCache: data.newCache
    };

    this.recordEvent('ADMINGUARD', event, cacheEntry, 'AdminGuard');
  }

  /**
   * Registra Connection event
   */
  recordConnection(event, data = {}) {
    if (data.activeListeners !== undefined) {
      this.state.connections.active = data.activeListeners;
    }
    this.recordEvent('CONNECTIONS', event, data, 'ConnectionService');
  }

  /**
   * Registra Inbox event
   */
  recordInbox(event, data = {}) {
    if (event === 'init') this.state.inbox.active = true;
    if (event === 'destroy') this.state.inbox.active = false;
    if (data.listeners !== undefined) this.state.inbox.listeners = data.listeners;

    this.recordEvent('INBOX', event, data, 'InboxView');
  }

  /**
   * Registra Flow event
   */
  recordFlow(event, data = {}) {
    if (event === 'init') this.state.flowRepository.active = true;
    if (event === 'destroy') this.state.flowRepository.active = false;

    this.recordEvent('FLOW', event, data, 'FlowRepository');
  }

  /**
   * Atualiza state externo
   */
  updateState(section, data) {
    if (this.state[section]) {
      this.state[section] = { ...this.state[section], ...data };
    }
  }

  /**
   * Formata timestamp com milissegundos
   */
  _getTimestamp() {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const mins = String(now.getMinutes()).padStart(2, '0');
    const secs = String(now.getSeconds()).padStart(2, '0');
    const ms = String(now.getMilliseconds()).padStart(3, '0');
    return `${hours}:${mins}:${secs}.${ms}`;
  }

  /**
   * Log formatado para console
   */
  _logToConsole(timestamp, category, event, module, data) {
    const uid = data.uid || '';
    const email = data.email || '';
    
    let logMsg = `[KORVEX TRACE] [${timestamp}] ${category.padEnd(12)} | ${event.padEnd(25)} | ${module.padEnd(20)}`;
    
    if (uid) logMsg += ` | uid=${uid}`;
    if (email) logMsg += ` | email=${email}`;

    const style = this._getCategoryStyle(category);
    console.log(`%c${logMsg}`, style);

    // Log adicional com dados se existirem
    if (Object.keys(data).length > 0) {
      console.log(`%c  └─ Data: %O`, 'color: #888; font-size: 11px', data);
    }
  }

  /**
   * Cores para diferentes categorias
   */
  _getCategoryStyle(category) {
    const colors = {
      'AUTH': 'color: #FF6B6B; font-weight: bold; font-size: 12px',
      'SUBSCRIPTION': 'color: #4ECDC4; font-weight: bold; font-size: 12px',
      'FIRESTORE': 'color: #FFE66D; font-weight: bold; font-size: 12px; background: #1a1a1a',
      'ADMINGUARD': 'color: #A8E6CF; font-weight: bold; font-size: 12px',
      'UI': 'color: #95E1D3; font-weight: bold; font-size: 12px',
      'CONNECTIONS': 'color: #F38181; font-weight: bold; font-size: 12px',
      'INBOX': 'color: #AA96DA; font-weight: bold; font-size: 12px',
      'FLOW': 'color: #FCBAD3; font-weight: bold; font-size: 12px'
    };
    return colors[category] || 'color: #999; font-size: 12px';
  }

  /**
   * Exporta snapshot completo do estado
   */
  exportSnapshot() {
    return {
      exportedAt: new Date().toISOString(),
      uptime: Date.now() - this.startTime,
      eventCount: this.events.length,
      time: this._getTimestamp(),
      auth: { ...this.state.auth },
      subscription: { ...this.state.subscription },
      cachedSubscription: { ...this.state.cachedSubscription },
      adminGuard: { ...this.state.adminGuard },
      currentUser: { ...this.state.auth }, // alias para auth
      firestore: {
        lastOperations: this.state.firestore.operations.slice(-10)
      },
      ui: { ...this.state.ui },
      connections: { ...this.state.connections },
      inbox: { ...this.state.inbox },
      flowRepository: { ...this.state.flowRepository },
      recentEvents: this.events.slice(-50) // últimos 50 eventos
    };
  }

  /**
   * Exporta todos os eventos para download
   */
  exportAll() {
    return {
      exportedAt: new Date().toISOString(),
      uptime: Date.now() - this.startTime,
      totalEvents: this.events.length,
      snapshot: this.exportSnapshot(),
      allEvents: this.events
    };
  }

  /**
   * Limpa logs (para quando desativar o Flight Recorder)
   */
  clear() {
    this.events = [];
    this.state = {
      auth: {},
      subscription: {},
      cachedSubscription: {},
      adminGuard: {},
      currentUser: {},
      firestore: { operations: [] },
      ui: { screens: [], current: null, previous: null },
      connections: { active: 0, listeners: [] },
      inbox: { active: false, listeners: 0 },
      flowRepository: { active: false }
    };
  }

  /**
   * Desativa/ativa o Flight Recorder
   */
  setEnabled(enabled) {
    this.enabled = enabled;
    console.log(`[KORVEX TRACE] Flight Recorder ${enabled ? 'ATIVADO' : 'DESATIVADO'}`);
  }

  /**
   * Status do Flight Recorder
   */
  getStatus() {
    return {
      enabled: this.enabled,
      eventCount: this.events.length,
      maxEvents: this.maxEvents,
      uptime: Date.now() - this.startTime,
      state: this.state
    };
  }
}

// Instância global
const korvexFlightRecorder = new FlightRecorder();

/**
 * Função global para exportar snapshot
 * Acesso: window.exportKorvexSnapshot()
 */
window.exportKorvexSnapshot = function() {
  return korvexFlightRecorder.exportSnapshot();
};

/**
 * Função global para exportar tudo
 * Acesso: window.exportKorvexAll()
 */
window.exportKorvexAll = function() {
  return korvexFlightRecorder.exportAll();
};

/**
 * Função global para controle
 * Acesso: window.korvexControl
 */
window.korvexControl = {
  enable: () => korvexFlightRecorder.setEnabled(true),
  disable: () => korvexFlightRecorder.setEnabled(false),
  clear: () => korvexFlightRecorder.clear(),
  status: () => korvexFlightRecorder.getStatus(),
  snapshot: () => window.exportKorvexSnapshot(),
  exportAll: () => window.exportKorvexAll()
};

console.log('[KORVEX TRACE] Flight Recorder carregado. Use window.korvexControl ou window.exportKorvexSnapshot()');
