/* ══════════════════════════════════════════════════════════════════════
   scripts/cleanGhostUsers.js — Remove utilizadores fantasma do Firestore
   ────────────────────────────────────────────────────────────────────
   Executa UMA VEZ para remover documentos em admin_users com:
     - uid === undefined / null / ""
     - email === undefined / null / ""

   Uso:
     cd server
     node scripts/cleanGhostUsers.js

   Requer: FIREBASE_SERVICE_ACCOUNT_PATH ou variáveis de ambiente Firebase
   ══════════════════════════════════════════════════════════════════════ */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const admin = require('firebase-admin');
const path  = require('path');
const fs    = require('fs');

async function main() {
  // Inicializar Firebase
  const saPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH
    || path.join(__dirname, '..', 'serviceAccountKey.json');

  if (fs.existsSync(saPath)) {
    admin.initializeApp({ credential: admin.credential.cert(require(saPath)) });
  } else if (process.env.FIREBASE_PROJECT_ID) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      }),
    });
  } else {
    console.error('Firebase não configurado. Configure FIREBASE_SERVICE_ACCOUNT_PATH ou variáveis de ambiente.');
    process.exit(1);
  }

  const db = admin.firestore();
  console.log('A procurar utilizadores fantasma em admin_users…\n');

  let deleted   = 0;
  let kept      = 0;
  let lastDoc   = null;

  while (true) {
    let q = db.collection('admin_users').limit(300);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    if (snap.empty) break;

    const batch = db.batch();
    let batchHas = false;

    for (const doc of snap.docs) {
      const d = doc.data();
      const isGhost = (
        !d.uid   || d.uid   === 'undefined' || typeof d.uid   !== 'string' ||
        !d.email || d.email === 'undefined' || typeof d.email !== 'string'
      );

      if (isGhost) {
        console.log(`  🗑  Fantasma encontrado — doc ID: ${doc.id} | uid: ${d.uid} | email: ${d.email}`);
        batch.delete(doc.ref);
        deleted++;
        batchHas = true;
      } else {
        kept++;
      }
    }

    if (batchHas) await batch.commit();
    if (snap.size < 300) break;
    lastDoc = snap.docs[snap.docs.length - 1];
  }

  console.log(`\n✅ Limpeza concluída.`);
  console.log(`   Removidos: ${deleted} utilizadores fantasma`);
  console.log(`   Mantidos:  ${kept} utilizadores válidos`);
  process.exit(0);
}

main().catch(e => {
  console.error('Erro:', e.message);
  process.exit(1);
});
