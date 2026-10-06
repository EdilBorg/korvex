/* ══════════════════════════════════════════════════════════════════════
   FASE 3.2.9 — engine/logger.js
   ────────────────────────────────────────────────────────────────────
   Logs simples de debug do motor de execução de fluxos.
   Apenas console — sem persistência, sem UI. Formato pedido:

     Recebido: Olá
     Executado: node_01
     Enviado: Bem-vindo

   Cada linha é prefixada com o uid (workspace) e o telefone, para ser
   possível seguir várias conversas em simultâneo no mesmo terminal.
   ══════════════════════════════════════════════════════════════════════ */

function _prefix(uid, phone) {
  // BUGFIX defensivo: antes, um uid "truthy" mas não-string (ex.: objecto,
  // número) fazia uid.slice() rebentar com TypeError, derrubando todo o
  // processamento da mensagem (era a causa do "uid.slice is not a
  // function" no WorkerPool). Agora cai sempre no placeholder em vez de
  // crashar — o log fica menos informativo nesse caso raro, mas a
  // mensagem do cliente continua a ser processada normalmente.
  const shortUid = (typeof uid === 'string' && uid) ? uid.slice(0, 6) : '??????';
  return `[Engine ${shortUid}/${phone || '?'}]`;
}

function received(uid, phone, text) {
  console.info(`${_prefix(uid, phone)} Recebido: ${text}`);
}

function executed(uid, phone, nodeId, type) {
  console.info(`${_prefix(uid, phone)} Executado: ${nodeId}${type ? ` (${type})` : ''}`);
}

function sent(uid, phone, text) {
  console.info(`${_prefix(uid, phone)} Enviado: ${text}`);
}

function info(uid, phone, msg) {
  console.info(`${_prefix(uid, phone)} ${msg}`);
}

function warn(uid, phone, msg) {
  console.warn(`${_prefix(uid, phone)} ${msg}`);
}

function error(uid, phone, msg) {
  console.error(`${_prefix(uid, phone)} ${msg}`);
}

module.exports = { received, executed, sent, info, warn, error };
