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
const manager     = require('./whatsapp/manager');    // usado apenas localmente para fallback/testes
const workerPool  = require('./whatsapp/workerPool'); // substitui manager em produção
const memoryGuard = require('./whatsapp/memoryGuard'); // monitor de RAM — usado em /health/memory e no arranque
const workflowEngine = require('./engine/workflowEngine'); // FASE 3.2 — motor de execução de fluxos
const inbox    = require('./engine/inbox'); // FASE 4.0 — Inbox (observadora, rotas de leitura/envio manual)
const { recoverPendingDelays } = require('./engine/executors/delay'); // FASE 5 — recuperar delays após restart
const plans      = require('./plans'); // Planos de subscrição — verificação server-side
const payments   = require('./payments'); // Pagamentos — PaySuite (assinatura Korvex Premium)
const credits    = require('./credits'); // Sistema de créditos IA
const sessions   = require('./sessions'); // FASE 5 — Sistema de sessões (ferramentas admin)
const cleanupJob = require('./jobs/cleanupJob'); // FASE 6 — Limpeza automática de sessões inactivas
const analyticsService = require('./analytics/analyticsService'); // Página Analytics — métricas agregadas reais
const exportService    = require('./analytics/exportService');    // Exportação CSV/Excel do Analytics

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
    // Construir config Firebase para os workers
    const _fbConfig = (() => {
      const saPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH
        || require('path').join(__dirname, 'serviceAccountKey.json');
      const _fs = require('fs');
      if (_fs.existsSync(saPath)) {
        return { serviceAccount: require(saPath) };
      }
      return {
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      };
    })();

    // Inicializar pool de workers — cada worker gere até 250 sessões Baileys
    // em processo separado, isolando RAM e evitando crash em cascata
    workerPool.init(_fbConfig, workflowEngine.handleIncoming);

    // WorkflowEngine usa workerPool.sendMessage para enviar respostas ao WhatsApp
    workflowEngine.init(db, workerPool.sendMessage);
    console.info('[Server] Motor de fluxos (WorkflowEngine) inicializado com WorkerPool.');

    // FASE 4.0 — Inbox: módulo observador, partilha o mesmo Firestore.
    inbox.setFirestore(db);
    console.info('[Server] Inbox inicializada.');

    // FASE 5 — Recuperar delays pendentes que sobreviveram a um restart.
    // Corre de forma assíncrona sem bloquear o servidor.
    recoverPendingDelays(db, workflowEngine._resumeFromDelay).catch(e => {
      console.error('[Server] Erro ao recuperar delays pendentes:', e.message);
    });

    // Planos — injectar Firestore para verificação de acesso server-side
    plans.setFirestore(db);
    credits.setFirestore(db);
    console.info('[Server] Módulo de planos inicializado.');

    // Pagamentos — injectar Firestore (assinatura Korvex Premium via PaySuite)
    payments.setFirestore(db);
    console.info('[Server] Módulo de pagamentos inicializado.');

    // Analytics — injectar Firestore para agregação de métricas reais
    analyticsService.setFirestore(db);
    console.info('[Server] Módulo de Analytics inicializado.');

    // FASE 6 — Limpeza automática de sessões inactivas (60 dias)
    // Corre em background, nunca bloqueia o processamento de mensagens.
    cleanupJob.setFirestore(db);
    cleanupJob.scheduleCleanup();
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

app.use(express.json({
  // Guarda o corpo em bruto (bytes exactos recebidos) em req.rawBody.
  // Necessário para validar a assinatura HMAC do webhook da PaySuite,
  // que é calculada sobre o corpo tal como foi enviado — não sobre o
  // objecto já interpretado. Não afecta nenhuma rota existente.
  verify: (req, res, buf) => { req.rawBody = buf; },
}));

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
  const slot    = req.body?.slot || 'whatsapp_1';
  const VALID_SLOTS = ['whatsapp_1', 'whatsapp_2'];
  const requestId = Math.random().toString(36).substring(2, 11);
  const connectStartTime = Date.now();

  if (!VALID_SLOTS.includes(slot)) {
    return res.status(400).json({ ok: false, error: `Slot inválido: "${slot}". Use "whatsapp_1" ou "whatsapp_2".` });
  }

  // [CONNECT REQUEST] — Pedido de conexão recebido
  console.log(`
[CONNECT REQUEST]
┌─ requestId: ${requestId}
├─ timestamp: ${connectStartTime}
├─ uid: ${uid}
├─ slot: ${slot}
├─ sessaoJaExistia: ${workerPool.getPoolStatus ? 'check_workers' : 'unknown'}
├─ estadoSessao: connecting
└─ worker_responsavel: deterministic_hash
  `);

  console.info(`[POST /whatsapp/connect] uid: ${uid} | slot: ${slot}`);

  try {
    if (db) {
      // Slot 2 exige plano Premium
      if (slot === 'whatsapp_2') {
        const { allowed, plan } = await plans.checkPlanAccess(uid, plans.FEATURES.WHATSAPP_SECOND_NUMBER);
        if (!allowed) {
          return res.status(403).json({
            ok: false,
            error: `O plano ${plan} não permite um segundo número WhatsApp. Faça upgrade para Premium.`,
            plan,
          });
        }
      }

      // Verificar total de conexões activas vs limite do plano
      const connectionsSnap = await db
        .collection('workspaces').doc(uid)
        .collection('connections')
        .where('status', '==', 'connected')
        .get();

      const { plan } = await plans.checkPlanAccess(uid, plans.FEATURES.WORKFLOW_EXECUTION);
      const maxAllowed = plans.PLAN_RULES[plan]?.maxWhatsappNumbers ?? 1;
      const activeCount = connectionsSnap.size;

      if (activeCount >= maxAllowed) {
        return res.status(403).json({
          ok: false,
          error: `O plano ${plan} permite no máximo ${maxAllowed} número(s) WhatsApp conectado(s).`,
          plan, activeCount, maxAllowed,
        });
      }
    }

    // sessionId = uid_slot para identificar cada sessão Baileys separadamente
    const sessionId = `${uid}_${slot}`;
    workerPool.startSession(uid, slot);

    // [CONNECT RESPONSE] — Resposta enviada
    const connectEndTime = Date.now();
    console.log(`
[CONNECT RESPONSE]
┌─ requestId: ${requestId}
├─ timestamp: ${connectEndTime}
├─ uid: ${uid}
├─ slot: ${slot}
├─ tempoTotal: ${connectEndTime - connectStartTime}ms
├─ status: connecting
└─ sessionId: ${sessionId}
    `);

    res.json({ ok: true, status: 'connecting', sessionId, slot,
      message: `Sessão a iniciar. Aguardar QR Code via GET /whatsapp/qr/${uid}/${slot}` });
  } catch (e) {
    // [CONNECT RESPONSE ERROR]
    const connectEndTime = Date.now();
    console.log(`
[CONNECT RESPONSE]
┌─ requestId: ${requestId}
├─ timestamp: ${connectEndTime}
├─ uid: ${uid}
├─ slot: ${slot}
├─ tempoTotal: ${connectEndTime - connectStartTime}ms
├─ status: error
└─ erro: ${e.message}
    `);
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
  const slot      = req.body?.slot || 'whatsapp_1';
  const sessionId = `${uid}_${slot}`;
  console.info(`[POST /whatsapp/disconnect] uid: ${uid} | slot: ${slot}`);

  try {
    await workerPool.closeSession(uid, slot);
    res.json({ ok: true, status: 'disconnected', slot });
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
  const slot      = req.body?.slot || 'whatsapp_1';
  const sessionId = `${uid}_${slot}`;
  workflowEngine.invalidateFlowCache(sessionId, slot);
  console.info(`[POST /whatsapp/flow-changed] uid: ${uid} | slot: ${slot} — cache invalidado`);
  res.json({ ok: true, slot });
});

// ══════════════════════════════════════════════════════════════════════
// GET /whatsapp/status/:uid
// Resposta: { ok: true, status, phone, sessionId, qrGeneratedAt }
// ══════════════════════════════════════════════════════════════════════
app.get('/whatsapp/status/:uid/:slot?', requireUid, async (req, res) => {
  const { uid } = req;
  const slot      = req.params.slot || 'whatsapp_1';
  const sessionId = `${uid}_${slot}`;
  // [INSTRUMENTAÇÃO QR] Rota STATUS request
  console.log(`[API STATUS REQUEST] uid: ${uid}, slot: ${slot}, timestamp: ${Date.now()}`);
  const info = await workerPool.getStatus(`${uid}_${slot}`);
  // [INSTRUMENTAÇÃO QR] Rota STATUS response
  console.log(`[API STATUS RESPONSE] uid: ${uid}, slot: ${slot}, status: ${info.status}, timestamp: ${Date.now()}`);
  res.json({ ok: true, uid, slot, ...info, qr: undefined });
});

// ══════════════════════════════════════════════════════════════════════
// GET /whatsapp/qr/:uid
// Devolve o QR Code actual (data URI) ou null se ainda não disponível.
// O cliente faz polling a cada 2 s.
// Resposta: { ok: true, qr: string|null, status, qrGeneratedAt }
// ══════════════════════════════════════════════════════════════════════
app.get('/whatsapp/qr/:uid/:slot?', requireUid, async (req, res) => {
  const { uid } = req;
  const slot      = req.params.slot || 'whatsapp_1';
  const sessionId = `${uid}_${slot}`;
  const requestTime = Date.now();
  
  // [QR API REQUEST] — Pedido de QR recebido
  console.log(`
[QR API REQUEST]
┌─ timestamp: ${requestTime}
├─ uid: ${uid}
├─ slot: ${slot}
└─ sessionId: ${sessionId}
  `);
  
  // [INSTRUMENTAÇÃO QR] Rota QR request
  console.log(`[API QR REQUEST] uid: ${uid}, slot: ${slot}, timestamp: ${requestTime}`);
  const info = await workerPool.getQr(uid, slot);
  
  // [QR API RESPONSE] — Resposta preparada
  const responseTime = Date.now();
  const qrSize = info.qr ? info.qr.length : 0;
  console.log(`
[QR API RESPONSE]
┌─ timestamp: ${responseTime}
├─ uid: ${uid}
├─ slot: ${slot}
├─ estado: ${info.status}
├─ qrExiste: ${!!info.qr}
├─ tamanhoQR: ${qrSize} bytes
├─ instanceId: ${info.instanceId || 'unknown'}
└─ tempoProcessamento: ${responseTime - requestTime}ms
  `);
  
  // [INSTRUMENTAÇÃO QR] Rota QR response
  console.log(`[API QR RESPONSE] uid: ${uid}, slot: ${slot}, qrExiste: ${!!info.qr}, status: ${info.status}, timestamp: ${responseTime}`);
  const responseData = { ...info, ok: true, uid, slot };
  res.json(responseData);
  // [DIAGNÓSTICO QR] Verificar resposta enviada
  console.log(`[QR RESPONSE SENT] uid: ${uid}, slot: ${slot}, enviouQR: ${!!responseData.qr}, status: ${responseData.status}, timestamp: ${Date.now()}`);
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
    // BUGFIX: usava manager.sendMessage (processo principal), cuja
    // tabela de sessões está sempre vazia — a sessão real vive no
    // worker subprocess gerido por workerPool.js. Isto fazia toda
    // resposta manual pela Inbox falhar com "Sessão não está conectada",
    // mesmo com o WhatsApp claramente ligado no frontend.
    await workerPool.sendMessage(uid, phone, text);
    await inbox.recordOutgoing(uid, phone, { type: 'text', text });
    res.json({ ok: true });
  } catch (e) {
    console.error('[POST /inbox/:uid/:phone/send] Erro:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ──────────────────────────────────────────────────────────────────────
// DELETE /inbox/:uid/:phone
// Apaga o resumo do contacto (inbox) e todas as suas mensagens (conversations).
// Resposta: { ok: true }
// ──────────────────────────────────────────────────────────────────────
app.delete('/inbox/:uid/:phone', requireUid, requirePhone, async (req, res) => {
  const { uid, phone } = req;

  if (!db) return res.status(503).json({ ok: false, error: 'Firestore não configurado.' });

  try {
    const safePhone = String(phone).replace(/\//g, '_');

    // 1. Apagar todas as mensagens da conversa
    const msgsCol = db
      .collection('workspaces').doc(uid)
      .collection('conversations').doc(safePhone)
      .collection('messages');

    const msgsSnap = await msgsCol.get();
    const batch = db.batch();
    msgsSnap.docs.forEach(d => batch.delete(d.ref));

    // 2. Apagar o documento da conversa em si
    const convRef = db
      .collection('workspaces').doc(uid)
      .collection('conversations').doc(safePhone);
    batch.delete(convRef);

    // 3. Apagar o resumo do inbox
    const inboxRef = db
      .collection('workspaces').doc(uid)
      .collection('inbox').doc(safePhone);
    batch.delete(inboxRef);

    await batch.commit();

    console.info(`[DELETE /inbox/:uid/:phone] Contacto apagado — uid:${uid} phone:${phone}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[DELETE /inbox/:uid/:phone] Erro:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
// Rotas de planos de subscrição
// Toda a lógica de verificação é server-side — o cliente NUNCA é
// fonte de verdade sobre o seu próprio plano.
//
// GET  /plans/:uid/access/:feature → verificar acesso a funcionalidade
// POST /plans/:uid/plan            → alterar plano (apenas admin/backend)
// POST /plans/:uid/invalidate-cache → limpar cache do plano (após upgrade)
// ══════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════
// Pagamentos — Assinatura Korvex Premium via PaySuite
// ──────────────────────────────────────────────────────────────────────
// POST /payments/subscribe  → inicia um pagamento (mpesa | emola | credit_card)
// POST /payments/webhook    → recebido pela PaySuite quando o pagamento
//                              é confirmado ou falha (payment.success /
//                              payment.failed). Valida X-Webhook-Signature.
// ══════════════════════════════════════════════════════════════════════

/**
 * POST /payments/subscribe
 * Body: { uid, plan: 'pro'|'premium', method?: 'mpesa'|'emola'|'credit_card', returnUrl?, callbackUrl? }
 * (plan é obrigatório — escolha do utilizador na interface)
 * (method é opcional — se omitido, o cliente escolhe na própria página
 * de checkout da PaySuite. É lá, e só lá, que o número M-Pesa/e-Mola ou
 * os dados do cartão são introduzidos e validados — o Korvex não pede
 * nem guarda esses dados.)
 * Resposta: { ok, paymentId, checkoutUrl, status }
 */
app.post('/payments/subscribe', requireUid, async (req, res) => {
  const { uid } = req;
  const { plan, method, description, returnUrl, callbackUrl } = req.body || {};

  if (!db) return res.status(503).json({ ok: false, error: 'Firestore não configurado.' });

  // ✅ Validar plan — OBRIGATÓRIO
  if (!plan || !['pro', 'premium'].includes(plan)) {
    return res.status(400).json({ 
      ok: false, 
      error: 'Plano inválido. Escolha entre "pro" ou "premium".' 
    });
  }

  try {
    const result = await payments.startSubscription({ uid, method, plan, description, returnUrl, callbackUrl });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (e) {
    console.error('[POST /payments/subscribe] Erro:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /payments/buyTokens
 * Body: { uid, packageId, method?: 'mpesa'|'emola'|'credit_card', returnUrl?, callbackUrl? }
 * Resposta: { ok, paymentId, checkoutUrl, status }
 */
app.post('/payments/buyTokens', requireUid, async (req, res) => {
  const { uid } = req;
  const { packageId, method, returnUrl, callbackUrl } = req.body || {};

  if (!db) return res.status(503).json({ ok: false, error: 'Firestore não configurado.' });
  if (!packageId) return res.status(400).json({ ok: false, error: 'packageId em falta.' });

  try {
    const result = await payments.startTokenPurchase({ uid, packageId, method, returnUrl, callbackUrl });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (e) {
    console.error('[POST /payments/buyTokens] Erro:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /payments/webhook
 * Recebido pela PaySuite. Valida a assinatura no cabeçalho
 * X-Webhook-Signature antes de processar qualquer evento.
 * Body esperado (a confirmar com a documentação oficial):
 *   { type: 'payment.success' | 'payment.failed', reference, transaction_id }
 */
app.post('/payments/webhook', async (req, res) => {
  const signature = req.get('X-Webhook-Signature');
  const rawBody   = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));

  const paysuiteClient = require('./payments/paysuite');
  if (!paysuiteClient.verifyWebhookSignature(rawBody, signature)) {
    console.warn('[POST /payments/webhook] Assinatura inválida — pedido rejeitado.');
    return res.status(401).json({ ok: false, error: 'Assinatura do webhook inválida.' });
  }

  // TODO(paysuite-docs): confirmar os nomes exactos destes campos no
  // corpo do webhook junto da documentação oficial da PaySuite.
  const { type, reference, transaction_id: transactionId } = req.body || {};

  try {
    const result = await payments.handleWebhookEvent({ type, reference, transactionId, raw: req.body });
    if (!result.ok) {
      console.warn('[POST /payments/webhook] Falha ao processar evento:', result.error);
      return res.status(400).json(result);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('[POST /payments/webhook] Erro:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
// DEV MOCK — POST /dev/mark-paid
// ──────────────────────────────────────────────────────────────────────
// Substitui temporariamente PaySuite + webhook + checkout durante o
// desenvolvimento, para poder testar o fluxo de assinatura sem depender
// de pagamentos reais. Produz exactamente o mesmo efeito que o webhook
// payment.success real (payments.devMarkPaid -> activateSubscription):
// activa Premium por 30 dias e regista o pagamento na faturacao do
// painel admin, marcado com devMock:true.
//
// PROTECCAO: so fica activa quando NODE_ENV === 'development'. Em
// qualquer outro ambiente a rota responde sempre 403, mesmo que o
// codigo seja acidentalmente enviado para producao.
//
// Body: { uid: string, method?: 'mpesa'|'emola'|'credit_card' }
// Resposta: { ok, paymentId, plan: 'premium', amount, validDays }
// ══════════════════════════════════════════════════════════════════════
if (process.env.NODE_ENV === 'development') {
  console.warn('[Server] AVISO: POST /dev/mark-paid ACTIVO - apenas para desenvolvimento. NUNCA usar em producao.');

  app.post('/dev/mark-paid', requireUid, async (req, res) => {
    const { uid }    = req;
    const { method, plan } = req.body || {};

    if (!db) return res.status(503).json({ ok: false, error: 'Firestore não configurado.' });

    // Validar plano — OBRIGATÓRIO
    if (!plan || !['pro', 'premium'].includes(plan)) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Plano obrigatório. Escolha entre "pro" ou "premium".' 
      });
    }

    try {
      const result = await payments.devMarkPaid({ uid, method, plan });
      if (!result.ok) return res.status(400).json(result);
      console.info(`[DEV] /dev/mark-paid — uid: ${uid} | plan: ${plan} → Ativado (mock, método: ${method || 'credit_card'})`);
      res.json(result);
    } catch (e) {
      console.error('[POST /dev/mark-paid] Erro:', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // POST /dev/confirm-payment
  // Confirma manualmente um pagamento REAL, criado via /payments/subscribe
  // (checkout real da PaySuite). Faz o papel do webhook payment.success,
  // que a PaySuite não consegue entregar a um servidor local sem URL
  // pública. Usar depois de o cliente concluir (ou simular) o pagamento
  // na página de checkout real.
  // Body: { uid: string, paymentId: string }  ← paymentId devolvido por
  //       /payments/subscribe (id interno do Firestore, não o da PaySuite)
  // Resposta: { ok, uid, paymentId, plan: 'premium', activated: true }
  // ────────────────────────────────────────────────────────────────────
  app.post('/dev/confirm-payment', requireUid, async (req, res) => {
    const { uid }        = req;
    const { paymentId, plan }  = req.body || {};

    if (!db) return res.status(503).json({ ok: false, error: 'Firestore não configurado.' });
    if (!paymentId) return res.status(400).json({ ok: false, error: 'paymentId em falta.' });
    
    // Validar plano — OBRIGATÓRIO
    if (!plan || !['pro', 'premium'].includes(plan)) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Plano obrigatório. Escolha entre "pro" ou "premium".' 
      });
    }

    try {
      const result = await payments.devConfirmPayment({ uid, paymentId, plan });
      if (!result.ok) return res.status(400).json(result);
      console.info(`[DEV] /dev/confirm-payment — uid: ${uid} | paymentId: ${paymentId} | plan: ${plan} → Ativado (confirmação simulada)`);
      res.json(result);
    } catch (e) {
      console.error('[POST /dev/confirm-payment] Erro:', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });
} else {
  // Em qualquer ambiente que nao seja development, a rota existe mas
  // bloqueia sempre - evita "rota nao encontrada" confusa e deixa claro
  // porque esta bloqueada, sem nunca simular um pagamento fora de DEV.
  app.post('/dev/mark-paid', (_req, res) => {
    res.status(403).json({ ok: false, error: 'Endpoint disponível apenas em NODE_ENV=development.' });
  });
  app.post('/dev/confirm-payment', (_req, res) => {
    res.status(403).json({ ok: false, error: 'Endpoint disponível apenas em NODE_ENV=development.' });
  });
}

/**
 * GET /plans/:uid/access/:feature
 * Verifica se a conta tem acesso à funcionalidade solicitada.
 * Resposta: { ok: true, allowed: boolean, plan: string }
 *
 * Funcionalidades disponíveis (ver FEATURES):
 *   'ai' | 'whatsapp_second_number'
 */
app.get('/plans/:uid/access/:feature', requireUid, async (req, res) => {
  const { uid } = req;
  const { feature } = req.params;

  try {
    const result = await plans.checkPlanAccess(uid, feature);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[GET /plans/:uid/access/:feature] Erro:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /plans/:uid/plan
 * Define o plano de uma conta. Uso exclusivo do backend/admin.
 * Body: { uid: string, plan: 'premium' | 'suspended' }
 * Resposta: { ok: true, plan: string }
 *
 * Regras de negócio:
 *   - 'trial' só é atribuído na criação da conta — nunca via esta rota.
 *   - Um cliente Premium que não paga passa para 'suspended', não para 'trial'.
 *   - 'suspended' preserva todos os dados; quando pagar volta para 'premium'.
 *
 * Nota: Esta rota escreve directamente no Firestore e invalida o cache.
 * Em produção, deve ser protegida por autenticação de admin.
 */
app.post('/plans/:uid/plan', requireUid, async (req, res) => {
  const { uid } = req;
  const { plan } = req.body || {};

  // 'trial' não pode ser atribuído manualmente — é apenas o estado inicial de criação
  const ALLOWED_VIA_ROUTE = [plans.PLANS.PRO, plans.PLANS.PREMIUM, plans.PLANS.EXPIRED, plans.PLANS.SUSPENDED];

  if (!ALLOWED_VIA_ROUTE.includes(plan)) {
    return res.status(400).json({
      ok: false,
      error: `Plano inválido: "${plan}". Valores aceites via esta rota: ${ALLOWED_VIA_ROUTE.join(', ')}. O plano "trial" é atribuído apenas na criação da conta.`,
    });
  }

  if (!db) return res.status(503).json({ ok: false, error: 'Firestore não configurado.' });

  try {
    await db
      .collection('workspaces')
      .doc(uid)
      .collection('settings')
      .doc('subscription')
      .set({ plan, updatedAt: new Date() }, { merge: true });

    // Invalidar cache para forçar releitura imediata
    plans.invalidatePlanCache(uid);

    console.info(`[POST /plans/:uid/plan] uid: ${uid} → plano definido: ${plan}`);
    res.json({ ok: true, plan });
  } catch (e) {
    console.error('[POST /plans/:uid/plan] Erro:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /plans/:uid/invalidate-cache
 * Invalida o cache local do plano para uma conta.
 * Útil após upgrade/downgrade processado por um sistema externo
 * (ex.: webhook de pagamento) que já escreveu no Firestore.
 * Body: { uid: string }
 * Resposta: { ok: true }
 */
app.post('/plans/:uid/invalidate-cache', requireUid, (req, res) => {
  const { uid } = req;
  plans.invalidatePlanCache(uid);
  res.json({ ok: true });
});

// ── Créditos IA ───────────────────────────────────────────────────────
/**
 * GET /accounts/:uid/credits/status
 * Devolve o estado actual dos créditos IA da conta para o painel frontend.
 * 
 * ✅ CONTRATO ÚNICO: Usa creditManager.getUsageSummary() — mesma fonte que Analytics.
 * Garante que IA e Analytics mostram sempre exatamente os mesmos números.
 *
 * Resposta:
 *   {
 *     ok: true,
 *     
 *     — Limites mensais e diários da config global
 *     monthly_limit: number,
 *     monthly_used: number,
 *     monthly_remaining: number,
 *     monthly_percent: number,          — 0-100
 *     daily_limit: number,
 *     daily_used: number,
 *     daily_remaining: number,
 *     daily_percent: number,            — 0-100
 *     
 *     — Breakdown: Plano vs Extras (para mostrar separadamente no UI)
 *     plan_limit: number,               — limite do plano (mensal)
 *     plan_used: number,                — consumidos do plano
 *     plan_remaining: number,           — disponível no plano
 *     extra_limit: number,              — créditos extras comprados
 *     extra_used: number,               — consumidos dos extras
 *     extra_remaining: number,          — disponível nos extras
 *     
 *     — Metadados
 *     estimated_cost_usd: number,
 *     warning_level: 'none' | 'warning' | 'blocked',
 *     last_monthly_reset: number|null,  — timestamp ms
 *     last_daily_reset: string|null,    — 'YYYY-MM-DD'
 *   }
 *
 * Consumo: Plano é consumido PRIMEIRO, depois extras.
 * Reset: Plano reseta mensalmente. Extras NUNCA expiram.
 * 
 * warning_level:
 *   'none'    — abaixo de 90% do limite mensal
 *   'warning' — entre 90% e 99% (mostrar aviso no painel)
 *   'blocked' — 100% ou mais (IA desactivada até reset mensal)
 */
app.get('/accounts/:uid/credits/status', requireUid, async (req, res) => {
  const { uid } = req;
  try {
    const summary = await credits.getUsageSummary(uid);
    // Garantir que todos os campos obrigatórios existem (para compatibilidade frontend)
    res.json({ 
      ok: true, 
      ...summary,
      // Garantir que campos plan/extras sempre existem, mesmo que undefined
      plan_limit: summary.plan_limit || 0,
      plan_used: summary.plan_used || 0,
      plan_remaining: summary.plan_remaining || 0,
      extra_limit: summary.extra_limit || 0,
      extra_used: summary.extra_used || 0,
      extra_remaining: summary.extra_remaining || 0,
    });
  } catch (e) {
    console.error('[GET /accounts/:uid/credits/status] Erro:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
// FASE 5 — Rotas de administração de sessões de clientes
// ──────────────────────────────────────────────────────────────────────
// Todas as rotas exigem :uid válido (requireUid).
// Nenhuma destas acções afecta fluxos, créditos, planos ou sessões de
// outros clientes.
// ══════════════════════════════════════════════════════════════════════

/**
 * DELETE /admin/sessions/:uid/:phoneNumber
 * Apaga a sessão completa do cliente (incluindo histórico de mensagens).
 * Na próxima mensagem, o cliente começa do zero e o fluxo reinicia do início.
 */
app.delete('/admin/sessions/:uid/:phoneNumber', requireUid, async (req, res) => {
  const { uid, phoneNumber } = req.params;
  try {
    await sessions.resetSession(uid, phoneNumber);
    console.info(`[Admin] Sessão resetada — uid: ${uid} | phone: ${phoneNumber}`);
    res.json({ ok: true, message: 'Sessão apagada. O cliente começa do zero na próxima mensagem.' });
  } catch (e) {
    console.error(`[Admin][DELETE /admin/sessions] Erro: ${e.message}`);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * DELETE /admin/sessions/:uid/:phoneNumber/messages
 * Apaga apenas o histórico de mensagens da sessão.
 * A sessão em si continua intacta (current_node_id, state, variables preservados).
 */
app.delete('/admin/sessions/:uid/:phoneNumber/messages', requireUid, async (req, res) => {
  const { uid, phoneNumber } = req.params;
  try {
    await sessions.clearMessageHistory(uid, phoneNumber);
    console.info(`[Admin] Histórico apagado — uid: ${uid} | phone: ${phoneNumber}`);
    res.json({ ok: true, message: 'Histórico de mensagens apagado. A sessão continua activa.' });
  } catch (e) {
    console.error(`[Admin][DELETE /admin/sessions/messages] Erro: ${e.message}`);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /admin/sessions/:uid/:phoneNumber/block-ai
 * Bloqueia a IA para este cliente específico (ai_blocked: true).
 * Os fluxos continuam a funcionar normalmente.
 */
app.post('/admin/sessions/:uid/:phoneNumber/block-ai', requireUid, async (req, res) => {
  const { uid, phoneNumber } = req.params;
  try {
    await sessions.blockAi(uid, phoneNumber);
    console.info(`[Admin] IA bloqueada — uid: ${uid} | phone: ${phoneNumber}`);
    res.json({ ok: true, message: 'IA bloqueada para este cliente.' });
  } catch (e) {
    console.error(`[Admin][POST /admin/sessions/block-ai] Erro: ${e.message}`);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /admin/sessions/:uid/:phoneNumber/unblock-ai
 * Desbloqueia a IA para este cliente (ai_blocked: false).
 */
app.post('/admin/sessions/:uid/:phoneNumber/unblock-ai', requireUid, async (req, res) => {
  const { uid, phoneNumber } = req.params;
  try {
    await sessions.unblockAi(uid, phoneNumber);
    console.info(`[Admin] IA desbloqueada — uid: ${uid} | phone: ${phoneNumber}`);
    res.json({ ok: true, message: 'IA desbloqueada para este cliente.' });
  } catch (e) {
    console.error(`[Admin][POST /admin/sessions/unblock-ai] Erro: ${e.message}`);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /admin/sessions/:uid/:phoneNumber/export
 * Exporta todas as mensagens da conversa em formato JSON.
 * Resposta: { ok, phone_number, account_id, exported_at, messages: [...] }
 */
app.get('/admin/sessions/:uid/:phoneNumber/export', requireUid, async (req, res) => {
  const { uid, phoneNumber } = req.params;
  try {
    const data = await sessions.exportConversation(uid, phoneNumber);
    console.info(`[Admin] Conversa exportada — uid: ${uid} | phone: ${phoneNumber} | msgs: ${data.messages.length}`);
    res.json({ ok: true, ...data });
  } catch (e) {
    console.error(`[Admin][GET /admin/sessions/export] Erro: ${e.message}`);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
// Rotas de relatório de uso da IA
// ──────────────────────────────────────────────────────────────────────
// GET /accounts/:uid/ai-usage/logs       → logs paginados
// GET /accounts/:uid/ai-usage/by-client  → consumo por número
// GET /accounts/:uid/ai-usage/totals     → totais da conta
// ══════════════════════════════════════════════════════════════════════

app.get('/accounts/:uid/ai-usage/logs', requireUid, async (req, res) => {
  const { uid } = req;
  if (!db) return res.status(503).json({ ok: false, error: 'Firestore não configurado.' });
  try {
    const result = await credits.getUsageLogs(uid, {
      limit:        req.query.limit,
      startAfterTs: req.query.startAfterTs,
      phoneNumber:  req.query.phoneNumber,
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[GET /accounts/:uid/ai-usage/logs] Erro:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/accounts/:uid/ai-usage/by-client', requireUid, async (req, res) => {
  const { uid } = req;
  if (!db) return res.status(503).json({ ok: false, error: 'Firestore não configurado.' });
  try {
    const clients = await credits.getUsageSummaryByClient(uid);
    res.json({ ok: true, clients });
  } catch (e) {
    console.error('[GET /accounts/:uid/ai-usage/by-client] Erro:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/accounts/:uid/ai-usage/totals', requireUid, async (req, res) => {
  const { uid } = req;
  if (!db) return res.status(503).json({ ok: false, error: 'Firestore não configurado.' });
  try {
    const totals = await credits.getUsageTotals(uid);
    res.json({ ok: true, ...totals });
  } catch (e) {
    console.error('[GET /accounts/:uid/ai-usage/totals] Erro:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
// Rotas da página Analytics
// ──────────────────────────────────────────────────────────────────────
// GET  /accounts/:uid/analytics?range=today|7d|30d|90d
//      → visão geral, evolução diária, performance de fluxos,
//        horários de actividade e clientes — tudo calculado no servidor.
//
// GET  /accounts/:uid/analytics/credits
//      → estado dos créditos IA (limite, usados, restantes, percentagem)
//        combinado com estimativas de consumo (médias, dias restantes).
//
// GET  /accounts/:uid/analytics/export?range=...&format=csv
//      → exporta o relatório completo em CSV (abre nativamente no Excel).
// ══════════════════════════════════════════════════════════════════════

const VALID_RANGES = ['today', '7d', '30d', '90d'];

app.get('/accounts/:uid/analytics', requireUid, async (req, res) => {
  const { uid } = req;
  if (!db) return res.status(503).json({ ok: false, error: 'Firestore não configurado.' });

  const range = VALID_RANGES.includes(req.query.range) ? req.query.range : '7d';

  try {
    const data = await analyticsService.getAnalytics(uid, range);
    res.json({ ok: true, ...data });
  } catch (e) {
    console.error('[GET /accounts/:uid/analytics] Erro:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /accounts/:uid/analytics/credits
 * 
 * ✅ CONTRATO ÚNICO: Usa creditManager.getUsageSummary() — MESMA FONTE que credits/status.
 * Adiciona estimativas de consumo baseadas no uso real dos últimos 7 dias.
 * 
 * IMPORTANTE: Se houver divergência entre /credits/status e /analytics/credits,
 * é um BUG — ambas devem retornar EXATAMENTE os mesmos campos de estado de créditos.
 * As únicas diferenças são as estimativas (avg_credits_per_conversation, etc.).
 * 
 * Resposta: { ...summary, ...estimate }
 *   — summary: idem a /credits/status
 *   — estimate: { avg_credits_per_conversation, avg_daily_usage, estimated_days_remaining }
 */
app.get('/accounts/:uid/analytics/credits', requireUid, async (req, res) => {
  const { uid } = req;
  if (!db) return res.status(503).json({ ok: false, error: 'Firestore não configurado.' });

  try {
    const summary = await credits.getUsageSummary(uid);

    // Usar a janela de 7 dias para calcular médias de consumo reais
    const recent = await analyticsService.getAnalytics(uid, '7d');
    const estimate = await credits.getCreditsEstimate(
      uid,
      recent.ai_usage_in_range.conversations_with_ai,
      recent.ai_usage_in_range.avg_daily_usage
    );

    // Garantir que todos os campos obrigatórios existem (para compatibilidade frontend)
    res.json({ 
      ok: true, 
      ...summary,
      ...estimate,
      // Garantir que campos plan/extras sempre existem
      plan_limit: summary.plan_limit || 0,
      plan_used: summary.plan_used || 0,
      plan_remaining: summary.plan_remaining || 0,
      extra_limit: summary.extra_limit || 0,
      extra_used: summary.extra_used || 0,
      extra_remaining: summary.extra_remaining || 0,
    });
  } catch (e) {
    console.error('[GET /accounts/:uid/analytics/credits] Erro:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /accounts/:uid/analytics/export?range=7d&format=csv
 * Devolve um ficheiro CSV para download (Content-Disposition: attachment).
 * O CSV abre nativamente em Excel/Google Sheets — cobre os formatos
 * "CSV" e "Excel" pedidos sem dependências adicionais no servidor.
 */
app.get('/accounts/:uid/analytics/export', requireUid, async (req, res) => {
  const { uid } = req;
  if (!db) return res.status(503).json({ ok: false, error: 'Firestore não configurado.' });

  const range  = VALID_RANGES.includes(req.query.range) ? req.query.range : '7d';
  const format = req.query.format || 'csv';

  if (format !== 'csv' && format !== 'excel') {
    return res.status(400).json({ ok: false, error: 'Formato não suportado. Use csv ou excel.' });
  }

  try {
    const data = await analyticsService.getAnalytics(uid, range);
    const csv  = exportService.buildAnalyticsCsv(data);

    const filename = `korvex-analytics-${range}-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (e) {
    console.error('[GET /accounts/:uid/analytics/export] Erro:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});


// ── Health check ─────────────────────────────────────────────────────
// Estado do pool de workers — número de workers, sessões activas, PIDs
app.get('/health/workers', (_, res) => {
  res.json({ ok: true, ...workerPool.getPoolStatus() });
});

// Rota de saúde detalhada — para monitorização externa (Uptime Robot, etc.)
app.get('/health/memory', (_, res) => {
  const mem = memoryGuard.getStatus();
  res.status(mem.ok ? 200 : 503).json({
    ok:      mem.ok,
    service: 'korvex-server',
    memory:  mem,
  });
});

app.get('/health', (_, res) => {
  res.json({ ok: true, service: 'korvex-server', version: '5.0.0' });
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
const _server = app.listen(PORT, () => {
  console.info(`\n╔══════════════════════════════════════╗`);
  console.info(`║  Korvex Server — FASE 5.0            ║`);
  console.info(`║  Porta: ${PORT}                          ║`);
  console.info(`║  Firebase: ${admin ? 'OK ✓' : 'NÃO CONFIGURADO ✗'}              ║`);
  console.info(`╚══════════════════════════════════════╝\n`);
  memoryGuard.start();

  // CAMADA 1.2 — Recovery Engine (background, não bloqueia)
  if (db && admin) {
    try {
      const { RecoveryEngine, RecoveryQueue, TaskExecutor, RecoveryRepository } = require('./whatsapp/recovery');
      const CircuitBreaker = require('./whatsapp/recovery/circuitBreaker');
      
      const recoveryQueue = new RecoveryQueue();
      const recoveryRepository = new RecoveryRepository(db);
      const taskExecutorCB = new CircuitBreaker('taskExecutor', { failureThreshold: 2, resetTimeout: 20000 });
      const taskExecutor = new TaskExecutor(manager, sessions, taskExecutorCB);
      
      const recoveryEngine = new RecoveryEngine({
        manager: manager,
        sessionsModule: sessions,
        firebaseDb: db,
        queue: recoveryQueue,
        taskExecutor: taskExecutor,
        repository: recoveryRepository,
      });
      
      global.recoveryEngine = recoveryEngine;
      recoveryEngine.start();
      console.info('[Recovery] Engine iniciado em background');
    } catch (e) {
      console.error('[Recovery] Erro ao iniciar engine:', e.message);
    }
  }
});

// Graceful shutdown ao SIGTERM (deploy, restart, Ctrl+C)
process.on('SIGTERM', () => {
  console.info('[Server] SIGTERM — a encerrar workers e servidor…');
  workerPool.shutdown();
  _server.close(() => { console.info('[Server] Encerrado.'); process.exit(0); });
});
process.on('SIGINT', () => {
  console.info('[Server] SIGINT — a encerrar…');
  workerPool.shutdown();
  _server.close(() => process.exit(0));
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
