/* ══════════════════════════════════════════════════════════════════════
   plans/checkPlanAccess.js — Verificação server-side de acesso por plano
   ────────────────────────────────────────────────────────────────────
   Função central: checkPlanAccess(accountId, feature)
   
   Toda a verificação de plano acontece EXCLUSIVAMENTE aqui, no servidor.
   O cliente NUNCA é fonte de verdade sobre o plano — apenas recebe
   respostas de sucesso ou erro do servidor.

   Estrutura Firestore:
     workspaces/{accountId}/settings/subscription
       → { plan: 'trial' | 'premium', updatedAt: Timestamp }

   Se o documento não existir, assume-se TRIAL (mais restritivo = seguro).
   ══════════════════════════════════════════════════════════════════════ */

const { PLANS, FEATURES, PLAN_RULES } = require('./constants');
const logger = require('../engine/logger');

let _db = null;

/**
 * Injeta a instância do Firestore.
 * Chamado a partir de server/index.js após o Firebase Admin estar pronto.
 * @param {import('firebase-admin').firestore.Firestore} db
 */
function setFirestore(db) {
  _db = db;
}

// Cache de planos por accountId (TTL: 30 segundos)
// Evita uma leitura Firestore em cada mensagem recebida.
const _planCache = new Map();
const PLAN_CACHE_TTL_MS = 30 * 1000;

/**
 * Obtém o plano actual de uma conta, com cache.
 * Se o Firestore não estiver configurado ou o documento não existir,
 * devolve TRIAL como fallback seguro.
 *
 * @param {string} accountId - UID da conta (workspaceId)
 * @returns {Promise<string>} - Um dos valores de PLANS
 */
async function _getPlanForAccount(accountId) {
  // Verificar cache
  const cached = _planCache.get(accountId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.plan;
  }

  // Fallback seguro: sem Firestore → TRIAL
  if (!_db) {
    logger.warn({ accountId }, '[Plans] Firestore não configurado — assumindo plano TRIAL');
    return PLANS.TRIAL;
  }

  try {
    const snap = await _db
      .collection('workspaces')
      .doc(accountId)
      .collection('settings')
      .doc('subscription')
      .get();

    let plan = PLANS.TRIAL; // fallback seguro se documento não existir

    if (snap.exists) {
      const data = snap.data();
      // Validar que o plano gravado é um valor conhecido; caso contrário, TRIAL
      const rawPlan = Object.values(PLANS).includes(data?.plan)
        ? data.plan
        : PLANS.TRIAL;

      // Se o plano tem data de expiração e já passou → EXPIRED
      // (premium/pro expirado = sem acesso, dados preservados)
      if (
        (rawPlan === PLANS.PRO || rawPlan === PLANS.PREMIUM || rawPlan === PLANS.TRIAL) &&
        rawPlan !== PLANS.ADMIN &&
        data.expiresAt &&
        data.expiresAt <= Date.now()
      ) {
        plan = PLANS.EXPIRED;
        logger.info({ accountId, rawPlan }, '[Plans] Plano expirado — tratado como EXPIRED');
      } else {
        plan = rawPlan;
      }
    }

    // Guardar em cache
    _planCache.set(accountId, {
      plan,
      expiresAt: Date.now() + PLAN_CACHE_TTL_MS,
    });

    return plan;
  } catch (e) {
    logger.error({ accountId, err: e.message }, '[Plans] Erro ao ler plano — assumindo TRIAL');
    return PLANS.TRIAL;
  }
}

/**
 * Invalida o cache de plano para uma conta.
 * Deve ser chamado sempre que o plano de uma conta for alterado
 * (ex.: upgrade/downgrade via painel de admin).
 *
 * @param {string} accountId
 */
function invalidatePlanCache(accountId) {
  _planCache.delete(accountId);
  logger.info({ accountId }, '[Plans] Cache de plano invalidado');
}

/**
 * Verifica se uma conta tem acesso a uma determinada funcionalidade,
 * com base no seu plano de subscrição.
 *
 * Esta é a função pública a usar em toda a aplicação.
 * Toda a verificação acontece no servidor — nunca confiar no cliente.
 *
 * @param {string} accountId - UID da conta (workspaceId)
 * @param {string} feature   - Uma das constantes de FEATURES
 * @returns {Promise<{ allowed: boolean, plan: string, reason?: string }>}
 *
 * @example
 *   const { allowed } = await checkPlanAccess(uid, FEATURES.AI);
 *   if (!allowed) return res.status(403).json({ ok: false, error: 'Plano Trial não inclui IA.' });
 */
async function checkPlanAccess(accountId, feature) {
  // Validar feature conhecida
  if (!Object.values(FEATURES).includes(feature)) {
    logger.warn({ accountId, feature }, '[Plans] Feature desconhecida solicitada');
    return { allowed: false, plan: PLANS.TRIAL, reason: `Feature desconhecida: ${feature}` };
  }

  const plan = await _getPlanForAccount(accountId);
  const rules = PLAN_RULES[plan];

  if (!rules) {
    // Plano sem regras definidas → negar por segurança
    logger.error({ accountId, plan }, '[Plans] Plano sem regras definidas — acesso negado');
    return { allowed: false, plan, reason: `Plano ${plan} sem regras definidas` };
  }

  const allowed = rules[feature] === true;

  if (!allowed) {
    logger.info(
      { accountId, plan, feature },
      '[Plans] Acesso negado — funcionalidade não incluída no plano'
    );
  }

  return { allowed, plan };
}

module.exports = {
  checkPlanAccess,
  invalidatePlanCache,
  setFirestore,
  // Expor para uso em admin/scripts
  _getPlanForAccount,
};
