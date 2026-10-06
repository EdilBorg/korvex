/* ══════════════════════════════════════════════════════════════════════
   engine/aiHistory.js — Histórico de conversa para o Gemini
   ────────────────────────────────────────────────────────────────────
   Lê as últimas N mensagens da colecção:
     workspaces/{uid}/conversations/{phone}/messages

   e devolve-as no formato { role, text } que o ai.js converte
   para o formato do Gemini.

   Não lança excepções — devolve array vazio em caso de erro.
   ══════════════════════════════════════════════════════════════════════ */

const logger = require('./logger');

let _db = null;

function setFirestore(db) {
  _db = db;
}

const MAX_HISTORY_MESSAGES = 12; // últimas 12 mensagens (6 trocas aprox.)

/**
 * Devolve o histórico recente da conversa formatado para o ai.js.
 * @param {string} uid
 * @param {string} phone
 * @returns {Promise<Array<{role: string, text: string}>>}
 */
async function getRecentHistory(uid, phone) {
  if (!_db) return [];

  const safePhone = String(phone).replace(/\//g, '_');

  try {
    const snap = await _db
      .collection('workspaces').doc(uid)
      .collection('conversations').doc(safePhone)
      .collection('messages')
      .orderBy('timestamp', 'desc')
      .limit(MAX_HISTORY_MESSAGES)
      .get();

    if (snap.empty) return [];

    // Reverter para ordem cronológica (mais antiga primeiro)
    const msgs = [];
    snap.forEach(doc => msgs.unshift(doc.data()));

    return msgs
      .filter(m => m.type === 'text' && m.text)
      .map(m => ({
        role: m.direction, // 'incoming' | 'outgoing'
        text: m.text,
      }));

  } catch (e) {
    logger.error(uid, phone, `[AIHistory] Erro ao ler histórico: ${e.message}`);
    return [];
  }
}

module.exports = { setFirestore, getRecentHistory };
