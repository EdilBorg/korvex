/* ══════════════════════════════════════════════════════════════════════
   FASE 3.2.6 — engine/executors/send_text.js (nó Mensagem)
   ────────────────────────────────────────────────────────────────────
   Envia o texto configurado no bloco para o WhatsApp do contacto.
   Campo de texto: node.settings.txt (preferido) ou node.settings.text
   — mesmos nomes usados pelo NodeTypeRegistry no Flow Builder
   (js/repository.js → mensagem.buildEditor usa o id 'txt').

   Interpola {{variavel}} com os valores já capturados em conversa (ex.:
   pelo nó Pergunta) — sem isto, uma mensagem como "Prazer, {{nome}}!"
   seria enviada literalmente com as chavetas, tornando o nó Pergunta
   inútil na prática. Variáveis sem valor capturado ficam como texto
   vazio (não mostram "undefined" nem quebram o envio).
   ══════════════════════════════════════════════════════════════════════ */

const logger = require('../logger');

/**
 * Substitui {{nome}} pelo valor em variables.nome (string vazia se ausente).
 * @param {string} text
 * @param {object} variables
 * @returns {string}
 */
function interpolate(text, variables) {
  return String(text).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const v = (variables || {})[key];
    return v == null ? '' : String(v);
  });
}

/**
 * @param {object} ctx
 * @returns {Promise<{handled: boolean}>}
 */
async function execute(ctx) {
  const settings = ctx.node.settings || {};

  // Campo directo (bloco simples)
  let rawText = settings.txt || settings.text || '';

  // FASE 5.4 — Bloco composto: texto em settings._items[].data.txt
  // O builder guarda blocos compostos (mensagem, delay, etc.) em _items.
  // O executor precisa de extrair e concatenar os textos de todos os
  // sub-itens do tipo 'mensagem'.
  if (!rawText && Array.isArray(settings._items) && settings._items.length) {
    const textos = settings._items
      .filter(it => it.type === 'mensagem' && it.data && it.data.txt)
      .map(it => it.data.txt.trim())
      .filter(Boolean);
    rawText = textos.join('\n');
  }

  logger.executed(ctx.uid, ctx.phone, ctx.node.nodeId, 'mensagem');

  if (!rawText) {
    logger.warn(ctx.uid, ctx.phone, `Nó ${ctx.node.nodeId} (mensagem) sem texto configurado — a saltar.`);
    return { handled: true };
  }

  const text = interpolate(rawText, ctx.variables);
  await ctx.sendMessage(text);
  return { handled: true };
}

module.exports = { execute, interpolate };
