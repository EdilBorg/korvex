/* ══════════════════════════════════════════════════════════════════════
   engine/ai.js — Integração Gemini 2.5 Flash-Lite (Fallback IA)
   ────────────────────────────────────────────────────────────────────
   Usa o SDK oficial @google/generative-ai com o modelo gemini-2.5-flash-lite.

   Caminho Firestore do system prompt:
     workspaces/{uid}/settings/ai → { systemPrompt, enabled, updatedAt }

   Variável de ambiente necessária:
     GEMINI_API_KEY=AIzaSy...
   ══════════════════════════════════════════════════════════════════════ */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger = require('./logger');

let _db    = null;
let _genAI = null;

function setFirestore(db) {
  _db = db;
}

function _getGenAI() {
  if (_genAI) return _genAI;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  _genAI = new GoogleGenerativeAI(apiKey);
  return _genAI;
}

// Cache do system prompt por uid (TTL 60s)
const _promptCache = new Map();
const PROMPT_CACHE_TTL = 60 * 1000;

async function _getSystemPrompt(uid) {
  const cached = _promptCache.get(uid);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  if (!_db) return null;

  try {
    const snap = await _db
      .collection('workspaces').doc(uid)
      .collection('settings').doc('ai')
      .get();

    if (!snap.exists) {
      _promptCache.set(uid, { value: null, expiresAt: Date.now() + PROMPT_CACHE_TTL });
      return null;
    }

    const data = snap.data();

    if (data.enabled === false) {
      _promptCache.set(uid, { value: null, expiresAt: Date.now() + PROMPT_CACHE_TTL });
      return null;
    }

    const prompt = (data.systemPrompt || '').trim() || null;
    _promptCache.set(uid, { value: prompt, expiresAt: Date.now() + PROMPT_CACHE_TTL });
    return prompt;

  } catch (e) {
    logger.error(uid, null, `[AI] Erro ao ler systemPrompt: ${e.message}`);
    return null;
  }
}

function invalidatePromptCache(uid) {
  _promptCache.delete(uid);
}

// ── Retry com backoff para erros transitórios da API Gemini ──────────────
// Antes desta correcção, qualquer 503 "model overloaded" (frequente em
// picos de demanda) fazia o motor desistir de imediato e ignorar a
// mensagem do cliente em silêncio (ver workflowEngine.js — "Fallback sem
// resposta"). A maioria destes erros é transitória e resolve-se sozinha
// em poucos segundos, por isso vale a pena tentar de novo antes de
// desistir. Só repete em erros claramente transitórios (503/429/"overloaded"/
// "service unavailable") — qualquer outro erro (chave inválida, pedido
// malformado, etc.) continua a falhar imediatamente, sem mudança de
// comportamento.
const AI_RETRY_ATTEMPTS   = 2;          // tentativas extra, além da 1ª
const AI_RETRY_BASE_MS    = 800;        // 800ms, depois 1600ms
const _TRANSIENT_ERROR_RE = /503|overloaded|service unavailable|429|too many requests/i;

async function _sendMessageWithRetry(chat, incomingText, uid, phone) {
  let lastErr;
  for (let attempt = 0; attempt <= AI_RETRY_ATTEMPTS; attempt++) {
    try {
      return await chat.sendMessage(incomingText);
    } catch (e) {
      lastErr = e;
      const isTransient = _TRANSIENT_ERROR_RE.test(e?.message || '');
      if (!isTransient || attempt === AI_RETRY_ATTEMPTS) throw e;

      const delay = AI_RETRY_BASE_MS * Math.pow(2, attempt);
      logger.info(
        uid, phone,
        `[AI] Gemini indisponível (tentativa ${attempt + 1}/${AI_RETRY_ATTEMPTS + 1}) — nova tentativa em ${delay}ms.`
      );
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastErr; // inalcançável na prática, mantido por clareza
}

/**
 * Gera uma resposta de IA para uma mensagem do cliente.
 *
 * BUGFIX: esta função era uma cópia quase idêntica de
 * generateReplyWithUsage (mesma construção de prompt, mesmo
 * histórico) mas SEM o retry de erros transitórios 503/429. Hoje
 * nada chama generateReply directamente (só generateReplyWithUsage,
 * usada por workflowEngine.js), mas mantê-la como código morto
 * duplicado era um risco real: se alguém voltasse a usá-la no
 * futuro, perdia o retry sem perceber porquê. Agora é apenas um
 * wrapper fino — uma única implementação real, sem forma de divergir.
 *
 * @param {string} uid
 * @param {string} phone
 * @param {string} incomingText
 * @param {Array}  history  [ {role: 'incoming'|'outgoing', text: string} ]
 * @returns {Promise<string|null>}
 */
async function generateReply(uid, phone, incomingText, history = []) {
  const result = await generateReplyWithUsage(uid, phone, incomingText, history);
  return result ? result.reply : null;
}

module.exports = { setFirestore, generateReply, invalidatePromptCache };

/**
 * Variante de generateReply que devolve também os tokens reais da API.
 * Utilizado pelo sistema de créditos para contabilização exacta.
 *
 * @param {string} uid
 * @param {string} phone
 * @param {string} incomingText
 * @param {Array}  history
 * @returns {Promise<{ reply: string|null, inputTokens: number, outputTokens: number, model: string } | null>}
 */
async function generateReplyWithUsage(uid, phone, incomingText, history = []) {
  const genAI = _getGenAI();
  if (!genAI) {
    logger.warn(uid, phone, '[AI] GEMINI_API_KEY não definida — fallback IA desactivado.');
    return null;
  }

  const systemPrompt = await _getSystemPrompt(uid);
  if (!systemPrompt) {
    logger.info(uid, phone, '[AI] Sem system prompt configurado — fallback IA ignorado.');
    return null;
  }

  const fullSystemPrompt = `${systemPrompt}

INSTRUÇÕES DE COMPORTAMENTO (segue sempre estas regras):
- Responde SEMPRE em português, de forma natural e amigável.
- NUNCA digas que algo é impossível ou que não sabes.
- Se não tiveres a informação, diz que vais verificar e pede ao cliente para aguardar um momento.
- NUNCA menciones concorrentes.
- Mantém respostas curtas e directas — no máximo 3 frases, adequadas para WhatsApp.
- NUNCA digas que és uma IA ou um bot. Comporta-te como um assistente humano do negócio.
- Se o cliente pedir algo fora do âmbito do negócio, redireciona gentilmente para o que o negócio oferece.`;

  try {
    const modelName = 'gemini-2.5-flash-lite';
    const model = genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: fullSystemPrompt,
      generationConfig: {
        temperature:     0.4,
        maxOutputTokens: 1024,
        topP:            0.9,
      },
    });

    const rawHistory = history
      .filter(m => m.text && m.text.trim())
      .map(m => ({
        role:  (m.role === 'outgoing' || m.role === 'model') ? 'model' : 'user',
        parts: [{ text: m.text }],
      }));

    while (rawHistory.length > 0 && rawHistory[0].role !== 'user') {
      rawHistory.shift();
    }

    const alternated = [];
    for (const msg of rawHistory) {
      if (alternated.length === 0 || alternated[alternated.length - 1].role !== msg.role) {
        alternated.push(msg);
      } else {
        alternated[alternated.length - 1] = msg;
      }
    }

    while (alternated.length > 0 && alternated[alternated.length - 1].role === 'user') {
      alternated.pop();
    }

    const chat   = model.startChat({ history: alternated });
    const result = await _sendMessageWithRetry(chat, incomingText, uid, phone);
    const reply  = result.response.text().trim();
    const usageMetadata = result.response.usageMetadata || {};
    const inputTokens   = usageMetadata.promptTokenCount     || 0;
    const outputTokens  = usageMetadata.candidatesTokenCount || 0;

    logger.info(
      uid, phone,
      `[AI] Resposta gerada com usage (${reply.length} chars) | tokens: in=${inputTokens} out=${outputTokens}`
    );

    return {
      reply:        reply || null,
      inputTokens,
      outputTokens,
      model:        modelName,
    };

  } catch (e) {
    logger.error(uid, phone, `[AI] Erro ao chamar Gemini (com usage): ${e.message}`);
    return null;
  }
}

// Re-exportar com a nova função incluída
module.exports.generateReplyWithUsage = generateReplyWithUsage;
