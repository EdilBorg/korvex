/* ══════════════════════════════════════════════════════════════════════
   FASE 3.1 — qr.js
   ────────────────────────────────────────────────────────────────────
   Utilitários de geração de QR Code para sessões WhatsApp.
   Converte o string QR raw do Baileys em imagem PNG base64.
   ══════════════════════════════════════════════════════════════════════ */

const QRCode = require('qrcode');

/**
 * Converte o raw QR string do Baileys para data URI PNG base64.
 * @param {string} rawQr  - string emitido pelo evento 'connection.update' do Baileys
 * @returns {Promise<string>} data URI (data:image/png;base64,...)
 */
async function toDataURI(rawQr) {
  return QRCode.toDataURL(rawQr, {
    errorCorrectionLevel: 'M',
    type:   'image/png',
    margin: 1,
    width:  300,
    color: {
      dark:  '#111827',   // compatível com tema Korvex
      light: '#FFFFFF',
    },
  });
}

/**
 * Converte o raw QR string para buffer PNG.
 * Útil para servir como image/png via HTTP.
 * @param {string} rawQr
 * @returns {Promise<Buffer>}
 */
async function toBuffer(rawQr) {
  return QRCode.toBuffer(rawQr, {
    errorCorrectionLevel: 'M',
    type:   'png',
    margin: 1,
    width:  300,
  });
}

module.exports = { toDataURI, toBuffer };
