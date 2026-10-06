/* ══════════════════════════════════════════════════════════════════════
   whatsapp/authStore.js — Adaptador de autenticação Baileys → Firestore
   ────────────────────────────────────────────────────────────────────
   Substitui useMultiFileAuthState (disco local) por armazenamento de
   credenciais no Firestore.

   PORQUÊ:
   - useMultiFileAuthState guarda em auth/{uid}/ no disco do servidor
   - Ao reiniciar o servidor, todas as sessões perdem autenticação
   - Em múltiplas instâncias (horizontal scaling), cada instância tem
     o seu próprio disco — sessões não partilhadas entre instâncias
   - Com 500 utilizadores × 2 slots = 1000 pastas em disco

   COMO FUNCIONA:
   - Credenciais (creds) guardadas em Firestore:
       whatsapp_auth/{sessionId}/meta/creds   → JSON das credenciais
   - Chaves de sinal (keys) guardadas em Firestore:
       whatsapp_auth/{sessionId}/keys/{type}_{id}  → JSON da chave
   - saveCreds() chamado pelo Baileys quando as credenciais mudam
   - Baileys lê creds e keys via get() antes de criar o socket

   NOTA SOBRE ESCALA:
   - Para +1000 sessões simultâneas, migrar keys para Redis
     (Firestore tem limite de 1 escrita/segundo por documento)
   - creds mudam raramente (apenas no registo) — Firestore é OK
   - keys mudam frequentemente (a cada mensagem) — Redis recomendado

   USO:
     const { useFirestoreAuthState } = require('./authStore');
     const { state, saveCreds, clearAuth } = await useFirestoreAuthState(db, sessionId);
   ══════════════════════════════════════════════════════════════════════ */

const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

// ── Função utilitária: withTimeout ──────────────────────────────────
// Envolve uma Promise com um timeout. Se a Promise não completar dentro
// de `ms` milissegundos, lança erro de timeout.
//
// CARACTERÍSTICAS:
// - Se Promise resolve: devolve exatamente o resultado
// - Se Promise rejeita: propaga exatamente o erro original
// - Se timeout expira: lança erro de timeout
// - Sempre cancela o setTimeout para evitar memory leak
//
// Uso:
//   await withTimeout(firestore.ref.set(data), 10000, 'Firestore write');
function withTimeout(promise, ms, operationName = 'Operation') {
  let timeoutHandle;

  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        console.error(`[Timeout] ${operationName} após ${ms}ms`);
        reject(new Error(`${operationName} timeout após ${ms}ms`));
      }, ms);
    })
  ]).finally(() => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  });
}

/**
 * Cria um estado de autenticação Baileys persistido no Firestore.
 * API compatível com useMultiFileAuthState do Baileys.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} sessionId  — ex: "uid123_whatsapp_1"
 * @returns {Promise<{ state, saveCreds, clearAuth }>}
 */
async function useFirestoreAuthState(db, sessionId) {
  if (!db) throw new Error('[AuthStore] Firestore não inicializado.');

  const metaRef = db.collection('whatsapp_auth').doc(sessionId)
                    .collection('meta').doc('creds');
  const keysCol = db.collection('whatsapp_auth').doc(sessionId)
                    .collection('keys');

  // ── Carregar credenciais ────────────────────────────────────────────
  let creds;
  try {
    const snap = await withTimeout(metaRef.get(), 15000, 'metaRef.get()');
    creds = snap.exists
      ? JSON.parse(snap.data().json, BufferJSON.reviver)
      : initAuthCreds();
  } catch (e) {
    console.warn(`[AuthStore] Erro ao carregar creds para ${sessionId}:`, e.message);
    creds = initAuthCreds();
  }

  // ── Adaptador de chaves de sinal ────────────────────────────────────
  const keys = {
    /**
     * Ler chaves do Firestore.
     * O Baileys lê chaves em lote antes de processar mensagens.
     */
    get: async (type, ids) => {
      const data = {};
      await Promise.all(ids.map(async (id) => {
        try {
          const snap = await withTimeout(keysCol.doc(`${type}_${id}`).get(), 10000, `keysCol.doc.get(${type}_${id})`);
          if (snap.exists) {
            data[id] = JSON.parse(snap.data().json, BufferJSON.reviver);
          }
        } catch (e) {
          console.warn(`[AuthStore] Erro ao ler chave ${type}/${id}:`, e.message);
        }
      }));
      return data;
    },

    /**
     * Guardar chaves no Firestore.
     * Chamado pelo Baileys após processar cada mensagem (pre-key, session, etc.)
     * Usa batch para minimizar round-trips ao Firestore.
     */
    set: async (data) => {
      // Agrupar em batches de 500 (limite do Firestore)
      const entries = [];
      for (const [type, ids] of Object.entries(data)) {
        for (const [id, value] of Object.entries(ids || {})) {
          entries.push({ type, id, value });
        }
      }

      // Processar em lotes de 400 (margem de segurança abaixo do limite)
      for (let i = 0; i < entries.length; i += 400) {
        const batch = db.batch();
        const slice = entries.slice(i, i + 400);

        for (const { type, id, value } of slice) {
          const ref = keysCol.doc(`${type}_${id}`);
          if (value != null) {
            batch.set(ref, { json: JSON.stringify(value, BufferJSON.replacer) });
          } else {
            batch.delete(ref);
          }
        }

        try {
          await withTimeout(batch.commit(), 10000, `keys.set batch.commit()`);
        } catch (e) {
          console.error(`[AuthStore] Erro ao guardar batch de chaves para ${sessionId}:`, e.message);
        }
      }
    },
  };

  // ── saveCreds: chamado pelo Baileys quando creds mudam ──────────────
  const saveCreds = async () => {
    try {
      await withTimeout(metaRef.set({ json: JSON.stringify(creds, BufferJSON.replacer) }), 10000, 'saveCreds metaRef.set()');
    } catch (e) {
      console.error(`[AuthStore] Erro ao guardar creds para ${sessionId}:`, e.message);
    }
  };

  // ── clearAuth: apagar todas as credenciais e chaves ─────────────────
  // Equivalente a rmSync(authDir) — usado no logout ou reconexão forçada
  const clearAuth = async () => {
    try {
      // Apagar creds
      await withTimeout(metaRef.delete(), 10000, 'clearAuth metaRef.delete()');

      // Apagar todas as chaves em lotes
      let lastDoc = null;
      while (true) {
        let q = keysCol.limit(400);
        if (lastDoc) q = q.startAfter(lastDoc);
        const snap = await withTimeout(q.get(), 10000, 'clearAuth keysCol.get()');
        if (snap.empty) break;

        const batch = db.batch();
        snap.docs.forEach(d => batch.delete(d.ref));
        await withTimeout(batch.commit(), 10000, 'clearAuth batch.commit()');

        if (snap.size < 400) break;
        lastDoc = snap.docs[snap.docs.length - 1];
      }
    } catch (e) {
      console.error(`[AuthStore] Erro ao limpar auth para ${sessionId}:`, e.message);
    }
  };

  return {
    state: { creds, keys },
    saveCreds,
    clearAuth,
  };
}

module.exports = { useFirestoreAuthState };
