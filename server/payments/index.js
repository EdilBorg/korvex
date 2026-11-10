
/* ══════════════════════════════════════════════════════════════════════
   server/payments/index.js — Orquestração de pagamentos Korvex ↔ PaySuite
   ────────────────────────────────────────────────────────────────────
   Suporta:
     1. Subscrições Premium
     2. Compra de tokens IA

   Fluxo:
     Frontend → POST /payments/{subscribe|buyTokens} → PaySuite (cria pagamento)
     PaySuite → POST /payments/webhook → activa/registra falha

   Estruturas Firestore:
     workspaces/{uid}/settings/subscription
       { plan: 'premium', expiresAt, updatedAt, daysRemaining }
     workspaces/{uid}
       { ai_credits: { monthly_limit, monthly_used, daily_limit, daily_used, ... } }
     workspaces/{uid}/ai_purchases/{purchaseId}
       { date, package, tokens, value, method, status }
     workspaces/{uid}/payments/{paymentId}
       { type, method, amount, status, reference, transactionId, createdAt }
   ════════════════════════════════════════════════════════════════════ */

const paysuite = require('./paysuite');
const { TOKEN_PACKAGES } = require('../credits/tokenPackages');
const creditManager = require('../credits/creditManager');
const { PLANS, PLAN_CONFIG } = require('../plans');

// Helper para obter preço e dias baseado no plano
function _getPlanPriceAndDays(plan) {
  const cfg = PLAN_CONFIG[plan];
  if (!cfg) throw new Error(`[Payments] Plano inválido: ${plan}`);
  return { priceInMT: cfg.priceInMT, durationDays: cfg.durationDays };
}

let _db = null;
function setFirestore(db) { _db = db; }

function _subscriptionRef(uid) {
  if (!_db) return null;
  return _db.collection('workspaces').doc(uid).collection('settings').doc('subscription');
}

function _paymentsCol(uid) {
  if (!_db) return null;
  return _db.collection('workspaces').doc(uid).collection('payments');
}

// A PaySuite exige reference "apenas letras e números" (rejeita "__" e
// outros separadores). Em vez de embutir o uid na reference, mantemos
// um índice à parte — reference = paymentId (já é alfanumérico, gerado
// pelo Firestore) e este documento faz a ponte reference → uid.
function _paymentIndexRef(paymentId) {
  if (!_db) return null;
  return _db.collection('paymentIndex').doc(paymentId);
}

/**
 * Função genérica: inicia um pagamento (subscrição ou compra de tokens)
 * type: 'subscription' | 'token_purchase'
 * amount: valor em MT
 * metadata: { packageId (para tokens), ... }
 */
async function startPayment({ uid, type, method, amount, metadata = {}, description, returnUrl, callbackUrl }) {
  if (!uid) return { ok: false, error: 'uid em falta.' };
  if (!type || !['subscription', 'token_purchase'].includes(type)) {
    return { ok: false, error: 'Tipo de pagamento inválido.' };
  }
  if (method && !['mpesa', 'emola', 'credit_card'].includes(method)) {
    return { ok: false, error: 'Método de pagamento inválido.' };
  }
  if (!amount || amount <= 0) return { ok: false, error: 'Valor inválido.' };

  const paymentsCol = _paymentsCol(uid);
  if (!paymentsCol) return { ok: false, error: 'Firestore não disponível.' };

  const paymentRef = paymentsCol.doc();
  const paymentId  = paymentRef.id;
  const reference  = paymentId;

  await paymentRef.set({
    id:        paymentId,
    uid,
    type,
    method:    method || null,
    amount,
    currency:  'MZN',
    status:    'pending',
    reference,
    metadata:  metadata || {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  await _paymentIndexRef(paymentId).set({ uid, paymentId, type, createdAt: Date.now() });

  const result = await paysuite.createPayment({
    method,
    amount,
    reference,
    description: description || `Pagamento Korvex — ${type}`,
    returnUrl,
    callbackUrl,
  });

  if (!result.ok) {
    await paymentRef.set({ status: 'failed', error: result.error, updatedAt: Date.now() }, { merge: true });
    return { ok: false, error: result.error };
  }

  await paymentRef.set({
    paysuitePaymentId: result.paymentId || null,
    checkoutUrl:       result.checkoutUrl || null,
    status:            result.status || 'pending',
    updatedAt:         Date.now(),
  }, { merge: true });

  return {
    ok:          true,
    paymentId,
    checkoutUrl: result.checkoutUrl,
    status:      result.status,
  };
}

/**
 * Wrapper: inicia uma assinatura
 * plan: 'pro' | 'premium' (OBRIGATÓRIO — não tem fallback)
 */
async function startSubscription({ uid, method, plan, description, returnUrl, callbackUrl }) {
  if (!plan || !['pro', 'premium'].includes(plan)) {
    return { ok: false, error: `Plano obrigatório e deve ser 'pro' ou 'premium', recebido: ${plan}` };
  }

  const planConfig = PLAN_CONFIG[plan];
  if (!planConfig) {
    return { ok: false, error: `Plano inválido: ${plan}` };
  }

  return startPayment({
    uid,
    type: 'subscription',
    method,
    amount: planConfig.priceInMT,
    metadata: { plan },
    description: description || `Assinatura Korvex ${planConfig.name} — ${planConfig.durationDays} dias`,
    returnUrl,
    callbackUrl,
  });
}

/**
 * Wrapper: inicia uma compra de tokens
 */
async function startTokenPurchase({ uid, method, packageId, returnUrl, callbackUrl }) {
  const pkg = TOKEN_PACKAGES.find(p => p.id === packageId);
  if (!pkg) return { ok: false, error: 'Pacote de tokens inválido.' };

  return startPayment({
    uid,
    type: 'token_purchase',
    method,
    amount: pkg.value,
    metadata: { packageId, tokens: pkg.tokens },
    description: `${pkg.tokens.toLocaleString('pt-PT')} tokens IA`,
    returnUrl,
    callbackUrl,
  });
}

/**
 * Activa a assinatura (PRO ou PREMIUM) com duração configurada.
 */
async function activateSubscription(uid, plan, durationDays = null) {
  if (!plan || !['pro', 'premium'].includes(plan)) {
    console.error(`[Payments] Plano obrigatório e deve ser 'pro' ou 'premium', recebido: ${plan}`);
    return false;
  }

  const ref = _subscriptionRef(uid);
  if (!ref) return false;

  const planConfig = PLAN_CONFIG[plan];
  if (!planConfig) {
    console.error(`[Payments] Plano inválido: ${plan}`);
    return false;
  }

  if (!durationDays) {
    durationDays = planConfig.durationDays;
  }

  try {
    const expiresAt = Date.now() + durationDays * 24 * 60 * 60 * 1000;
    await ref.set({
      uid,
      plan,
      expiresAt,
      updatedAt:     Date.now(),
      daysRemaining: durationDays,
    }, { merge: true });

    try {
      await creditManager.initializeCredits(uid, plan);
    } catch (e) {
      console.warn(`[Payments] Aviso ao inicializar créditos para ${uid}: ${e.message}`);
    }

    return true;
  } catch (e) {
    console.error(`[Payments] Erro em activateSubscription para ${uid}: ${e.message}`);
    return false;
  }
}

/**
 * Registra e aplica a compra de tokens.
 */
async function activateTokenPurchase(uid, packageId, tokens, value) {
  if (!_db) return false;
  try {
    const workspaceRef = _db.collection('workspaces').doc(uid);
    const purchasesRef = _db.collection('workspaces').doc(uid).collection('ai_purchases');

    await purchasesRef.add({
      date: Date.now(),
      package: packageId,
      tokens,
      value,
      method: 'paysuite',
      status: 'approved',
      createdAt: new Date().toISOString(),
    });

    const snap = await workspaceRef.get();
    const current = snap.exists ? snap.data() : {};
    const aiCredits = current.ai_credits || {};

    const newExtraLimit = (aiCredits.extra_limit || 0) + tokens;

    await workspaceRef.set({
      ai_credits: {
        ...aiCredits,
        extra_limit: newExtraLimit,
        updatedAt: Date.now(),
      }
    }, { merge: true });

    return true;
  } catch (e) {
    console.error('[Payments] Erro ao ativar compra de tokens:', e);
    return false;
  }
}

/**
 * Processa um evento de webhook já validado.
 */
async function handleWebhookEvent({ type, reference, transactionId, raw }) {
  if (!reference) {
    return { ok: false, error: 'reference em falta no webhook.' };
  }
  if (!_db) return { ok: false, error: 'Firestore não disponível.' };

  const idxSnap = await _paymentIndexRef(reference).get();
  if (!idxSnap.exists) {
    return { ok: false, error: `Pagamento não encontrado para reference: ${reference}` };
  }

  const { uid, type: paymentType } = idxSnap.data();
  const paymentId = reference;

  const paymentRef = _db.collection('workspaces').doc(uid).collection('payments').doc(paymentId);
  const snap = await paymentRef.get();
  if (!snap.exists) return { ok: false, error: `Pagamento não encontrado: ${reference}` };

  const payment = snap.data();

  if (type === 'payment.success') {
    await paymentRef.set({
      status: 'success',
      transactionId: transactionId || payment.transactionId || null,
      updatedAt: Date.now(),
      webhookRaw: raw || null,
    }, { merge: true });

    if (paymentType === 'subscription') {
      const { plan } = payment.metadata || {};
      if (!plan || !['pro', 'premium'].includes(plan)) {
        console.error(`[Payments] Webhook: plano inválido para subscrição: ${plan}`);
        return { ok: false, error: `Plano inválido no pagamento: ${plan}` };
      }

      const durationDays = PLAN_CONFIG[plan]?.durationDays || 30;
      await activateSubscription(uid, plan, durationDays);
    } else if (paymentType === 'token_purchase') {
      const { packageId, tokens } = payment.metadata || {};
      if (packageId && tokens) {
        await activateTokenPurchase(uid, packageId, tokens, payment.amount);
      }
    }

    return { ok: true, uid, paymentType, activated: true };
  }

  if (type === 'payment.failed') {
    await paymentRef.set({
      status: 'failed',
      updatedAt: Date.now(),
      webhookRaw: raw || null,
    }, { merge: true });
    return { ok: true, uid, paymentType, activated: false };
  }

  return { ok: false, error: `Tipo de evento desconhecido: ${type}` };
}

/**
 * DEV MOCK — substitui temporariamente a PaySuite durante o desenvolvimento.
 */
async function devMarkPaid({ uid, method, plan = PLANS.PREMIUM }) {
  if (!uid) return { ok: false, error: 'uid em falta.' };
  if (!plan || !['pro', 'premium'].includes(plan)) {
    return { ok: false, error: `Plano obrigatório e deve ser 'pro' ou 'premium', recebido: ${plan}` };
  }
  if (!_db) return { ok: false, error: 'Firestore não disponível.' };

  const planConfig = PLAN_CONFIG[plan];
  if (!planConfig) {
    return { ok: false, error: `Plano inválido: ${plan}` };
  }

  const paymentsCol = _paymentsCol(uid);
  const paymentRef  = paymentsCol.doc();
  const paymentId   = paymentRef.id;
  const now         = Date.now();

  await paymentRef.set({
    id:            paymentId,
    uid,
    method:        method || 'credit_card',
    amount:        planConfig.priceInMT,
    currency:      'MZN',
    status:        'success',
    reference:     paymentId,
    transactionId: `DEVMOCK${paymentId}`,
    devMock:       true,
    createdAt:     now,
    updatedAt:     now,
  });

  await _paymentIndexRef(paymentId).set({ uid, paymentId, createdAt: now });

  await activateSubscription(uid, plan, planConfig.durationDays);

  return {
    ok:        true,
    paymentId,
    plan,
    amount:    planConfig.priceInMT,
    validDays: planConfig.durationDays,
  };
}

/**
 * DEV — confirmar manualmente um pagamento REAL criado na PaySuite.
 */
async function devConfirmPayment({ uid, paymentId, plan = PLANS.PREMIUM }) {
  if (!uid) return { ok: false, error: 'uid em falta.' };
  if (!paymentId) return { ok: false, error: 'paymentId em falta.' };
  if (!plan || !['pro', 'premium'].includes(plan)) {
    return { ok: false, error: `Plano obrigatório e deve ser 'pro' ou 'premium', recebido: ${plan}` };
  }
  if (!_db) return { ok: false, error: 'Firestore não disponível.' };

  const paymentRef = _db.collection('workspaces').doc(uid).collection('payments').doc(paymentId);
  const snap = await paymentRef.get();
  if (!snap.exists) return { ok: false, error: `Pagamento não encontrado: ${paymentId}` };

  const planConfig = PLAN_CONFIG[plan];
  if (!planConfig) {
    return { ok: false, error: `Plano inválido: ${plan}` };
  }

  await paymentRef.set({
    status:     'success',
    devMock:    true,
    updatedAt:  Date.now(),
  }, { merge: true });

  await activateSubscription(uid, plan, planConfig.durationDays);

  return { ok: true, uid, paymentId, plan, activated: true };
}

module.exports = {
  setFirestore,
  startPayment,
  startSubscription,
  startTokenPurchase,
  activateSubscription,
  activateTokenPurchase,
  handleWebhookEvent,
  devMarkPaid,
  devConfirmPayment,
  TOKEN_PACKAGES,
};
