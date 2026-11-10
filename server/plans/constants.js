/* ══════════════════════════════════════════════════════════════════════
   plans/constants.js — Constantes e enums de planos de subscrição
   ────────────────────────────────────────────────────────────────────
   Fonte única de verdade para nomes de planos e funcionalidades
   controladas. Nunca usar strings soltas no código de verificação.
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Enum dos planos disponíveis.
 * Estes valores são os que ficam gravados no Firestore por conta.
 *
 * TRIAL     — novo cliente, ainda não pagou. Sem IA, 1 número WhatsApp.
 * PRO       — cliente com subscrição paga (800 MT, 30 dias). IA desbloqueada, 4M tokens, 1 número.
 * PREMIUM   — cliente com subscrição premium (1500 MT, 30 dias). IA, 10M tokens, 2 números WhatsApp.
 * EXPIRED   — plano expirado. Sem acesso a nada. Dados preservados.
 * SUSPENDED — cliente com pagamento em falta. Sem acesso a nada. Dados preservados.
 * ADMIN     — Acesso total — sem restrições de plano
 */
const PLANS = Object.freeze({
  TRIAL:     'trial',
  PRO:       'pro',
  PREMIUM:   'premium',
  EXPIRED:   'expired',
  SUSPENDED: 'suspended',
  ADMIN:     'admin',
});

/**
 * Enum das funcionalidades controladas por plano.
 * Usado como segundo argumento de checkPlanAccess(accountId, feature).
 */
const FEATURES = Object.freeze({
  AI:                      'ai',
  WHATSAPP_SECOND_NUMBER:  'whatsapp_second_number',
  WORKFLOW_EXECUTION:      'workflow_execution',
});

/**
 * Limites e permissões por plano.
 * Centraliza toda a lógica do que cada plano permite,
 * sem hardcodes espalhados pelo código.
 */
const PLAN_RULES = Object.freeze({
  [PLANS.TRIAL]: {
    [FEATURES.AI]:                     false,
    [FEATURES.WHATSAPP_SECOND_NUMBER]: false,
    [FEATURES.WORKFLOW_EXECUTION]:     true,
    maxWhatsappNumbers: 1,
  },
  [PLANS.PRO]: {
    [FEATURES.AI]:                     true,
    [FEATURES.WHATSAPP_SECOND_NUMBER]: false,
    [FEATURES.WORKFLOW_EXECUTION]:     true,
    maxWhatsappNumbers: 1,
  },
  [PLANS.PREMIUM]: {
    [FEATURES.AI]:                     true,
    [FEATURES.WHATSAPP_SECOND_NUMBER]: true,
    [FEATURES.WORKFLOW_EXECUTION]:     true,
    maxWhatsappNumbers: 2,
  },
  [PLANS.EXPIRED]: {
    [FEATURES.AI]:                     false,
    [FEATURES.WHATSAPP_SECOND_NUMBER]: false,
    [FEATURES.WORKFLOW_EXECUTION]:     false,
    maxWhatsappNumbers: 0,
  },
  [PLANS.SUSPENDED]: {
    [FEATURES.AI]:                     false,
    [FEATURES.WHATSAPP_SECOND_NUMBER]: false,
    [FEATURES.WORKFLOW_EXECUTION]:     false,
    maxWhatsappNumbers: 0,
  },
  [PLANS.ADMIN]: {
    [FEATURES.AI]:                     true,
    [FEATURES.WHATSAPP_SECOND_NUMBER]: true,
    [FEATURES.WORKFLOW_EXECUTION]:     true,
    maxWhatsappNumbers: Infinity,       // sem limite
  },
});

/**
 * Configuração central de planos — fonte única de verdade
 * Contém: preço, duração, limites de tokens, números WhatsApp
 * Usado por: Payments, Admin Panel, Dashboard, Credit Manager
 */
const PLAN_CONFIG = Object.freeze({
  [PLANS.TRIAL]: {
    name:                'Trial',
    priceInMT:           0,
    durationDays:        3,
    monthlyAITokens:     0,
    maxWhatsappNumbers:  1,
    unlimitedWorkflows:  true,
    description:         '3 dias grátis para testar',
  },
  [PLANS.PRO]: {
    name:                'Pro',
    priceInMT:           800,
    durationDays:        30,
    monthlyAITokens:     4000000,
    maxWhatsappNumbers:  1,
    unlimitedWorkflows:  true,
    description:         '1 número, IA, 4M tokens/mês',
  },
  [PLANS.PREMIUM]: {
    name:                'Premium',
    priceInMT:           1500,
    durationDays:        30,
    monthlyAITokens:     10000000,
    maxWhatsappNumbers:  2,
    unlimitedWorkflows:  true,
    description:         '2 números, IA, 10M tokens/mês',
  },
  [PLANS.EXPIRED]: {
    name:                'Expirado',
    priceInMT:           0,
    durationDays:        0,
    monthlyAITokens:     0,
    maxWhatsappNumbers:  0,
    unlimitedWorkflows:  false,
    description:         'Plano expirado — renove para continuar',
  },
  [PLANS.SUSPENDED]: {
    name:                'Suspenso',
    priceInMT:           0,
    durationDays:        0,
    monthlyAITokens:     0,
    maxWhatsappNumbers:  0,
    unlimitedWorkflows:  false,
    description:         'Conta suspensa — contacte o suporte',
  },
  [PLANS.ADMIN]: {
    name:                'Admin',
    priceInMT:           0,
    durationDays:        Infinity,
    monthlyAITokens:     Infinity,
    maxWhatsappNumbers:  Infinity,
    unlimitedWorkflows:  true,
    description:         'Acesso total sem restrições',
  },
});

module.exports = { PLANS, FEATURES, PLAN_RULES, PLAN_CONFIG };
