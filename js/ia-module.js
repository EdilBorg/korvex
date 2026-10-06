/* ══════════════════════════════════════════════════════════════════════════════════════
   MÓDULO IA — Korvex Inteligência Artificial
   ────────────────────────────────────────────────────────────────────────────────────
   
   Gerenciamento profissional de:
   • Conhecimento/Contexto da IA
   • Ativação/Desativação
   • Tokens (usando a mesma fonte que o Analytics — ai_credits)
   • Histórico de compras
   
   Dados armazenados em Firestore:
   └─ workspaces/{uid}/settings/ia
      ├─ enabled: boolean
      ├─ knowledge: string (contexto/prompt)
      └─ updatedAt: timestamp
   
   └─ workspaces/{uid}  (nested field ai_credits)
      ├─ ai_credits.monthly_limit
      ├─ ai_credits.monthly_used
      ├─ ai_credits.daily_limit
      ├─ ai_credits.daily_used
      └─ ... (compartilhado com Dashboard e Analytics)
   
   └─ workspaces/{uid}/ai_purchases (collection)
      ├─ date: timestamp
      ├─ package: string (pkg_2m | pkg_4m | pkg_8m)
      ├─ tokens: number
      ├─ value: number (preço em MT)
      ├─ method: string (mpesa | emola | paysuite)
      └─ status: string (pending | approved | failed)
   ════════════════════════════════════════════════════════════════════════════════════ */

const IAModule = (() => {
  let _uid = null;

  // ─────────────────────────────────────────────────────────────────────────
  // FIRESTORE REFS
  // ─────────────────────────────────────────────────────────────────────────

  const _refs = {
    settingsAI: () => FirebaseCore.getDb()
      .collection('workspaces').doc(_uid)
      .collection('settings').doc('ia'),
    
    workspace: () => FirebaseCore.getDb()
      .collection('workspaces').doc(_uid),
    
    purchases: () => FirebaseCore.getDb()
      .collection('workspaces').doc(_uid)
      .collection('ai_purchases'),
  };

  // ─────────────────────────────────────────────────────────────────────────
  // INIT
  // ─────────────────────────────────────────────────────────────────────────

  async function init(uid) {
    _uid = uid;
    await _ensureDefaults();
  }

  async function _ensureDefaults() {
    if (!_uid) return;
    try {
      // Garantir que documento de settings existe
      const settingsSnap = await _refs.settingsAI().get();
      if (!settingsSnap.exists) {
        await _refs.settingsAI().set({
          enabled: false,
          knowledge: '',
          updatedAt: Date.now(),
        });
      }
    } catch (e) {
      console.error('[IAModule] Erro ao criar defaults:', e);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // KNOWLEDGE (CONHECIMENTO)
  // ─────────────────────────────────────────────────────────────────────────

  async function getKnowledge() {
    if (!_uid) return '';
    try {
      const snap = await _refs.settingsAI().get();
      return snap.exists ? (snap.data().knowledge || '') : '';
    } catch (e) {
      console.error('[IAModule] Erro ao carregar conhecimento:', e);
      return '';
    }
  }

  async function saveKnowledge(text) {
    if (!_uid) return false;
    try {
      await _refs.settingsAI().set({
        knowledge: (text || '').trim(),
        updatedAt: Date.now(),
      }, { merge: true });
      return true;
    } catch (e) {
      console.error('[IAModule] Erro ao salvar conhecimento:', e);
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TOKENS — Leitura da mesma fonte que o Dashboard (ai_credits)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Carrega os dados de tokens do backend — MESMA FONTE que Analytics.
   * Sempre retorna a estrutura completa, mesmo se houver erros.
   * 
   * ✅ ARQUITETURA: Chama GET /accounts/:uid/credits/status que usa
   * creditManager.getUsageSummary() — garantido ser a mesma origem dos dados.
   */
  async function getTokens() {
    if (!_uid) return _defaultTokens();
    
    try {
      // ✅ IMPORTANTE: Chamar o endpoint do backend
      // Garante que usa creditManager.getUsageSummary() — mesma fonte que Analytics
      const BACKEND_URL = window._KORVEX_BACKEND_URL || 'http://localhost:3001';
      const res = await fetch(`${BACKEND_URL}/accounts/${_uid}/credits/status`);

      if (!res.ok) {
        console.error('[IAModule] Erro HTTP ao carregar tokens:', res.status, res.statusText);
        return _defaultTokens();
      }

      const data = await res.json();
      
      if (!data.ok) {
        console.error('[IAModule] Resposta do backend com erro:', data.error);
        return _defaultTokens();
      }

      // ────────────────────────────────────────────────────────────────
      // MAPEAMENTO: O backend retorna os campos corretos do creditManager
      // ────────────────────────────────────────────────────────────────

      // PLANO (mensal, da assinatura — reseta automáticamente)
      const planLimit = data.plan_limit || 0;
      const planUsed = data.plan_used || 0;
      const planRemaining = data.plan_remaining || Math.max(0, planLimit - planUsed);

      // EXTRAS (comprados — nunca expiram, nunca resetam)
      const extraLimit = data.extra_limit || 0;
      const extraUsed = data.extra_used || 0;
      const extraRemaining = data.extra_remaining || Math.max(0, extraLimit - extraUsed);

      // TOTAL DISPONÍVEL = plano restante + extras restante
      const totalAvailable = planRemaining + extraRemaining;

      // Log para debug (mostrar que os valores são reais)
      console.log(
        `[IAModule] Tokens carregados: ` +
        `Plano=${planRemaining}/${planLimit}, ` +
        `Extras=${extraRemaining}/${extraLimit}, ` +
        `Total=${totalAvailable}`
      );

      return {
        // Valores para renderização simples (Plano | Extras | Total)
        planTokens: planRemaining,         // Tokens do plano DISPONÍVEIS
        tokensExtras: extraRemaining,      // Tokens extras DISPONÍVEIS
        totalAvailable: totalAvailable,    // Total DISPONÍVEL

        // Dados estruturados para análise detalhada
        plan: {
          limit: planLimit,
          used: planUsed,
          available: planRemaining,
        },
        extras: {
          limit: extraLimit,
          used: extraUsed,
          available: extraRemaining,
        },
        monthly: {
          limit: data.monthly_limit || 0,
          used: data.monthly_used || 0,
          available: data.monthly_remaining || 0,
        },
        daily: {
          limit: data.daily_limit || 0,
          used: data.daily_used || 0,
          available: data.daily_remaining || 0,
        },
        
        // Metadados
        warning_level: data.warning_level || 'none',
        estimated_cost_usd: data.estimated_cost_usd || 0,
        last_monthly_reset: data.last_monthly_reset || null,
        last_daily_reset: data.last_daily_reset || null,
      };
    } catch (e) {
      console.error('[IAModule] Erro crítico ao carregar tokens:', e);
      return _defaultTokens();
    }
  }

  // Helper: retorna estrutura padrão com todos os zeros
  function _defaultTokens() {
    return {
      planTokens: 0,
      tokensExtras: 0,
      totalAvailable: 0,
      plan: { limit: 0, used: 0, available: 0 },
      extras: { limit: 0, used: 0, available: 0 },
      monthly: { limit: 0, used: 0, available: 0 },
      daily: { limit: 0, used: 0, available: 0 },
      warning_level: 'none',
      estimated_cost_usd: 0,
      last_monthly_reset: null,
      last_daily_reset: null,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STATUS (ENABLED/DISABLED)
  // ─────────────────────────────────────────────────────────────────────────

  async function isEnabled() {
    if (!_uid) return false;
    try {
      const snap = await _refs.settingsAI().get();
      if (!snap.exists) return false;
      
      // Verificar plano — TRIAL não tem acesso à IA
      const subSnap = await db.collection('workspaces').doc(_uid)
        .collection('settings').doc('subscription').get();
      if (subSnap.exists && subSnap.data().plan === 'trial') {
        return false; // TRIAL não pode usar IA
      }
      
      // Só pode estar ativada se tiver créditos
      const tokens = await getTokens();
      return snap.data().enabled === true && tokens && tokens.totalAvailable > 0;
    } catch (e) {
      return false;
    }
  }

  async function setEnabled(enabled) {
    if (!_uid) return false;
    try {
      // Se tentar ativar, verificar plano e créditos
      if (enabled === true) {
        // Verificar plano — TRIAL não pode ativar IA
        const subSnap = await db.collection('workspaces').doc(_uid)
          .collection('settings').doc('subscription').get();
        if (subSnap.exists && subSnap.data().plan === 'trial') {
          console.warn('[IAModule] Tentativa de ativar IA em conta TRIAL — bloqueado');
          return false;
        }

        // Verificar créditos
        const tokens = await getTokens();
        if (!tokens || tokens.totalAvailable <= 0) {
          console.warn('[IAModule] Tentativa de ativar IA sem tokens');
          return false;
        }
      }

      await _refs.settingsAI().set({
        enabled: !!enabled,
        updatedAt: Date.now(),
      }, { merge: true });
      return true;
    } catch (e) {
      console.error('[IAModule] Erro ao atualizar status:', e);
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // HISTÓRICO
  // ─────────────────────────────────────────────────────────────────────────

  async function getPurchases() {
    if (!_uid) return [];
    try {
      const snap = await _refs.purchases().get();
      const docs = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      // Ordenar por data decrescente (mais recentes primeiro)
      return docs.sort((a, b) => (b.date || 0) - (a.date || 0));
    } catch (e) {
      console.error('[IAModule] Erro ao carregar histórico:', e);
      return [];
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CONSUMO (não implementar no frontend — feito no servidor)
  // ─────────────────────────────────────────────────────────────────────────

  async function disableIfNoTokens() {
    if (!_uid) return;
    try {
      const tokens = await getTokens();
      if (tokens && tokens.totalAvailable <= 0) {
        await setEnabled(false);
      }
    } catch (e) {
      console.error('[IAModule] Erro ao desativar:', e);
    }
  }

  return {
    init,
    getKnowledge,
    saveKnowledge,
    getTokens,
    isEnabled,
    setEnabled,
    getPurchases,
    disableIfNoTokens,
  };
})();
