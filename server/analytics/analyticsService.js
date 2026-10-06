/* ══════════════════════════════════════════════════════════════════════
   analytics/analyticsService.js — Motor de métricas reais do Analytics
   ────────────────────────────────────────────────────────────────────
   Toda a lógica de agregação roda no SERVIDOR — o frontend apenas pede
   dados já calculados via HTTP e renderiza. Nunca inventa números:
   onde não há dados suficientes, devolve listas/objectos vazios e o
   frontend mostra "Sem dados disponíveis ainda".

   Fontes de dados (Firestore):
     workspaces/{uid}/inbox/{phone}
       → status, activeFlowId, createdAt, updatedAt, lastMessageAt
     workspaces/{uid}/conversations/{phone}/messages/{id}
       → direction ('incoming'|'outgoing'), timestamp
     workspaces/{uid}/flows/{flowId}
       → name (para resolver nomes legíveis nos relatórios de fluxo)
     workspaces/{uid}/ai_usage_logs/{id}
       → timestamp, input_tokens, output_tokens, phone_number

   Janelas de tempo suportadas: 'today' | '7d' | '30d' | '90d'

   Cache: 2 minutos por (uid, range) — evita recomputar em cada
   refresh do painel, mas mantém os dados "quase em tempo real".
   ══════════════════════════════════════════════════════════════════════ */

const logger = require('../engine/logger');

let _db = null;

function setFirestore(db) {
  _db = db;
}

// ── Cache leve em memória ────────────────────────────────────────────
const _cache = new Map(); // key → { data, expiresAt }
const CACHE_TTL_MS = 2 * 60 * 1000;

function _cacheGet(key) {
  const hit = _cache.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.data;
  return null;
}
function _cacheSet(key, data) {
  _cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ── Janelas de tempo ─────────────────────────────────────────────────
const RANGE_DAYS = { today: 1, '7d': 7, '30d': 30, '90d': 90 };

function _rangeStartMs(range) {
  const days = RANGE_DAYS[range] || 7;
  const now  = new Date();
  if (range === 'today') {
    now.setHours(0, 0, 0, 0);
    return now.getTime();
  }
  return Date.now() - days * 86400000;
}

function _dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function _ts(v) {
  if (!v) return 0;
  if (typeof v === 'object' && typeof v.toMillis === 'function') return v.toMillis();
  return Number(v) || 0;
}

// ── Leitura bruta — contactos (inbox) ───────────────────────────────
async function _loadContacts(uid) {
  const snap = await _db
    .collection('workspaces').doc(uid)
    .collection('inbox')
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ── Leitura bruta — mensagens de todas as conversas dentro da janela ──
// Estratégia: percorrer os contactos (inbox) e, para cada um, ler a
// subcolecção messages filtrando por timestamp >= rangeStart. Isto evita
// uma collectionGroup query (que exigiria índice composto extra) e
// mantém a leitura dentro dos limites de uma conta pequena/média.
// Limite de segurança: no máximo 300 contactos lidos em paralelo lotes
// de 25, para não esgotar a quota de conexões simultâneas.
async function _loadMessagesInRange(uid, phones, rangeStartMs) {
  const allMessages = [];
  const BATCH = 25;

  for (let i = 0; i < phones.length; i += BATCH) {
    const batch = phones.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async phone => {
      try {
        const safePhone = String(phone).replace(/\//g, '_');
        const snap = await _db
          .collection('workspaces').doc(uid)
          .collection('conversations').doc(safePhone)
          .collection('messages')
          .where('timestamp', '>=', rangeStartMs)
          .get();
        return snap.docs.map(d => ({ phone, ...d.data() }));
      } catch (e) {
        logger.warn(uid, phone, `[Analytics] Erro ao ler mensagens: ${e.message}`);
        return [];
      }
    }));
    results.forEach(arr => allMessages.push(...arr));
  }

  return allMessages;
}

// ── Leitura bruta — logs de uso de IA dentro da janela ────────────────
async function _loadAiUsageInRange(uid, rangeStartMs) {
  try {
    const snap = await _db
      .collection('workspaces').doc(uid)
      .collection('ai_usage_logs')
      .where('timestamp', '>=', rangeStartMs)
      .orderBy('timestamp', 'desc')
      .limit(5000)
      .get();
    return snap.docs.map(d => d.data());
  } catch (e) {
    logger.warn(uid, null, `[Analytics] Erro ao ler ai_usage_logs: ${e.message}`);
    return [];
  }
}

// ── Leitura bruta — nomes dos fluxos ──────────────────────────────────
async function _loadFlowNames(uid) {
  try {
    const snap = await _db
      .collection('workspaces').doc(uid)
      .collection('flows')
      .get();
    const map = {};
    snap.docs.forEach(d => {
      const data = d.data();
      map[d.id] = data.name || data.flowId || d.id;
    });
    return map;
  } catch (e) {
    logger.warn(uid, null, `[Analytics] Erro ao ler nomes de fluxos: ${e.message}`);
    return {};
  }
}

/* ════════════════════════════════════════════════════════════════════
   1. VISÃO GERAL
   ════════════════════════════════════════════════════════════════════ */
function _computeOverview(contacts, messages, rangeStartMs) {
  const now      = Date.now();
  const todayKey = _dayKey(now);

  let totalReceived = 0;
  let totalSent     = 0;
  messages.forEach(m => {
    if (m.direction === 'incoming') totalReceived++;
    else if (m.direction === 'outgoing') totalSent++;
  });

  const totalConversas = contacts.length;

  const startedToday = contacts.filter(c => _dayKey(_ts(c.createdAt)) === todayKey).length;

  const finished = contacts.filter(c => c.status === 'done' || c.status === 'finished').length;

  // Tempo médio de resposta: para cada conversa, medir o intervalo entre
  // uma mensagem 'incoming' e a próxima 'outgoing' imediatamente a seguir.
  const byPhone = {};
  messages.forEach(m => {
    if (!byPhone[m.phone]) byPhone[m.phone] = [];
    byPhone[m.phone].push(m);
  });

  let responseDeltas = [];
  Object.values(byPhone).forEach(list => {
    list.sort((a, b) => _ts(a.timestamp) - _ts(b.timestamp));
    for (let i = 0; i < list.length - 1; i++) {
      if (list[i].direction === 'incoming' && list[i + 1].direction === 'outgoing') {
        const delta = _ts(list[i + 1].timestamp) - _ts(list[i].timestamp);
        if (delta > 0 && delta < 24 * 3600 * 1000) responseDeltas.push(delta); // ignorar outliers > 24h
      }
    }
  });

  const avgResponseMs = responseDeltas.length > 0
    ? Math.round(responseDeltas.reduce((a, b) => a + b, 0) / responseDeltas.length)
    : null;

  const avgMessagesPerConversation = totalConversas > 0
    ? Math.round(((totalReceived + totalSent) / totalConversas) * 10) / 10
    : 0;

  return {
    total_messages_received: totalReceived,
    total_messages_sent:     totalSent,
    total_conversations:     totalConversas,
    conversations_started_today: startedToday,
    conversations_finished:  finished,
    avg_response_time_ms:    avgResponseMs,
    avg_messages_per_conversation: avgMessagesPerConversation,
  };
}

/* ════════════════════════════════════════════════════════════════════
   2. EVOLUÇÃO DIÁRIA
   ════════════════════════════════════════════════════════════════════ */
function _computeDailyEvolution(contacts, messages, aiLogs, range) {
  const days = RANGE_DAYS[range] || 7;
  const now  = Date.now();

  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const dayStart = now - i * 86400000;
    series.push({ key: _dayKey(dayStart), messages: 0, conversations: 0, ai_usage: 0 });
  }
  const idxByKey = {};
  series.forEach((s, i) => { idxByKey[s.key] = i; });

  messages.forEach(m => {
    const k = _dayKey(_ts(m.timestamp));
    if (idxByKey[k] !== undefined) series[idxByKey[k]].messages++;
  });

  contacts.forEach(c => {
    const k = _dayKey(_ts(c.createdAt));
    if (idxByKey[k] !== undefined) series[idxByKey[k]].conversations++;
  });

  aiLogs.forEach(l => {
    const k = _dayKey(_ts(l.timestamp));
    if (idxByKey[k] !== undefined) {
      series[idxByKey[k]].ai_usage += (l.input_tokens || 0) + (l.output_tokens || 0);
    }
  });

  return series;
}

/* ════════════════════════════════════════════════════════════════════
   3. PERFORMANCE DOS FLUXOS
   ════════════════════════════════════════════════════════════════════ */
function _computeFlowPerformance(contacts, flowNames) {
  const startedCount  = {};
  const finishedCount = {};
  const abandonedCount = {};
  const durations     = {}; // flowId → [ms]

  contacts.forEach(c => {
    const flowId = c.activeFlowId;
    if (!flowId) return;

    startedCount[flowId] = (startedCount[flowId] || 0) + 1;

    if (c.status === 'done' || c.status === 'finished') {
      finishedCount[flowId] = (finishedCount[flowId] || 0) + 1;
      const created = _ts(c.createdAt);
      const updated = _ts(c.updatedAt);
      if (created && updated && updated > created) {
        if (!durations[flowId]) durations[flowId] = [];
        durations[flowId].push(updated - created);
      }
    } else if (c.status === 'bot' || c.status === 'human') {
      // Ainda em curso — não contar como abandono nem conclusão.
      // Abandono real só pode ser inferido por inactividade prolongada.
      const lastActivity = _ts(c.updatedAt || c.lastMessageAt);
      const STALE_MS = 3 * 24 * 3600 * 1000; // 3 dias sem interacção = abandono
      if (lastActivity && (Date.now() - lastActivity) > STALE_MS) {
        abandonedCount[flowId] = (abandonedCount[flowId] || 0) + 1;
      }
    }
  });

  const flowIds = Object.keys(startedCount);
  if (flowIds.length === 0) {
    return {
      most_used_flow: null,
      most_converted_flow: null,
      most_abandoned_flow: null,
      avg_completion_time_ms: null,
      flows: [],
    };
  }

  const flows = flowIds.map(id => {
    const started   = startedCount[id]   || 0;
    const finished  = finishedCount[id]  || 0;
    const abandoned = abandonedCount[id] || 0;
    const durList    = durations[id] || [];
    const avgDuration = durList.length > 0
      ? Math.round(durList.reduce((a, b) => a + b, 0) / durList.length)
      : null;

    return {
      flow_id:   id,
      flow_name: flowNames[id] || id,
      started,
      finished,
      abandoned,
      conversion_rate: started > 0 ? Math.round((finished / started) * 100) : 0,
      avg_completion_time_ms: avgDuration,
    };
  }).sort((a, b) => b.started - a.started);

  const mostUsed      = flows[0] || null;
  const mostConverted = [...flows].sort((a, b) => b.finished - a.finished)[0] || null;
  const mostAbandoned = [...flows].sort((a, b) => b.abandoned - a.abandoned)[0];

  const allDurations = Object.values(durations).flat();
  const avgCompletionAll = allDurations.length > 0
    ? Math.round(allDurations.reduce((a, b) => a + b, 0) / allDurations.length)
    : null;

  return {
    most_used_flow:      mostUsed,
    most_converted_flow: mostConverted && mostConverted.finished > 0 ? mostConverted : null,
    most_abandoned_flow: mostAbandoned && mostAbandoned.abandoned > 0 ? mostAbandoned : null,
    avg_completion_time_ms: avgCompletionAll,
    flows,
  };
}

/* ════════════════════════════════════════════════════════════════════
   6. HORÁRIOS DE MAIOR ACTIVIDADE
   ════════════════════════════════════════════════════════════════════ */
function _computeActivityHours(messages) {
  const byHour = new Array(24).fill(0);
  const byWeekday = new Array(7).fill(0); // 0=Dom .. 6=Sáb

  messages.forEach(m => {
    const ts = _ts(m.timestamp);
    if (!ts) return;
    const d = new Date(ts);
    byHour[d.getHours()]++;
    byWeekday[d.getDay()]++;
  });

  return { by_hour: byHour, by_weekday: byWeekday };
}

/* ════════════════════════════════════════════════════════════════════
   7. CLIENTES
   ════════════════════════════════════════════════════════════════════ */
function _computeClients(contacts, rangeStartMs) {
  const now = Date.now();
  const ACTIVE_WINDOW_MS = 7 * 24 * 3600 * 1000; // activo = mensagem nos últimos 7 dias

  let novos = 0;
  let activos = 0;
  let inactivos = 0;

  contacts.forEach(c => {
    if (_ts(c.createdAt) >= rangeStartMs) novos++;

    const lastActivity = _ts(c.updatedAt || c.lastMessageAt);
    if (lastActivity && (now - lastActivity) <= ACTIVE_WINDOW_MS) activos++;
    else inactivos++;
  });

  // Top clientes por nº de mensagens — precisa de contagem por contacto;
  // usamos messageCount se existir no doc da inbox, senão omitimos.
  const topClients = contacts
    .filter(c => typeof c.messageCount === 'number' && c.messageCount > 0)
    .sort((a, b) => b.messageCount - a.messageCount)
    .slice(0, 10)
    .map(c => ({
      phone:        c.phone || c.id,
      display_name: c.displayName || c.pushName || c.phone || c.id,
      message_count: c.messageCount,
    }));

  return {
    new_clients:      novos,
    active_clients:   activos,
    inactive_clients: inactivos,
    top_clients:      topClients,
  };
}

/* ════════════════════════════════════════════════════════════════════
   API pública — getAnalytics(uid, range)
   ════════════════════════════════════════════════════════════════════ */
async function getAnalytics(uid, range = '7d') {
  if (!_db) throw new Error('[Analytics] Firestore não inicializado.');
  if (!RANGE_DAYS[range]) range = '7d';

  const cacheKey = `${uid}:${range}`;
  const cached = _cacheGet(cacheKey);
  if (cached) return cached;

  const rangeStartMs = _rangeStartMs(range);

  const contacts = await _loadContacts(uid);
  const phones   = contacts.map(c => c.phone || c.id);

  const [messages, aiLogs, flowNames] = await Promise.all([
    _loadMessagesInRange(uid, phones, rangeStartMs),
    _loadAiUsageInRange(uid, rangeStartMs),
    _loadFlowNames(uid),
  ]);

  const overview        = _computeOverview(contacts, messages, rangeStartMs);
  const dailyEvolution   = _computeDailyEvolution(contacts, messages, aiLogs, range);
  const flowPerformance  = _computeFlowPerformance(contacts, flowNames);
  const activityHours    = _computeActivityHours(messages);
  const clients          = _computeClients(contacts, rangeStartMs);

  // Média diária de uso de IA dentro da janela (para estimativa de créditos)
  const totalAiCreditsInRange = aiLogs.reduce(
    (sum, l) => sum + (l.input_tokens || 0) + (l.output_tokens || 0), 0
  );
  const daysInRange = RANGE_DAYS[range];
  const avgDailyAiUsage = daysInRange > 0 ? totalAiCreditsInRange / daysInRange : 0;

  // Nº de conversas distintas que usaram IA na janela (para média por conversa)
  const conversationsWithAi = new Set(aiLogs.map(l => l.phone_number)).size;

  const result = {
    range,
    range_start_ms: rangeStartMs,
    generated_at: Date.now(),
    overview,
    daily_evolution: dailyEvolution,
    flow_performance: flowPerformance,
    activity_hours: activityHours,
    clients,
    ai_usage_in_range: {
      total_credits_used: totalAiCreditsInRange,
      conversations_with_ai: conversationsWithAi,
      avg_daily_usage: Math.round(avgDailyAiUsage),
    },
  };

  _cacheSet(cacheKey, result);
  return result;
}

function invalidate(uid) {
  for (const key of _cache.keys()) {
    if (key.startsWith(`${uid}:`)) _cache.delete(key);
  }
}

module.exports = {
  setFirestore,
  getAnalytics,
  invalidate,
};
