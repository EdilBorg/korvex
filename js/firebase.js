/* FASE 2.7 — Versão oficial dos Termos de Uso e Política de Privacidade. */
const CURRENT_TERMS_VERSION = "2026.1";

/* ══════════════════════════════════════════════════════════════════
   FASE 3.0.1 — FirebaseCore + AuthService
   ──────────────────────────────────────────────────────────────────
   Módulos totalmente isolados. Não alteram nenhum módulo existente.
   Preparados para substituir FlowStorage na futura migração.
   ══════════════════════════════════════════════════════════════════ */

const FirebaseCore = (() => {
  let app  = null;
  let auth = null;
  let db   = null;

  function init() {
    if (app) return; // já inicializado
    const firebaseConfig = {
      apiKey:            'AIzaSyA28mZTe59O6IHN0aq_V9k4YyEiAENH8lk',
      authDomain:        'korvex-ebf.firebaseapp.com',
      projectId:         'korvex-ebf',
      storageBucket:     'korvex-ebf.firebasestorage.app',
      messagingSenderId: '323198974657',
      appId:             '1:323198974657:web:3d48a1cbda99ead9e5b240',
      measurementId:     'G-V7554K80WJ',
    };

    try {
      // Usa a API compat (window.firebase) — sem módulos ES
      if (typeof firebase === 'undefined') {
        console.warn('[FirebaseCore] SDK não carregado. A funcionar em modo offline.');
        return;
      }
      app  = firebase.initializeApp(firebaseConfig);
      auth = firebase.auth();
      db   = firebase.firestore();
      console.info('[FirebaseCore] Inicializado com sucesso.');
    } catch (e) {
      console.error('[FirebaseCore] Erro ao inicializar:', e.message);
    }
  }

  function getAuth() { return auth; }
  function getDb()   { return db;   }
  function getApp()  { return app;  }
  function isReady() { return app !== null; }

  return { init, getAuth, getDb, getApp, isReady };
})();

/* ──────────────────────────────────────────────────────────────────
   AuthService
   Abstracção sobre firebase.auth().
   Toda a autenticação do Korvex passa por aqui.
   Firebase-ready; funciona em stub enquanto as credenciais
   não forem configuradas.
   ────────────────────────────────────────────────────────────────── */