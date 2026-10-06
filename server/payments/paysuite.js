/* ══════════════════════════════════════════════════════════════════════
   server/payments/paysuite.js — Cliente da API PaySuite
   ────────────────────────────────────────────────────────────────────
   Responsável exclusivamente por falar com a API da PaySuite. Não sabe
   nada sobre Firestore, subscrições ou o resto do Korvex — isso fica em
   server/payments/index.js e nas rotas em server/index.js.

   Confirmado com a documentação oficial da PaySuite:
     Endpoint:  POST {PAYSUITE_BASE_URL}/api/v1/payments
     Body:      { amount, method?, reference, description?, return_url?, callback_url? }
     Resposta 201: { status: 'success', data: { id, amount, reference,
                     status: 'pending', checkout_url } }
     Erros:     { status: 'error', message: '...' }

   A PaySuite devolve um `checkout_url` — o pagamento é concluído numa
   página de checkout HOSPEDADA PELA PRÓPRIA PAYSUITE (o utilizador é
   redireccionado para lá; não enviamos número de telemóvel/dados de
   cartão directamente por esta API). Por isso `createPayment` já não
   aceita `msisdn`/`card` — isso é recolhido pela PaySuite no checkout.

   Confirmação do pagamento: normalmente chega por webhook
   (payment.success/payment.failed, ver verifyWebhookSignature). Em DEV,
   sem URL pública para receber esse webhook, a confirmação é substituída
   pelo endpoint /dev/mark-paid (ver server/payments/index.js).

   Variáveis de ambiente (nunca colocar o token directamente no código):
     PAYSUITE_BASE_URL       → https://paysuite.tech
     PAYSUITE_API_TOKEN      → token secreto da conta PaySuite
     PAYSUITE_WEBHOOK_SECRET → segredo usado para validar X-Webhook-Signature
   ══════════════════════════════════════════════════════════════════════ */

const crypto = require('crypto');

const BASE_URL       = process.env.PAYSUITE_BASE_URL || '';
const API_TOKEN      = process.env.PAYSUITE_API_TOKEN || '';
const WEBHOOK_SECRET = process.env.PAYSUITE_WEBHOOK_SECRET || '';

function isConfigured() {
  return !!(BASE_URL && API_TOKEN);
}

/**
 * Cria um pedido de pagamento na PaySuite e devolve o checkout_url para
 * onde o frontend deve redireccionar o cliente.
 * @param {Object} params
 * @param {'mpesa'|'emola'|'credit_card'} [params.method] — opcional; se
 *        omitido, o cliente escolhe o método na própria página de checkout.
 * @param {number} params.amount        — valor em MZN (ex: 500)
 * @param {string} params.reference     — referência única (max 50 chars).
 *        Usamos "{uid}__{paymentId}" para o webhook localizar o registo.
 * @param {string} [params.description] — descrição (max 125 chars)
 * @param {string} [params.returnUrl]   — para onde a PaySuite reenvia o
 *        cliente depois de pagar (frontend)
 * @param {string} [params.callbackUrl] — URL do webhook (produção). Deixar
 *        vazio em DEV — a PaySuite não consegue alcançar localhost.
 * @returns {Promise<{ok:boolean, paymentId?:string, status?:string, checkoutUrl?:string, error?:string}>}
 */
async function createPayment({ method, amount, reference, description, returnUrl, callbackUrl }) {
  if (!isConfigured()) {
    return { ok: false, error: 'PaySuite não configurado (PAYSUITE_BASE_URL / PAYSUITE_API_TOKEN em falta no .env).' };
  }

  const endpoint = `${BASE_URL.replace(/\/$/, '')}/api/v1/payments`;

  const body = {
    amount,
    reference,
    ...(method      ? { method }               : {}),
    ...(description ? { description }          : {}),
    ...(returnUrl   ? { return_url: returnUrl }     : {}),
    ...(callbackUrl ? { callback_url: callbackUrl } : {}),
  };

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Accept':        'application/json',
        'Authorization': `Bearer ${API_TOKEN}`,
      },
      body: JSON.stringify(body),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok || data.status === 'error') {
      return { ok: false, error: data?.message || `PaySuite respondeu ${res.status}` };
    }

    const payload = data.data || {};
    return {
      ok:          true,
      paymentId:   payload.id || null,
      status:      payload.status || 'pending',
      checkoutUrl: payload.checkout_url || null,
      raw:         data,
    };
  } catch (e) {
    return { ok: false, error: `Falha ao contactar a PaySuite: ${e.message}` };
  }
}

/**
 * Consulta o estado actual de um pagamento directamente na PaySuite
 * (GET /api/v1/payments/{id}). Útil em DEV como alternativa a polling,
 * já que não há webhook a chegar a localhost.
 */
async function getPayment(paysuitePaymentId) {
  if (!isConfigured()) {
    return { ok: false, error: 'PaySuite não configurado.' };
  }
  const endpoint = `${BASE_URL.replace(/\/$/, '')}/api/v1/payments/${paysuitePaymentId}`;
  try {
    const res = await fetch(endpoint, {
      headers: {
        'Accept':        'application/json',
        'Authorization': `Bearer ${API_TOKEN}`,
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.status === 'error') {
      return { ok: false, error: data?.message || `PaySuite respondeu ${res.status}` };
    }
    return { ok: true, data: data.data };
  } catch (e) {
    return { ok: false, error: `Falha ao contactar a PaySuite: ${e.message}` };
  }
}

/**
 * Valida a assinatura do webhook enviada pela PaySuite no cabeçalho
 * X-Webhook-Signature, usando HMAC-SHA256 sobre o corpo em bruto (raw)
 * do pedido, comparado com PAYSUITE_WEBHOOK_SECRET.
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!WEBHOOK_SECRET) return false;
  if (!signatureHeader) return false;
  try {
    const expected = crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signatureHeader));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

module.exports = {
  isConfigured,
  createPayment,
  getPayment,
  verifyWebhookSignature,
};
