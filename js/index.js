/* ══════════════════════════════════════════════════════════════════════
   FASE 3.1.2 — Korvex Backend Server (bugfix CORS + geração de QR)
   ────────────────────────────────────────────────────────────────────
   Servidor Express com rotas para gestão de sessões WhatsApp via QR Code.

   Rotas implementadas:
     POST /whatsapp/connect        → iniciar sessão + gerar QR
     POST /whatsapp/disconnect     → encerrar sessão
     GET  /whatsapp/status/:uid    → estado actual da sessão
     GET  /whatsapp/qr/:uid        → QR Code em base64 (polling)

   Para iniciar:
     cd server && npm install && npm start

   Variáveis de ambiente:
     PORT                          (padrão: 3001)
     FRONTEND_URL                  (para CORS)
     FIREBASE_SERVICE_ACCOUNT_PATH (chave Admin SDK)
   ══════════════════════════════════════════════════════════════════════ */

require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const manager  = require('./whatsapp/manager');
const workflowEngine = require('./engine/workflowEngine'); // FASE 3.2 — motor de execução de fluxos
const inbox    = require('./engine/inbox'); // FASE 4.0 — Inbox (observadora, rotas de leitura/envio manual)

// ── Firebase Admin SDK ────────────────────────────────────────────────
let admin;
let db;

try {
  admin = require('firebase-admin');

  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH
    || path.join(__dirname, 'serviceAccountKey.json');

  if (fs.existsSync(serviceAccountPath)) {
    // Autenticação via ficheiro JSON (recomendado em produção)
    const serviceAccount = require(serviceAccountPath);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  } else if (process.env.FIREBASE_PROJECT_ID) {
    // Autenticação via variáveis de ambiente individuais
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      }),
    });
  } else {
    console.warn('[Server] Firebase Admin SDK não configurado. O Firestore não será actualizado.');
    console.warn('[Server] Copie serviceAccountKey.json para server/ ou configure as variáveis de ambiente.');
    admin = null;
  }

  if (admin) {
    db = admin.firestore();
    manager.setFirestore(db);
    console.info('[Server] Firebase Admin SDK inicializado.');

    // FASE 3.2 — Inicializar o motor de execução de fluxos:
    //   • workflowEngine.init() recebe o Firestore e a função de envio
    //     de mensagens (manager.sendMessage), para responder ao WhatsApp.
    //   • manager.setOnIncomingMessage() liga o evento messages.upsert
    //     já existente no manager.js ao motor, sem alterar mais nada do
    //     fluxo de conexão/QR.
    workflowEngine.init(db, manager.sendMessage);
    manager.setOnIncomingMessage(workflowEngine.handleIncoming);
    console.info('[Server] Motor de fluxos (WorkflowEngine) inicializado.');

    // FASE 4.0 — Inbox: módulo observador, partilha o mesmo Firestore.
    inbox.setFirestore(db);
    console.info('[Server] Inbox inicializada.');
  }
} catch (e) {
  console.error('[Server] Erro ao inicializar Firebase Admin:', e.message);
  admin = null;
}

// ── Express ──────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3001;

// CORS — permitir o frontend Korvex (todos os origins locais + produção)
//
// FASE 3.1.2 — BUGFIX: a lista fixa de portas estava a bloquear qualquer
// origem que não estivesse explicitamente listada (ex.: abrir o index.html
// com Live Server numa porta diferente, file://, ou outra porta local).
// Quando isso acontecia, a função `origin` chamava cb(new Error(...)),
// o que faz o Express tratar o pedido como erro SEM nunca chegar a
// adicionar os cabeçalhos Access-Control-Allow-Origin — o browser então
// bloqueia a resposta por CORS e o fetch() falha com "Failed to load
// resource" / "Failed to fetch", que no frontend aparece como "Não foi
// possível contactar o servidor Korvex".
//
// Correcção: aceitar automaticamente qualquer origem localhost/127.0.0.1
// independentemente da porta (cobre Live Server, http-server, Vite,
// abrir directamente o ficheiro via um servidor estático qualquer, etc.),
// mantendo a lista de produção explícita por segurança.
const allowedOrigins = [
  // Produção — apenas estes domínios são aceites fora de ambiente local
  'https://korvex.app',
  'https://korvex-ebf.web.app',
  'https://korvex-ebf.firebaseapp.com',
  // Variável de ambiente (sobrepõe tudo se definida)
  ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : []),
];

// Regex: aceita http://localhost:<qualquer porta> e http://127.0.0.1:<qualquer porta>
// (e variante 0.0.0.0), cobrindo Live Server, http-server, Vite, etc.
const localOriginPattern = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/;

const _corsOptions = {
  origin: (origin, cb) => {
    // Sem origin = curl, Postman, servidor-a-servidor → permitir
    if (!origin) return cb(null, true);

    if (allowedOrigins.includes(origin) || localOriginPattern.test(origin)) {
      return cb(null, true);
    }

    console.warn('[CORS] Bloqueado:', origin, '— adicione FRONTEND_URL no .env se for um domínio de produção legítimo.');
    // Importante: NÃO passar um Error aqui. Passar `false` faz o middleware
    // `cors` responder sem o cabeçalho Access-Control-Allow-Origin (bloqueio
    // correcto e silencioso do lado do browser) em vez de cair no error
    // handler genérico do Express, que devolvia 500 para pedidos OPTIONS
    // de preflight e quebrava sempre o pedido seguinte.
    return cb(null, false);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 200, // alguns browsers enviam OPTIONS com 204 — forçar 200
};

// Responder preflight OPTIONS antes de qualquer outro middleware
app.options('*', cors(_corsOptions));
app.use(cors(_corsOptions));

app.use(express.json());

// Garantir pasta de autenticação
const AUTH_BASE = path.join(__dirname, 'auth');
fs.mkdirSync(AUTH_BASE, { recursive: true });

// ══════════════════════════════════════════════════════════════════════
// Middleware: verificar uid no body ou params
// ══════════════════════════════════════════════════════════════════════
function requireUid(req, res, next) {
  const uid = req.body?.uid || req.params?.uid;
  if (!uid || typeof uid !== 'string' || uid.length < 10) {
    return res.status(400).json({ ok: false, error: 'uid inválido ou em falta.' });
  }
  req.uid = uid;
  next();
}

// ══════════════════════════════════════════════════════════════════════
// POST /whatsapp/connect
// Body: { uid: string }
// Resposta: { ok: true, status: 'connecting', sessionId: string }
// ══════════════════════════════════════════════════════════════════════
app.post('/whatsapp/connect', requireUid, async (req, res) => {
  const { uid } = req;
  console.info(`[POST /whatsapp/connect] uid: ${uid}`);

  try {
    // startSession é assíncrono mas não esperamos o QR aqui.
    // O cliente faz polling em GET /whatsapp/qr/:uid
    startSessionSafe(uid);

    res.json({
      ok:        true,
      status:    'connecting',
      sessionId: uid,
      message:   'Sessão a iniciar. Aguardar QR Code via GET /whatsapp/qr/:uid',
    });
  } catch (e) {
    console.error('[POST /whatsapp/connect] Erro:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
// POST /whatsapp/disconnect
// Body: { uid: string }
// Resposta: { ok: true }
// ══════════════════════════════════════════════════════════════════════
app.post('/whatsapp/disconnect', requireUid, async (req, res) => {
  const { uid } = req;
  console.info(`[POST /whatsapp/disconnect] uid: ${uid}`);

  try {
    await manager.closeSession(uid, true);
    res.json({ ok: true, status: 'disconnected' });
  } catch (e) {
    console.error('[POST /whatsapp/disconnect] Erro:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
// POST /whatsapp/flow-changed
// FASE 3.2.1 — Parte 6/7: chamado pelo frontend (ConnectionService.
// changeActiveFlow) imediatamente após gravar um novo activeFlowId no
// Firestore, para o motor de fluxos deixar de usar a versão em cache
// (até 15s) e passar a executar o fluxo recém-escolhido já na próxima
// mensagem. Sem isto, a troca de fluxo só faria efeito depois do TTL
// da cache expirar — aceitável, mas pior experiência.
// Body: { uid: string }
// Resposta: { ok: true }
// ══════════════════════════════════════════════════════════════════════
app.post('/whatsapp/flow-changed', requireUid, (req, res) => {
  const { uid } = req;
  workflowEngine.invalidateFlowCache(uid, 'whatsapp');
  console.info(`[POST /whatsapp/flow-changed] uid: ${uid} — cache de fluxo invalidado`);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════
// GET /whatsapp/status/:uid
// Resposta: { ok: true, status, phone, sessionId, qrGeneratedAt }
// ══════════════════════════════════════════════════════════════════════
app.get('/whatsapp/status/:uid', requireUid, (req, res) => {
  const { uid } = req;
  const info = manager.getStatus(uid);
  res.json({
    ok:   true,
    uid,
    ...info,
    // Não devolver o QR aqui (pode ser grande); usar /qr/:uid
    qr: undefined,
  });
});

// ══════════════════════════════════════════════════════════════════════
// GET /whatsapp/qr/:uid
// Devolve o QR Code actual (data URI) ou null se ainda não disponível.
// O cliente faz polling a cada 2 s.
// Resposta: { ok: true, qr: string|null, status, qrGeneratedAt }
// ══════════════════════════════════════════════════════════════════════
app.get('/whatsapp/qr/:uid', requireUid, (req, res) => {
  const { uid } = req;
  const info = manager.getStatus(uid);

  res.json({
    ok:            true,
    uid,
    status:        info.status,
    qr:            info.qr || null,
    qrGeneratedAt: info.qrGeneratedAt || null,
  });
});

// ══════════════════════════════════════════════════════════════════════
// FASE 4.0 — Rotas da Inbox
// A Inbox lê/escreve directamente no Firestore a partir do frontend
// (mesmo padrão do ConnectionService — listener onSnapshot em tempo
// real), por isso a maioria das rotas aqui é "fina": apenas expõe
// operações que precisam de passar pelo backend porque envolvem o
// Baileys (enviar mensagem) ou lógica server-side de displayName.
//
// GET  /inbox/:uid/:phone/messages?limit=N   → histórico de uma conversa
// POST /inbox/:uid/:phone/read               → marcar como lida (unreadCount = 0)
// POST /inbox/:uid/:phone/name                → definir nome salvo pelo vendedor
// POST /inbox/:uid/:phone/send                → vendedor responde manualmente
// ══════════════════════════════════════════════════════════════════════

function requirePhone(req, res, next) {
  const phone = req.params?.phone;
  if (!phone || typeof phone !== 'string') {
    return res.status(400).json({ ok: false, error: 'phone inválido ou em falta.' });
  }
  req.phone = phone;
  next();
}

// ──────────────────────────────────────────────────────────────────────
// GET /inbox/:uid/:phone/messages
// Resposta: { ok: true, messages: [...] }  (ordenadas por timestamp asc)
// ──────────────────────────────────────────────────────────────────────
app.get('/inbox/:uid/:phone/messages', requireUid, requirePhone, async (req, res) => {
  const { uid, phone } = req;
  const limit = Math.min(Number(req.query.limit) || 200, 500);

  // DEBUG TEMPORÁRIO — remover após confirmar que o bug está resolvido
  console.log('[INBOX] conversa solicitada', { uid: uid.slice(0, 8) + '…', phone, limit });

  if (!db) return res.status(503).json({ ok: false, error: 'Firestore não configurado.' });

  try {
    const safePhone = String(phone).replace(/\//g, '_');
    const snap = await db
      .collection('workspaces').doc(uid)
      .collection('conversations').doc(safePhone)
      .collection('messages')
      .orderBy('timestamp', 'asc')
      .limitToLast(limit)
      .get();

    const messages = snap.docs.map(d => d.data());

    // DEBUG TEMPORÁRIO — remover após confirmar que o bug está resolvido
    console.log('[INBOX] mensagens encontradas', messages.length, '| safePhone:', safePhone);

    res.json({ ok: true, messages });
  } catch (e) {
    console.error('[GET /inbox/:uid/:phone/messages] Erro:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /inbox/:uid/:phone/read
// Body: { uid: string }  (phone vem do params)
// Resposta: { ok: true }
// ──────────────────────────────────────────────────────────────────────
app.post('/inbox/:uid/:phone/read', requireUid, requirePhone, async (req, res) => {
  const { uid, phone } = req;
  try {
    await inbox.markAsRead(uid, phone);
    res.json({ ok: true });
  } catch (e) {
    console.error('[POST /inbox/:uid/:phone/read] Erro:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /inbox/:uid/:phone/name
// Body: { uid: string, savedName: string|null }
// Resposta: { ok: true, displayName: string }
// ──────────────────────────────────────────────────────────────────────
app.post('/inbox/:uid/:phone/name', requireUid, requirePhone, async (req, res) => {
  const { uid, phone } = req;
  const { savedName } = req.body || {};

  if (savedName !== null && typeof savedName !== 'string') {
    return res.status(400).json({ ok: false, error: 'savedName deve ser string ou null.' });
  }

  try {
    const result = await inbox.setSavedName(uid, phone, savedName);
    res.json({ ok: true, displayName: result.displayName });
  } catch (e) {
    console.error('[POST /inbox/:uid/:phone/name] Erro:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /inbox/:uid/:phone/send
// Envio manual do vendedor pela Inbox — usa o MESMO manager.sendMessage
// já usado pelo motor de fluxos (nenhum caminho novo para o Baileys).
// Body: { uid: string, text: string }
// Resposta: { ok: true }
// ──────────────────────────────────────────────────────────────────────
app.post('/inbox/:uid/:phone/send', requireUid, requirePhone, async (req, res) => {
  const { uid, phone } = req;
  const { text } = req.body || {};

  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ ok: false, error: 'text inválido ou em falta.' });
  }

  try {
    await manager.sendMessage(uid, phone, text);
    await inbox.recordOutgoing(uid, phone, { type: 'text', text });
    res.json({ ok: true });
  } catch (e) {
    console.error('[POST /inbox/:uid/:phone/send] Erro:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Health check ─────────────────────────────────────────────────────
app.get('/health', (_, res) => {
  res.json({ ok: true, service: 'korvex-server', version: '3.2.0' });
});

// ── 404 ──────────────────────────────────────────────────────────────
app.use((_, res) => {
  res.status(404).json({ ok: false, error: 'Rota não encontrada.' });
});

// ── Error handler ─────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[Server] Erro não tratado:', err.message);
  res.status(500).json({ ok: false, error: err.message });
});

// ── Iniciar servidor ──────────────────────────────────────────────────
app.listen(PORT, () => {
  console.info(`\n╔══════════════════════════════════════╗`);
  console.info(`║  Korvex Server — FASE 3.2            ║`);
  console.info(`║  Porta: ${PORT}                          ║`);
  console.info(`║  Firebase: ${admin ? 'OK ✓' : 'NÃO CONFIGURADO ✗'}              ║`);
  console.info(`╚══════════════════════════════════════╝\n`);
});

// ── Helper: iniciar sessão com protecção contra erros não tratados ─────
function startSessionSafe(uid) {
  manager.startSession(uid).catch(async e => {
    console.error(`[Server] startSession error — uid: ${uid} | ${e.message}`);
    // FASE 3.1.2 — BUGFIX: antes, um erro aqui (ex.: falha ao obter a
    // versão do Baileys, ou ao escrever ficheiros de auth) deixava a
    // sessão presa em "connecting" sem QR até o timeout do frontend (60s)
    // expirar, sem nenhuma pista sobre a causa real. Agora reportamos
    // o erro de imediato e libertamos a sessão.
    await manager.closeSession(uid, false).catch(() => {});
  });
}
