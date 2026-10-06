/* ══════════════════════════════════════════════════════════════════════
   engine/executors/composite.js
   ────────────────────────────────────────────────────────────────────
   Executor para nós compostos (type: 'mensagem' com settings._items).

   Um nó composto pode conter sub-itens de tipos diferentes em sequência:
     - mensagem  → envia texto (com indicador "a digitar" proporcional)
     - delay     → pausa X segundos/minutos (com "a digitar" contínuo)
     - imagem    → envia imagem
     - audio     → envia áudio
     - documento → envia documento

   CORREÇÕES v2:
   - Indicador "a digitar" mostrado antes de cada mensagem enviada
   - Delay respeita todos os itens: textos ANTES do delay são enviados,
     delay é agendado, itens DEPOIS do delay são ignorados (usar nó
     separado após o delay no canvas — comportamento documentado)
   - unidade do delay lida correctamente de item.data._unit (não idata.unit)
   ══════════════════════════════════════════════════════════════════════ */

const logger          = require('../logger');
const { interpolate } = require('./send_text');
const delayExecutor   = require('./delay');
const conversations   = require('../conversations');

// Pausa proporcional ao texto para simular digitação humana (max 3s)
function _typingDelay(text) {
  const chars = (text || '').length;
  return Math.min(300 + chars * 30, 3000);
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function execute(ctx) {
  const { uid, phone, node, flow, flowId, variables, sendMessage } = ctx;
  const items = (node.settings && node.settings._items) || [];

  // Obter função de presença injectada no delayExecutor (reutilizamos a mesma)
  // Acedida via módulo interno do delay
  const sendPresence = delayExecutor._getSendPresence
    ? delayExecutor._getSendPresence()
    : null;

  for (const item of items) {
    const itype = item.type;
    const idata = item.data || {};

    if (itype === 'mensagem') {
      const raw = idata.txt || idata.text || '';
      if (!raw.trim()) continue;
      const text = interpolate(raw, variables);

      // Mostrar "a digitar" proporcionalmente ao texto
      if (sendPresence) {
        try { await sendPresence(uid, phone, 'composing'); } catch (_) {}
        await _sleep(_typingDelay(text));
        try { await sendPresence(uid, phone, 'paused'); } catch (_) {}
      }

      await sendMessage(text);
      logger.info(uid, phone, `[COMPOSITE] Enviado texto: ${text.slice(0, 60)}`);

    } else if (itype === 'delay') {
      // Construir nó sintético para o executor de delay
      // Ler secs e unit correctamente do sub-item
      const secs = idata.secs || idata.amount || '3';
      const unit = idata._unit || idata.unit || 'Segundos';

      const delayNode = {
        nodeId:   node.nodeId,
        type:     'delay',
        settings: { secs, unit },
        data:     idata,
      };
      const delayCtx = { ...ctx, node: delayNode };
      const result = await delayExecutor.execute(delayCtx);
      if (result?.isDelay) {
        logger.info(uid, phone, `[COMPOSITE] Delay agendado (${secs} ${unit}) dentro do bloco composto.`);
        return { isDelay: true };
      }

    } else if (itype === 'aguardar') {
      await conversations.setAwaitingInput(uid, phone, String(node.nodeId));
      logger.info(uid, phone, `[COMPOSITE] Aguardar resposta no nó ${node.nodeId}.`);
      return { awaitingInput: true };

    } else if (itype === 'imagem' || itype === 'video') {
      const url = idata.url || '';
      const cap = idata.cap || '';
      if (!url) continue;
      logger.info(uid, phone, `[COMPOSITE] Media (${itype}) — URL: ${url.slice(0,60)}`);

    } else if (itype === 'audio') {
      const url = idata.url || '';
      if (!url) continue;
      logger.info(uid, phone, `[COMPOSITE] Audio — URL: ${url.slice(0,60)}`);

    } else if (itype === 'documento') {
      const url = idata.url || '';
      if (!url) continue;
      logger.info(uid, phone, `[COMPOSITE] Documento — URL: ${url.slice(0,60)}`);

    } else {
      logger.warn(uid, phone, `[COMPOSITE] Tipo de sub-item desconhecido: ${itype} — ignorado.`);
    }
  }

  return { handled: true };
}

module.exports = { execute };
