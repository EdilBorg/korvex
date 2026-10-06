/* ══════════════════════════════════════════════════════════════════════
   scripts/setAdminPlan.js — Corrigir conta administrador no Firestore
   ────────────────────────────────────────────────────────────────────
   Garante que a conta admin tem plan:'admin', sem expiresAt, e com
   acesso total a todas as funcionalidades premium.

   Uso:
     node server/scripts/setAdminPlan.js

   Requer: FIREBASE_SERVICE_ACCOUNT_PATH no .env (ou variáveis individuais)
   ══════════════════════════════════════════════════════════════════════ */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const admin = require('firebase-admin');

// UID e email da conta administrador (sincronizado com subscription.js e admin.js)
const ADMIN_UID   = 'R4Oy03GeNKbk5ucpYdNAFQoXB6p2';
const ADMIN_EMAIL = 'korvexsuporte@gmail.com';

async function run() {
  // Inicializar Firebase Admin
  if (!admin.apps.length) {
    // BUGFIX: igual ao seedAiSettings.js — verificar primeiro o ficheiro
    // padrão server/serviceAccountKey.json antes de cair nas variáveis de
    // ambiente individuais (quase sempre vazias quando se usa o ficheiro).
    const path = require('path');
    const fs   = require('fs');

    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH
      || path.join(__dirname, '..', 'serviceAccountKey.json');

    if (fs.existsSync(serviceAccountPath)) {
      admin.initializeApp({
        credential: admin.credential.cert(require(path.resolve(serviceAccountPath))),
      });
    } else if (process.env.FIREBASE_PROJECT_ID) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId:   process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
        }),
      });
    } else {
      throw new Error(
        'Firebase Admin não configurado — coloque server/serviceAccountKey.json ' +
        'ou defina FIREBASE_SERVICE_ACCOUNT_PATH / FIREBASE_PROJECT_ID no .env.'
      );
    }
  }

  const db = admin.firestore();

  const subscriptionRef = db
    .collection('workspaces')
    .doc(ADMIN_UID)
    .collection('settings')
    .doc('subscription');

  // Ler estado actual
  const snap = await subscriptionRef.get();
  const before = snap.exists ? snap.data() : null;
  console.log('\n[Antes]', before || '(documento não existe)');

  // Definir plano admin — sem expiresAt, acesso permanente
  await subscriptionRef.set({
    plan:      'admin',
    email:     ADMIN_EMAIL,
    updatedAt: Date.now(),
    // Remover expiresAt explicitamente para não causar expiração
    expiresAt: admin.firestore.FieldValue.delete(),
  }, { merge: true });

  // Verificar resultado
  const after = (await subscriptionRef.get()).data();
  console.log('[Depois]', after);
  console.log('\n✅ Conta admin corrigida com sucesso.');
  console.log(`   UID:   ${ADMIN_UID}`);
  console.log(`   Email: ${ADMIN_EMAIL}`);
  console.log(`   Plano: admin (sem expiração)\n`);

  process.exit(0);
}

run().catch(e => {
  console.error('❌ Erro:', e.message);
  process.exit(1);
});
