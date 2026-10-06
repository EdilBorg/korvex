/* ══════════════════════════════════════════════════════════════════════
   jobs/cleanupJob.js — Limpeza automática de sessões inactivas
   ────────────────────────────────────────────────────────────────────
   Apaga automaticamente sessões sem actividade durante 60 dias.
   Corre em background — nunca bloqueia o processamento de mensagens.

   Regras de negócio:
     - Sessões com last_activity < agora - 60 dias são apagadas
     - Apagar = documento principal + sub-colecção messages
     - Corre em lotes de 100 documentos
     - Erro numa sessão individual não para a limpeza
     - Executa uma vez ao iniciar o servidor e depois a cada 24 horas

   Integração:
     const { setFirestore, scheduleCleanup } = require('./jobs/cleanupJob');
     setFirestore(db);
     scheduleCleanup();
   ══════════════════════════════════════════════════════════════════════ */

const { resetSession } = require('../sessions');

let _db = null;

const CLEANUP_INTERVAL_MS  = 24 * 60 * 60 * 1000; // 24 horas
const INACTIVITY_DAYS      = 60;
const BATCH_SIZE           = 100;

function setFirestore(db) {
  _db = db;
}

/**
 * Executa a limpeza de sessões inactivas.
 * Lê em lotes de BATCH_SIZE documentos, apaga cada sessão via resetSession()
 * (que remove documento + sub-colecção messages), e continua mesmo que uma
 * sessão individual falhe.
 * @returns {Promise<void>}
 */
async function runCleanup() {
  if (!_db) {
    console.warn('[Cleanup] Firestore não inicializado — limpeza ignorada.');
    return;
  }

  const startedAt    = new Date().toISOString();
  const cutoffMs     = Date.now() - INACTIVITY_DAYS * 24 * 60 * 60 * 1000;
  const cutoffDate   = new Date(cutoffMs);

  console.info(`[Cleanup] Limpeza iniciada em ${startedAt} — threshold: sessões sem actividade desde ${cutoffDate.toISOString()}`);

  let totalDeleted  = 0;
  let totalErrors   = 0;
  let lastDoc       = null; // cursor para paginação

  // Firestore não suporta Timestamp em comparações directas com Date,
  // por isso usamos o valor numérico (ms) guardado em last_activity.
  // Se last_activity for um Firestore Timestamp, a comparação é feita
  // pelo campo seconds do Timestamp (ambos os casos são tratados abaixo).

  try {
    while (true) {
      // ── Construir query paginada ──────────────────────────────────
      let query = _db
        .collection('sessions')
        .where('last_activity', '<', cutoffDate) // funciona com Timestamp e Date
        .orderBy('last_activity', 'asc')
        .limit(BATCH_SIZE);

      if (lastDoc) {
        query = query.startAfter(lastDoc);
      }

      const snap = await query.get();

      if (snap.empty) break; // sem mais sessões inactivas

      console.info(`[Cleanup] Lote de ${snap.size} sessões inactivas encontradas.`);

      // ── Processar lote em paralelo (máx 10 simultâneos) ────────────
      // Promise.allSettled garante que erros individuais não param o lote.
      // Paralelismo limitado a 10 para não sobrecarregar o Firestore.
      const PARALLEL = 10;
      for (let i = 0; i < snap.docs.length; i += PARALLEL) {
        const batch = snap.docs.slice(i, i + PARALLEL);
        const results = await Promise.allSettled(
          batch.map(async (doc) => {
            const data      = doc.data();
            const accountId = data.account_id   || null;
            const phone     = data.phone_number || null;
            if (!accountId || !phone) return { skipped: true, id: doc.id };
            await resetSession(accountId, phone);
            return { deleted: true, id: doc.id };
          })
        );

        for (const r of results) {
          if (r.status === 'fulfilled') {
            if (r.value?.deleted) totalDeleted++;
          } else {
            totalErrors++;
            console.error(`[Cleanup] Erro no lote: ${r.reason?.message} — a continuar.`);
          }
        }
      }

      // Se o lote retornou menos que BATCH_SIZE, não há mais páginas
      if (snap.size < BATCH_SIZE) break;

      lastDoc = snap.docs[snap.docs.length - 1];
    }
  } catch (e) {
    console.error(`[Cleanup] Erro geral na limpeza: ${e.message}`);
  }

  const finishedAt = new Date().toISOString();
  console.info(
    `[Cleanup] Limpeza concluída em ${finishedAt} — apagadas: ${totalDeleted} | erros: ${totalErrors}`
  );
}

/**
 * Agenda a limpeza automática:
 *   1. Executa imediatamente ao iniciar (com pequeno delay para não
 *      interferir com o arranque do servidor)
 *   2. Repete a cada 24 horas via setInterval
 * @returns {void}
 */
function scheduleCleanup() {
  console.info('[Cleanup] Limpeza automática de sessões agendada (intervalo: 24h).');

  // Execução inicial com delay de 30s para não sobrecarregar o arranque
  setTimeout(() => {
    runCleanup().catch(e => {
      console.error(`[Cleanup] Erro na execução inicial: ${e.message}`);
    });
  }, 30 * 1000);

  // Execuções periódicas a cada 24 horas
  setInterval(() => {
    runCleanup().catch(e => {
      console.error(`[Cleanup] Erro na execução periódica: ${e.message}`);
    });
  }, CLEANUP_INTERVAL_MS);
}

module.exports = { setFirestore, scheduleCleanup, runCleanup };
