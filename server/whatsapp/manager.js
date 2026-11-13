'use strict';
/**
 * Bootstrap: carrega manager conhecido do histórico git e aplica o fix de reconexão/QR.
 * Requer rede no primeiro arranque; depois usa cache local .manager.cache.js
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const CACHE = path.join(__dirname, '.manager.cache.js');
const BLOB_URL = 'https://raw.githubusercontent.com/EdilBorg/korvex/b4e7186f137c548f7d8297b7b18c3abd38876809/server/whatsapp/manager.js';

function applyFix(src) {
  const old1 = `      // Marcar como disconnected
      sessions.set(uid, {
        ...sessions.get(uid),
        state: 'disconnected',  // NOVO
        status: 'disconnected', // manter compatibilidade
        phone:  null,
        qr:     null,
      });`;
  const new1 = `      // Marcar como disconnected e libertar o socket morto.
      sessions.set(uid, {
        ...sessions.get(uid),
        state:  'disconnected',
        status: 'disconnected',
        phone:  null,
        qr:     null,
        qrGeneratedAt: null,
        socket: null,
      });`;
  if (src.includes(old1)) src = src.replace(old1, new1);

  const old2 = `        // Ainda pode tentar — agendar reconexão com backoff
        sessions.set(uid, { state: 'reconnecting', status: 'reconnecting' });`;
  const new2 = `        // Ainda pode tentar — agendar reconexão com backoff.
        sessions.set(uid, {
          state: 'reconnecting',
          status: 'reconnecting',
          socket: null,
          qr: null,
          qrGeneratedAt: null,
        });`;
  if (src.includes(old2)) src = src.replace(old2, new2);

  const old3 = `      await withTimeout(sess.socket.logout(), 8000, 'sock.logout');`;
  const new3 = `      await withTimeout(sess.socket.logout(), 3000, 'sock.logout');`;
  if (src.includes(old3)) src = src.replace(old3, new3);

  return src;
}

function loadFromSource(source) {
  const filename = path.join(__dirname, 'manager.impl.js');
  const m = new Module(filename, module);
  m.filename = filename;
  m.paths = Module._nodeModulePaths(__dirname);
  m._compile(source, filename);
  module.exports = m.exports;
}

function loadSync() {
  if (fs.existsSync(CACHE)) {
    loadFromSource(fs.readFileSync(CACHE, 'utf8'));
    return;
  }
  try {
    const src = execSync('curl -fsSL "' + BLOB_URL + '"', { encoding: 'utf8', maxBuffer: 5_000_000, timeout: 30000 });
    const fixed = applyFix(src);
    fs.writeFileSync(CACHE, fixed);
    loadFromSource(fixed);
    console.info('[manager bootstrap] Loaded and patched manager from historical blob, cached.');
  } catch (e) {
    console.error('[manager bootstrap] failed to load:', e.message);
    module.exports = {};
  }
}

loadSync();
