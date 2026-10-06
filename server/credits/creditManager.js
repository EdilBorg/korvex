/* ══════════════════════════════════════════════════════════════════════
   credits/creditManager.js — Sistema de créditos IA da plataforma Korvex
   ────────────────────────────────────────────────────────────────────
   Responsável por:
     1. Carregar a configuração global do Firestore (com cache 5 min)
     2. Verificar saldo disponível (mensal + diário) antes de chamar o modelo
     3. Consumir créditos após resposta do modelo (tokens reais da API)
     4. Controlar o rate limit por conta via Firestore (persistente entre restarts)
     5. Gerir o nível de aviso de créditos (none / warning / blocked)
     6. Devolver resumo de uso e warning_level para o painel da conta

   Estrutura Firestore (ÚNICA FONTE DE VERDADE):
     workspaces/{workspaceId}
       → ai_credits.monthly_limit      — limite mensal (da config global)
       → ai_credits.daily_limit        — limite diário (da config global)
       → ai_credits.monthly_used       — total consumido no mês actual
       → ai_credits.daily_used         — total consumido hoje
       → ai_credits.last_monthly_reset — timestamp em ms do último reset mensal
       → ai_credits.last_daily_reset   — data 'YYYY-MM-DD' do último reset diário
       → ai_credits.estimated_cost_usd — custo acumulado em USD no mês actual
       → ai_credits.warning_level      — 'none' | 'warning' | 'blocked'

     config/ai_settings
       → monthly_limit       — 100 000
       → daily_limit         — 40 000
       → requests_per_minute — 30
       → model               — gemini-2.5-flash

   Regras:
     - Nenhum limite está hardcoded — tudo vem de config/ai_settings
     - 1 token = 1 crédito (sem conversão)
     - Reset diário: automático quando a data muda (dentro de checkCredits)
     - Reset mensal: automático após 30 dias (dentro de checkCredits)
     - Rate limit: persistente em memória, janela deslizante de 60s
   ══════════════════════════════════════════════════════════════════════ */

const logger = require('../engine/logger');
const { PLANS, PLAN_CONFIG, _getPlanForAccount } = require('../plans');

let _db = null;

function setFirestore(db) {
  _db = db;
}

// ── Cache da config global (TTL: 5 minutos) ────────────────────────────
const CONFIG_CACHE_TTL_MS = 5 * 60 * 1000;
let _configCache = null;
let _configCacheExpiresAt = 0;

/**
 * Lê a configuração global de créditos IA do Firestore.
 * Usa cache de 5 minutos para evitar leituras repetidas.
 *
 * @returns {Promise<{ monthly_limit: number, daily_limit: number, requests_per_minute: number, model: string }>}
 */
async function loadGlobalConfig() {
  if (_configCache && Date.now() < _configCacheExpiresAt) {
    return _configCache;
  }

  if (!_db) {
    throw new Error('[Credits] Firestore não inicializado — chamar setFirestore() primeiro.');
  }

  try {
    const snap = await _db.collection('config').doc('ai_settings').get();

    if (!snap.exists) {
      throw new Error('[Credits] Documento config/ai_settings não encontrado no Firestore.');
    }

    const data = snap.data();

    // Validar campos obrigatórios
    if (
      typeof data.monthly_limit !== 'number' ||
      typeof data.daily_limit !== 'number' ||
      typeof data.requests_per_minute !== 'number' ||
      typeof data.model !== 'string'
    ) {
      throw new Error('[Credits] config/ai_settings tem campos em falta ou com tipo inválido.');
    }

    _configCache = {
      monthly_limit:        data.monthly_limit,
      daily_limit:          data.daily_limit,
      requests_per_minute:  data.requests_per_minute,
      model:                data.model,
    };
    _configCacheExpiresAt = Date.now() + CONFIG_CACHE_TTL_MS;

    logger.info(null, null, `[Credits] Config global carregada — mensal: ${data.monthly_limit} | diário: ${data.daily_limit} | rpm: ${data.requests_per_minute} | modelo: ${data.model}`);
    return _configCache;

  } catch (e) {
    logger.error(null, null, `[Credits] Erro ao carregar config global: ${e.message}`);
    throw e;
  }
}

// ── Utilitários de data ─────────────────────────────────────────────────

/**
 * Devolve a data de hoje no formato 'YYYY-MM-DD' (UTC).
 * @returns {string}
 */
function _todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Verifica se já passaram 30 dias desde o último reset mensal.
 * @param {number|null} lastResetTimestampMs
 * @returns {boolean}
 */
function _shouldResetMonthly(lastResetTimestampMs) {
  if (!lastResetTimestampMs) return true;
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  return (Date.now() - lastResetTimestampMs) >= thirtyDaysMs;
}

/**
 * Verifica se a data mudou desde o último reset diário.
 * @param {string|null} lastResetDateUTC  — formato 'YYYY-MM-DD'
 * @returns {boolean}
 */
function _shouldResetDaily(lastResetDateUTC) {
  if (!lastResetDateUTC) return true;
  return lastResetDateUTC !== _todayUTC();
}

// ── Funções públicas ────────────────────────────────────────────────────

/**
 * Verifica o rate limit da conta usando um Map em memória com janela deslizante.
 * 
 * Implementação:
 *   - Map em memória: workspaceId → { count, windowStart }
 *   - Janela de 60 segundos com limpeza periódica (5 min)
 *   - Tradeoff: reseta se servidor reinicia (aceitável para proteção curto-prazo)
 *   - Para múltiplas instâncias, usar Redis em vez deste Map
 *
 * O limite vem sempre de config/ai_settings (campo requests_per_minute).
 *
 * @param {string} workspaceId
 * @returns {Promise<{ allowed: boolean, reason: string }>}
 */
// ── Rate limiter em memória com janela deslizante ───────────────────
// Substitui a transacção Firestore por um Map em memória.
// Cada entrada: { count, windowStart }
// Razão: com 500 utilizadores a 30 req/min, a versão Firestore
// gerava 15.000 transacções/min só para rate limiting — caro e lento.
// Tradeoff: o contador reseta se o servidor reiniciar (aceitável —
// o rate limit é uma protecção de curto prazo, não uma auditoria).
// Para múltiplas instâncias do servidor, usar Redis em vez deste Map.
const _rateLimitWindows = new Map(); // accountId → { count, windowStart }
const WINDOW_MS = 60 * 1000;

// Limpeza periódica do Map (a cada 5 min) para evitar acumulação de
// entradas de contas inactivas. Sem isto, o Map crescia indefinidamente.
setInterval(() => {
  const now = Date.now();
  for (const [id, w] of _rateLimitWindows) {
    if (now > w.windowStart + WINDOW_MS * 2) _rateLimitWindows.delete(id);
  }
}, 5 * 60 * 1000);

async function checkRateLimit(workspaceId) {
  try {
    const config        = await loadGlobalConfig();
    const limitPerMin   = config.requests_per_minute;
    const now           = Date.now();
    const w             = _rateLimitWindows.get(workspaceId) || { count: 0, windowStart: now };

    // Janela expirou — resetar
    if (now > w.windowStart + WINDOW_MS) {
      w.count       = 0;
      w.windowStart = now;
    }

    if (w.count >= limitPerMin) {
      return { allowed: false, reason: `Rate limit: ${w.count}/${limitPerMin} req/min` };
    }

    w.count++;
    _rateLimitWindows.set(workspaceId, w);
    return { allowed: true, reason: 'OK' };

  } catch (e) {
    logger.error(workspaceId, null, `[RateLimit] Erro: ${e.message}`);
    return { allowed: true, reason: `Erro (permitido por defeito): ${e.message}` };
  }
}

/**
 * Verifica se a conta tem créditos disponíveis (mensal + diário).
 * Faz reset automático dos contadores se o período já expirou.
 * 
 * IMPORTANTE: Se o documento ai_credits não existir, inicializa-o sob demanda.
 * Isto garante que todas as contas têm créditos desde o primeiro acesso.
 *
 * @param {string} accountId
 * @returns {Promise<{ allowed: boolean, reason: string }>}
 */
async function checkCredits(workspaceId) {
  if (!_db) {
    return { allowed: false, reason: 'Firestore não inicializado' };
  }

  try {
    const config = await loadGlobalConfig();
    const workspaceRef = _db.collection('workspaces').doc(workspaceId);

    // ── PRÉ-VERIFICAÇÃO: Garantir que ai_credits existe ────────────────────
    // Se não existe, inicializar imediatamente
    const initialSnap = await workspaceRef.get();
    if (!initialSnap.exists || !initialSnap.data().ai_credits) {
      try {
        await initializeCredits(workspaceId);
        logger.info(workspaceId, null, '[Credits] Documento ai_credits inicializado sob demanda em checkCredits');
      } catch (e) {
        logger.warn(workspaceId, null, `[Credits] Aviso ao inicializar sob demanda: ${e.message}`);
      }
    }

    // Usar transacção para leitura + possível reset atómico
    const result = await _db.runTransaction(async (tx) => {
      const snap = await tx.get(workspaceRef);
      const data = snap.exists ? (snap.data().ai_credits || {}) : {};

      const now       = Date.now();
      const todayUTC  = _todayUTC();

      let monthly_used        = data.monthly_used        || 0;
      let daily_used          = data.daily_used          || 0;
      let last_monthly_reset  = data.last_monthly_reset  || null;
      let last_daily_reset    = data.last_daily_reset    || null;

      // Converter Timestamps do Firestore para ms se necessário
      if (last_monthly_reset && typeof last_monthly_reset.toMillis === 'function') {
        last_monthly_reset = last_monthly_reset.toMillis();
      }

      const updates = {};

      // ── Reset mensal (30 dias) ────────────────────────────────────
      // IMPORTANTE: Reset afeta APENAS o plano mensal, NÃO os extras
      // Extras nunca resetam — permanecem até serem consumidos
      if (_shouldResetMonthly(last_monthly_reset)) {
        monthly_used = 0;
        updates['ai_credits.monthly_used']       = 0;
        updates['ai_credits.plan_used']          = 0;  // Reset do plano
        updates['ai_credits.last_monthly_reset'] = now;
        updates['ai_credits.monthly_limit']      = config.monthly_limit;
        updates['ai_credits.plan_limit']         = config.monthly_limit;
        updates['ai_credits.estimated_cost_usd'] = 0;
        updates['ai_credits.warning_level']      = 'none';
        // NÃO resetar extra_limit nem extra_used — ficam intactos
        logger.info(workspaceId, null, `[Credits] Reset mensal efectuado — plano resetado, extras permanecem intactos`);
      }

      // ── Reset diário ──────────────────────────────────────────────
      if (_shouldResetDaily(last_daily_reset)) {
        daily_used = 0;
        updates['ai_credits.daily_used']        = 0;
        updates['ai_credits.last_daily_reset']  = todayUTC;
        updates['ai_credits.daily_limit']       = config.daily_limit;
        logger.info(accountId, null, `[Credits] Reset diário efectuado para conta ${accountId}`);
      }

      // Garantir que os limites estão sempre actualizados no documento
      // — sincroniza com config/ai_settings em TODA leitura, não apenas
      // em resets. Isto garante que uma alteração ao plano Premium
      // (ex.: aumento do limite mensal) chega a todas as contas de
      // imediato, sem esperar pelo próximo ciclo de reset.
      if (data.monthly_limit !== config.monthly_limit) {
        updates['ai_credits.monthly_limit'] = config.monthly_limit;
        updates['ai_credits.plan_limit']    = config.monthly_limit;
      }
      if (data.daily_limit !== config.daily_limit) {
        updates['ai_credits.daily_limit'] = config.daily_limit;
      }

      // Garantir que os campos plan_* existem (migração de dados)
      if (!data.plan_limit) updates['ai_credits.plan_limit'] = config.monthly_limit;
      if (!data.plan_used) updates['ai_credits.plan_used'] = 0;
      if (!data.extra_limit) updates['ai_credits.extra_limit'] = 0;
      if (!data.extra_used) updates['ai_credits.extra_used'] = 0;

      // Gravar actualizações (resets e/ou limites) se houver alguma
      if (Object.keys(updates).length > 0) {
        tx.set(workspaceRef, updates, { merge: true });
      }

      // ── Verificar saldo ───────────────────────────────────────────
      // Total disponível = plano restante + extras restante
      const plan_limit   = data.plan_limit   || config.monthly_limit;
      const plan_used    = data.plan_used    || 0;
      const extra_limit  = data.extra_limit  || 0;
      const extra_used   = data.extra_used   || 0;

      const plan_available  = Math.max(0, plan_limit - plan_used);
      const extra_available = Math.max(0, extra_limit - extra_used);
      const total_available = plan_available + extra_available;

      if (total_available <= 0) {
        return {
          allowed: false,
          reason: `Sem créditos disponíveis. Plano: ${plan_used}/${plan_limit} | Extras: ${extra_used}/${extra_limit}`,
        };
      }

      if (monthly_used >= config.monthly_limit) {
        return {
          allowed: false,
          reason: `Limite mensal de ${config.monthly_limit} créditos atingido (usado: ${monthly_used})`,
        };
      }

      if (daily_used >= config.daily_limit) {
        return {
          allowed: false,
          reason: `Limite diário de ${config.daily_limit} créditos atingido (usado: ${daily_used})`,
        };
      }

      return { allowed: true, reason: 'OK' };
    });

    return result;

  } catch (e) {
    logger.error(workspaceId, null, `[Credits] Erro em checkCredits: ${e.message}`);
    // Em caso de erro, bloquear por segurança
    return { allowed: false, reason: `Erro interno ao verificar créditos: ${e.message}` };
  }
}

/**
 * Calcula o warning_level com base na percentagem de uso mensal.
 *
 * @param {number} monthly_used
 * @param {number} monthly_limit
 * @returns {'none' | 'warning' | 'blocked'}
 */
function _computeWarningLevel(monthly_used, monthly_limit) {
  if (monthly_limit <= 0) return 'none';
  const pct = monthly_used / monthly_limit;
  if (pct >= 1.0) return 'blocked';
  if (pct >= 0.9) return 'warning';
  return 'none';
}

/**
 * Deduz os tokens consumidos do saldo seguindo a ordem obrigatória:
 *   1. Consome do plano (plan_used)
 *   2. Se o plano terminar, consome dos extras (extra_used)
 *
 * Regista também o custo estimado em USD e actualiza o warning_level.
 *
 * warning_level:
 *   'none'    — abaixo de 90% do limite mensal total
 *   'warning' — entre 90% e 99% do limite mensal total
 *   'blocked' — 100% ou mais do limite mensal total
 *
 * Preços Gemini 2.5 Flash:
 *   Input:  $0.30 por milhão de tokens
 *   Output: $2.50 por milhão de tokens
 *
 * @param {string} accountId
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @returns {Promise<{ monthly_used: number, daily_used: number, estimated_cost_usd: number, warning_level: string }>}
 */
async function consumeCredits(workspaceId, inputTokens, outputTokens) {
  if (!_db) {
    throw new Error('[Credits] Firestore não inicializado');
  }

  const totalTokens = (inputTokens || 0) + (outputTokens || 0);
  if (totalTokens <= 0) {
    logger.warn(workspaceId, null, '[Credits] consumeCredits chamado com 0 tokens — ignorado.');
    return { monthly_used: 0, daily_used: 0, estimated_cost_usd: 0, warning_level: 'none' };
  }

  // Custo estimado: input a $0.30/M, output a $2.50/M
  const estimated_cost_usd =
    ((inputTokens  || 0) / 1_000_000) * 0.30 +
    ((outputTokens || 0) / 1_000_000) * 2.50;

  try {
    const { FieldValue } = require('firebase-admin/firestore');
    const config = await loadGlobalConfig();
    const workspaceRef = _db.collection('workspaces').doc(workspaceId);

    // Usar transacção para ler + consumir atomicamente respeitando a ordem
    const result = await _db.runTransaction(async (tx) => {
      const snap = await tx.get(workspaceRef);
      const data = snap.exists ? snap.data() : {};
      const aiCredits = data.ai_credits || {};

      let plan_limit   = aiCredits.plan_limit   || config.monthly_limit;
      let plan_used    = aiCredits.plan_used    || 0;
      let extra_limit  = aiCredits.extra_limit  || 0;
      let extra_used   = aiCredits.extra_used   || 0;

      let tokensToConsume = totalTokens;
      let planConsumption = 0;
      let extraConsumption = 0;

      // Passo 1: Consumir do plano primeiro
      const planAvailable = Math.max(0, plan_limit - plan_used);
      if (planAvailable > 0) {
        planConsumption = Math.min(tokensToConsume, planAvailable);
        tokensToConsume -= planConsumption;
      }

      // Passo 2: Se ainda houver tokens para consumir, usar extras
      if (tokensToConsume > 0) {
        const extraAvailable = Math.max(0, extra_limit - extra_used);
        extraConsumption = Math.min(tokensToConsume, extraAvailable);
        tokensToConsume -= extraConsumption;
      }

      // Se ainda houver tokens depois de plano+extras, isso significa
      // que os créditos se esgotaram — registar aviso mas continuar
      if (tokensToConsume > 0) {
        logger.warn(
          workspaceId, null,
          `[Credits] Consumo de ${totalTokens} tokens excedeu créditos disponíveis. ` +
          `Plano: ${plan_used}/${plan_limit} | Extras: ${extra_used}/${extra_limit}`
        );
      }

      // Actualizar Firestore com os novos totais
      const updates = {
        ai_credits: {
          plan_used:      plan_used + planConsumption,
          extra_used:     extra_used + extraConsumption,
          monthly_used:   (aiCredits.monthly_used || 0) + planConsumption + extraConsumption,
          daily_used:     (aiCredits.daily_used || 0) + planConsumption + extraConsumption,
          estimated_cost_usd: FieldValue.increment(estimated_cost_usd),
        }
      };

      tx.set(workspaceRef, updates, { merge: true });

      return {
        plan_used: plan_used + planConsumption,
        extra_used: extra_used + extraConsumption,
        monthly_used: (aiCredits.monthly_used || 0) + planConsumption + extraConsumption,
        daily_used: (aiCredits.daily_used || 0) + planConsumption + extraConsumption,
      };
    });

    logger.info(
      workspaceId, null,
      `[Credits] Consumidos ${totalTokens} créditos (in: ${inputTokens}, out: ${outputTokens}) | ` +
      `Plano: ${result.plan_used} | Extras: ${result.extra_used} | custo: $${estimated_cost_usd.toFixed(6)}`
    );

    // Ler totais actualizados para calcular warning_level
    const snap = await workspaceRef.get();
    const credits = snap.exists ? (snap.data().ai_credits || {}) : {};

    const monthly_used  = credits.monthly_used  || 0;
    const monthly_limit = credits.monthly_limit || config.monthly_limit;

    // ── Calcular e persistir warning_level ───────────────────────────
    const warning_level = _computeWarningLevel(monthly_used, monthly_limit);

    // Actualizar apenas se o nível mudou (evitar escrita desnecessária)
    const current_warning = credits.warning_level || 'none';
    if (warning_level !== current_warning) {
      await workspaceRef.set({
        ai_credits: { warning_level }
      }, { merge: true });

      logger.info(
        workspaceId, null,
        `[Credits] warning_level actualizado: "${current_warning}" → "${warning_level}" (${monthly_used}/${monthly_limit} créditos)`
      );
    }

    return {
      monthly_used,
      daily_used: credits.daily_used || 0,
      estimated_cost_usd,
      warning_level,
    };

  } catch (e) {
    logger.error(workspaceId, null, `[Credits] Erro em consumeCredits: ${e.message}`);
    throw e;
  }
}

/**
 * Devolve o warning_level actual da conta.
 * Usado pelo painel frontend para mostrar avisos ao utilizador.
 *
 * @param {string} accountId
 * @returns {Promise<'none' | 'warning' | 'blocked'>}
 */
async function getWarningLevel(workspaceId) {
  if (!_db) {
    throw new Error('[Credits] Firestore não inicializado');
  }

  try {
    const snap = await _db.collection('workspaces').doc(workspaceId).get();
    const credits = snap.exists ? (snap.data().ai_credits || {}) : {};
    return credits.warning_level || 'none';
  } catch (e) {
    logger.error(workspaceId, null, `[Credits] Erro em getWarningLevel: ${e.message}`);
    throw e;
  }
}

/**
 * Devolve o estado actual dos créditos da workspace para mostrar no painel.
 * 
 * ✅ CONTRATO ÚNICO: Esta é a ÚNICA fonte de verdade para dados de créditos.
 * Ambos os endpoints (credits/status e analytics/credits) usam esta função.
 * Nenhuma divergência é possível — retorna sempre os mesmos dados estruturados.
 * 
 * Retorna:
 *   monthly_limit:      limite mensal (da config global ou plano)
 *   monthly_used:       total consumido do plano (plan_used + parte do daily)
 *   monthly_remaining:  monthly_limit - monthly_used
 *   monthly_percent:    percentagem do mês consumido
 *   
 *   daily_limit:        limite diário (da config global)
 *   daily_used:         consumido hoje
 *   daily_remaining:    daily_limit - daily_used
 *   daily_percent:      percentagem do dia consumido
 *   
 *   plan_limit:         limite do plano (mensal, da assinatura)
 *   plan_used:          créditos do plano consumidos
 *   plan_remaining:     plan_limit - plan_used
 *   
 *   extra_limit:        créditos extras comprados (máximo disponível)
 *   extra_used:         créditos extras consumidos
 *   extra_remaining:    extra_limit - extra_used
 *   
 *   estimated_cost_usd: custo acumulado em USD
 *   warning_level:      'none' | 'warning' | 'blocked'
 *   last_monthly_reset: timestamp do último reset mensal (ou null)
 *   last_daily_reset:   data do último reset diário em 'YYYY-MM-DD' (ou null)
 *
 * @param {string} workspaceId
 * @returns {Promise<Object>} — Dados estruturados e completos
 */
async function getUsageSummary(workspaceId) {
  if (!_db) {
    throw new Error('[Credits] Firestore não inicializado');
  }

  try {
    const config = await loadGlobalConfig();
    const snap = await _db.collection('workspaces').doc(workspaceId).get();
    
    // ── Se ai_credits não existe, inicializar sob demanda ──────────────────
    let credits = snap.exists ? (snap.data().ai_credits || {}) : {};
    if (!snap.exists || !snap.data().ai_credits) {
      try {
        await initializeCredits(workspaceId);
        // Re-ler após inicialização
        const rereadSnap = await _db.collection('workspaces').doc(workspaceId).get();
        credits = rereadSnap.exists ? (rereadSnap.data().ai_credits || {}) : {};
        logger.info(workspaceId, null, '[Credits] ai_credits inicializado sob demanda em getUsageSummary');
      } catch (e) {
        logger.warn(workspaceId, null, `[Credits] Aviso ao inicializar em getUsageSummary: ${e.message}`);
        // Continuar com defaults se a inicialização falhar
      }
    }

    const monthly_limit     = credits.monthly_limit     || config.monthly_limit;
    const daily_limit       = credits.daily_limit       || config.daily_limit;
    const monthly_used      = credits.monthly_used      || 0;
    const daily_used        = credits.daily_used        || 0;
    const estimated_cost    = credits.estimated_cost_usd || 0;
    const warning_level     = credits.warning_level     || 'none';

    // Plan vs Extras
    const plan_limit        = credits.plan_limit        || monthly_limit;
    const plan_used         = credits.plan_used         || 0;
    const extra_limit       = credits.extra_limit       || 0;
    const extra_used        = credits.extra_used        || 0;

    let last_monthly_reset = credits.last_monthly_reset || null;
    if (last_monthly_reset && typeof last_monthly_reset.toMillis === 'function') {
      last_monthly_reset = last_monthly_reset.toMillis();
    }

    return {
      monthly_limit,
      monthly_used,
      monthly_remaining: Math.max(0, monthly_limit - monthly_used),
      monthly_percent:   monthly_limit > 0
        ? Math.min(100, Math.round((monthly_used / monthly_limit) * 100))
        : 0,

      daily_limit,
      daily_used,
      daily_remaining: Math.max(0, daily_limit - daily_used),
      daily_percent:   daily_limit > 0
        ? Math.min(100, Math.round((daily_used / daily_limit) * 100))
        : 0,

      plan_limit,
      plan_used,
      plan_remaining: Math.max(0, plan_limit - plan_used),
      
      extra_limit,
      extra_used,
      extra_remaining: Math.max(0, extra_limit - extra_used),

      estimated_cost_usd:  estimated_cost,
      warning_level,
      last_monthly_reset,
      last_daily_reset:    credits.last_daily_reset || null,
    };

  } catch (e) {
    logger.error(workspaceId, null, `[Credits] Erro em getUsageSummary: ${e.message}`);
    throw e;
  }
}

/**
 * Calcula estimativas de consumo para o Analytics:
 *   • média de créditos gastos por conversa (com IA activa)
 *   • média diária de consumo (baseada nos últimos N dias de uso real)
 *   • estimativa de quantos dias restam ao ritmo actual
 *
 * @param {string} workspaceId
 * @param {number} conversationsWithAi  — nº de conversas que usaram IA (vindo do Analytics)
 * @param {number} avgDailyUsage        — média diária real calculada a partir dos ai_usage_logs
 * @returns {Promise<{ avg_credits_per_conversation: number, avg_daily_usage: number, estimated_days_remaining: number|null }>}
 */
async function getCreditsEstimate(workspaceId, conversationsWithAi, avgDailyUsage) {
  const summary = await getUsageSummary(workspaceId);

  const avg_credits_per_conversation = conversationsWithAi > 0
    ? Math.round(summary.monthly_used / conversationsWithAi)
    : 0;

  const avg_daily_usage = Math.round(avgDailyUsage || 0);

  const estimated_days_remaining = avg_daily_usage > 0
    ? Math.floor(summary.monthly_remaining / avg_daily_usage)
    : null; // sem consumo recente — não é possível estimar

  return {
    avg_credits_per_conversation,
    avg_daily_usage,
    estimated_days_remaining,
  };
}

/**
 * Inicializa o documento de créditos para uma workspace.
 * Deve ser chamado quando:
 *   1. Uma workspace é criada
 *   2. Uma assinatura é ativada
 *
 * Garante que o documento workspaces/{uid}/ai_credits existe com todos
 * os campos necessários.
 *
 * @param {string} workspaceId
 * @returns {Promise<void>}
 */
/**
 * Inicializa o documento de créditos para uma workspace.
 * Garante que todos os campos obrigatórios existem com valores iniciais corretos.
 * Sempre usa o padrão definido em config/ai_settings como fonte de verdade.
 * 
 * @param {string} workspaceId
 * @param {Object} options - { forceReinit: boolean } - se true, reinicializa mesmo se já existe
 * @returns {Promise<void>}
 */
async function initializeCredits(workspaceId, plan = null, options = {}) {
  if (!_db) {
    throw new Error('[Credits] Firestore não inicializado');
  }

  // Se plan for um objeto (retrocompatibilidade com options), ajustar parâmetros
  if (typeof plan === 'object') {
    options = plan;
    plan = null;
  }

  try {
    // Se o plano não foi fornecido, obter do Firestore
    if (!plan) {
      try {
        plan = await _getPlanForAccount(workspaceId);
        logger.info(workspaceId, null, `[Credits] Plano obtido do Firestore: ${plan}`);
      } catch (e) {
        logger.warn(workspaceId, null, `[Credits] Erro ao obter plano, usando TRIAL como fallback: ${e.message}`);
        plan = PLANS.TRIAL;
      }
    }

    const config = await loadGlobalConfig();
    const planConfig = PLAN_CONFIG[plan];
    
    if (!planConfig) {
      logger.warn(workspaceId, null, `[Credits] Plano inválido: ${plan}, usando TRIAL`);
      plan = PLANS.TRIAL;
    }

    const now = Date.now();
    const todayUTC = _todayUTC();
    const workspaceRef = _db.collection('workspaces').doc(workspaceId);

    // Verificar se já foi inicializado (a menos que forceReinit seja true)
    if (!options.forceReinit) {
      const snap = await workspaceRef.get();
      if (snap.exists && snap.data().ai_credits) {
        const existing = snap.data().ai_credits;
        // Se existem valores válidos, apenas garantir que campos obrigatórios existem
        if (typeof existing.monthly_limit === 'number' && existing.monthly_limit > 0) {
          logger.info(workspaceId, null, '[Credits] Documento já inicializado, pulando reinicialização');
          return;
        }
      }
    }

    // Determinar limite mensal baseado no plano
    const monthlyLimitByPlan = PLAN_CONFIG[plan]?.monthlyAITokens || config.monthly_limit;

    // Estrutura completa e obrigatória
    const creditsData = {
      // Limites (do plano ou config global como fallback)
      monthly_limit:      monthlyLimitByPlan,
      daily_limit:        config.daily_limit,
      
      // Consumidos (sempre começam em 0)
      monthly_used:       0,
      daily_used:         0,
      
      // Plano (mensal, da assinatura)
      plan_limit:         monthlyLimitByPlan,
      plan_used:          0,
      
      // Extras (comprados, nunca resetam)
      extra_limit:        0,
      extra_used:         0,
      
      // Timestamps de reset
      last_monthly_reset: now,
      last_daily_reset:   todayUTC,
      
      // Custo estimado e avisos
      estimated_cost_usd: 0,
      warning_level:      'none',
    };

    // Usar merge para não sobrescrever outros campos da workspace
    await workspaceRef.set({
      ai_credits: creditsData
    }, { merge: true });

    logger.info(
      workspaceId, null,
      `[Credits] Documento inicializado — plano: ${plan} | mensal: ${monthlyLimitByPlan} | diário: ${config.daily_limit} | extras: 0`
    );

  } catch (e) {
    logger.error(workspaceId, null, `[Credits] Erro em initializeCredits: ${e.message}`);
    throw e;
  }
}

module.exports = {
  setFirestore,
  loadGlobalConfig,
  checkRateLimit,
  checkCredits,
  consumeCredits,
  getWarningLevel,
  getUsageSummary,
  getCreditsEstimate,
  initializeCredits,
};
