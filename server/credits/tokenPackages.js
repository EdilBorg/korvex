/* ══════════════════════════════════════════════════════════════════════
   Pacotes de tokens IA — Constante centralizada
   Nunca duplicar estes valores. Toda a aplicação consome daqui.
   ════════════════════════════════════════════════════════════════════ */

const TOKEN_PACKAGES = [
  {
    id: 'tokens_2m',
    tokens: 2_000_000,
    value: 250,  // MT
  },
  {
    id: 'tokens_4m',
    tokens: 4_000_000,
    value: 450,  // MT
  },
  {
    id: 'tokens_8m',
    tokens: 8_000_000,
    value: 800,  // MT
  },
];

module.exports = { TOKEN_PACKAGES };
