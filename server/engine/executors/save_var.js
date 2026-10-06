/* engine/executors/save_var.js
   Executor do nó SALVAR RESPOSTA.

   Comportamento em 2 fases:
   ─────────────────────────
   FASE A — primeira vez que o motor chega a este nó (ainda sem resposta):
     → Grava awaitingInput = nodeId na conversa e devolve { awaitingInput: true }.
     → O motor para aqui. O fluxo fica suspenso até o utilizador responder.

   FASE B — utilizador envia mensagem enquanto awaitingInput == este nodeId:
     → O workflowEngine já captura essa mensagem, guarda a variável e avança.
     → Este executor NÃO é chamado novamente para a fase B; o motor trata disso
       directamente em handleIncoming (bloco "awaitingInput" do engine).

   Integração com workflowEngine:
     O motor já sabe tratar nós do tipo 'pergunta' e 'aguardar' quando
     conv.awaitingInput está definido. Para 'salvar' funcionar da mesma forma,
     o motor precisa de reconhecê-lo no bloco awaitingInput — ver workflowEngine.js.
*/

const logger        = require('../logger');
const conversations = require('../conversations');

async function execute(ctx) {
  const { uid, phone, node } = ctx;

  logger.info(uid, phone, `[SALVAR] Nó ${node.nodeId} — a aguardar resposta do utilizador...`);

  // Gravar que estamos à espera de resposta neste nó
  await conversations.setAwaitingInput(uid, phone, String(node.nodeId));

  return { awaitingInput: true };
}

module.exports = { execute };
