/* ══════════════════════════════════════════════════════════════════════
   whatsapp/memoryGuard.js — Monitor de uso de memória RAM
   ────────────────────────────────────────────────────────────────────
   Cada socket Baileys activo consome entre 50–150 MB de RAM.
   Com 500 utilizadores × 2 slots = até 1000 sockets simultâneos.

   Este módulo:
   1. Monitoriza o uso de RAM a cada 30 segundos
   2. Emite aviso no log quando RAM > 70% do total disponível
   3. Emite alerta crítico quando RAM > 85%
   4. Expõe /health/memory para monitorização externa (Uptime Robot, etc.)

   NÃO fecha sessões automaticamente — isso interromperia atendimentos
   activos. Apenas avisa para que o operador possa escalar a máquina.

   SOLUÇÃO DE LONGO PRAZO para +500 utilizadores:
   - Separar sessões Baileys em workers Node.js independentes
     (ex: 1 worker por cada 50–100 sessões)
   - Ou usar um cluster de máquinas com sticky sessions via Redis
   ══════════════════════════════════════════════════════════════════════ */

const WARN_PCT    = 70;  // % de RAM usada que dispara aviso
const CRIT_PCT    = 85;  // % de RAM usada que dispara alerta crítico
const INTERVAL_MS = 30 * 1000; // verificar a cada 30 segundos

let _timer       = null;
let _lastStatus  = { ok: true, usedMb: 0, totalMb: 0, pct: 0, checkedAt: null };

function _check() {
  const mem     = process.memoryUsage();
  const usedMb  = Math.round(mem.rss / 1024 / 1024);

  // Node.js não expõe a RAM total da máquina directamente.
  // Usar heapTotal como proxy — o rss (resident set size) é mais preciso
  // mas não temos o total da máquina sem o módulo 'os'.
  const os      = require('os');
  const totalMb = Math.round(os.totalmem() / 1024 / 1024);
  const freeMb  = Math.round(os.freemem()  / 1024 / 1024);
  const pct     = Math.round((usedMb / totalMb) * 100);

  _lastStatus = {
    ok:        pct < CRIT_PCT,
    usedMb,
    totalMb,
    freeMb,
    pct,
    checkedAt: new Date().toISOString(),
  };

  if (pct >= CRIT_PCT) {
    console.error(
      `[MemoryGuard] 🚨 ALERTA CRÍTICO — RAM: ${usedMb}MB / ${totalMb}MB (${pct}%). ` +
      `Considere escalar a máquina ou reduzir o número de sessões Baileys activas.`
    );
  } else if (pct >= WARN_PCT) {
    console.warn(
      `[MemoryGuard] ⚠ AVISO — RAM: ${usedMb}MB / ${totalMb}MB (${pct}%). ` +
      `Aproximando-se do limite. Monitore activamente.`
    );
  }
}

/**
 * Iniciar o monitor de memória.
 * Deve ser chamado uma vez no arranque do servidor.
 */
function start() {
  if (_timer) return;
  _check(); // verificar imediatamente ao iniciar
  _timer = setInterval(_check, INTERVAL_MS);
  console.info('[MemoryGuard] Monitor de memória iniciado (intervalo: 30s).');
}

/**
 * Parar o monitor (útil em testes).
 */
function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

/**
 * Devolver o estado actual de memória (para a rota /health/memory).
 */
function getStatus() {
  return { ..._lastStatus };
}

module.exports = { start, stop, getStatus };
