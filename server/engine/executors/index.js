/* ══════════════════════════════════════════════════════════════════════
   FASE 3.2.4 — engine/executors/index.js
   ────────────────────────────────────────────────────────────────────
   Registo de executores por 'executorHint' (o mesmo metadado já definido
   em js/repository.js → NodeTypeRegistry, para cada tipo de nó).

   Cada executor tem a assinatura:
     async function execute(ctx) → { handled: boolean, awaitingInput?: boolean }

   onde ctx = {
     uid, phone, node, flow, variables, incomingText,
     sendMessage(text)  — atalho já ligado a este uid/phone
   }

   Tipos cobertos nesta fase (FASE 3.2.4/3.2.5/3.2.6/3.2.7):
     trigger        (Início)    — totalmente funcional
     send_text      (Mensagem)  — totalmente funcional
     ask_question   (Pergunta)  — totalmente funcional

   Os restantes (send_buttons, send_list, condition, end_flow, ...) têm
   um stub seguro (_stub.js) que não quebra o fluxo: regista o log e
   tenta avançar para o próximo nó sem ação especial. Isto mantém a
   arquitetura "preparada para todos" pedida, sem fingir suportar
   comportamento que ainda não foi implementado/testado a fundo.
   ══════════════════════════════════════════════════════════════════════ */

const trigger      = require('./trigger');
const sendText     = require('./send_text');
const askQuestion  = require('./ask_question');
const endFlow      = require('./end_flow');
const waitReply    = require('./wait_reply');   // FASE 5 — AGUARDAR
const delay        = require('./delay');        // FASE 5 — DELAY
const composite    = require('./composite');    // FASE 5 — BLOCO COMPOSTO
const saveVar      = require('./save_var');     // FASE 5 — SALVAR RESPOSTA
const stub         = require('./_stub');

const _registry = {
  trigger:      trigger,
  send_text:    sendText,
  ask_question: askQuestion,
  end_flow:     endFlow,
  wait_reply:   waitReply,   // FASE 5 — implementado
  delay:        delay,       // FASE 5 — implementado
  composite:    composite,   // FASE 5 — bloco composto
  save_var:     saveVar,     // FASE 5 — salvar resposta

  // ── Preparados para fases seguintes (stub seguro) ──────────────────
  send_buttons:   stub,
  send_list:      stub,
  condition:      stub,
  send_image:     stub,
  send_video:     stub,
  send_audio:     stub,
  send_document:  stub,
  http_request:   stub,
  api_call:       stub,
  crm_tag_add:    stub,
  crm_tag_remove: stub,
};

/**
 * Devolve o executor para um executorHint, ou o stub genérico se
 * desconhecido (nunca null — o motor pode sempre chamar algo).
 * @param {string} executorHint
 * @returns {{execute: Function}}
 */
function get(executorHint) {
  return _registry[executorHint] || stub;
}

module.exports = { get };
