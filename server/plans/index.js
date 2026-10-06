/* ══════════════════════════════════════════════════════════════════════
   plans/index.js — Ponto de entrada do módulo de planos
   ────────────────────────────────────────────────────────────────────
   Exporta tudo o que o resto da aplicação precisa para verificar
   e gerir planos de subscrição.

   Uso típico:
     const { checkPlanAccess, FEATURES, PLANS } = require('../plans');
   ══════════════════════════════════════════════════════════════════════ */

const { PLANS, FEATURES, PLAN_RULES, PLAN_CONFIG }  = require('./constants');
const { checkPlanAccess, invalidatePlanCache,
        setFirestore, _getPlanForAccount }          = require('./checkPlanAccess');

module.exports = {
  // Constantes
  PLANS,
  FEATURES,
  PLAN_RULES,
  PLAN_CONFIG,

  // Funções
  checkPlanAccess,
  invalidatePlanCache,
  setFirestore,

  // Interno (útil para scripts de admin/debug)
  _getPlanForAccount,
};
