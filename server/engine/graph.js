/* ══════════════════════════════════════════════════════════════════════
   FASE 3.2.8 — engine/graph.js
   ────────────────────────────────────────────────────────────────────
   Motor de navegação do grafo de um fluxo.

   Port em Node.js (sem dependência do browser) da mesma lógica já usada
   em js/flow-builder.js (WorkflowEngine._buildGraph / getStartNodes /
   getNextNodes), mas operando directamente sobre o formato canónico tal
   como está guardado no Firestore:

     doc.nodes:       [{ nodeId, type, name, settings, position, ... }]
     doc.connections: [{ connectionId, sourceNodeId, targetNodeId, sourcePort }]

   (No frontend, em memória, os mesmos campos existem com nomes curtos:
    id/t/data e id/fr/to/fp — mas o documento persistido no Firestore já
    usa os nomes longos acima, ver js/storage.js → FlowSerializer.)

   Esta camada não sabe nada sobre WhatsApp nem Firestore — recebe um
   { nodes, connections } já carregado e devolve informação de grafo.
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Constrói uma representação de grafo a partir do documento de fluxo.
 * @param {{nodes: object[], connections: object[]}} flow
 * @returns {{
 *   nodeById: Map<string, object>,
 *   outEdges: Map<string, object[]>,
 *   inEdges:  Map<string, object[]>,
 * }}
 */
function buildGraph(flow) {
  const nodes = flow?.nodes       || [];
  const conns = flow?.connections || [];

  const nodeById = new Map(nodes.map(n => [String(n.nodeId), n]));
  const outEdges = new Map(nodes.map(n => [String(n.nodeId), []]));
  const inEdges  = new Map(nodes.map(n => [String(n.nodeId), []]));

  conns.forEach(c => {
    const from = String(c.sourceNodeId);
    const to   = String(c.targetNodeId);
    if (outEdges.has(from)) outEdges.get(from).push(c);
    if (inEdges.has(to))    inEdges.get(to).push(c);
  });

  return { nodeById, outEdges, inEdges };
}

/**
 * Devolve o(s) nó(s) de entrada do fluxo — sem ligações de entrada.
 * Tipicamente apenas um nó do tipo 'inicio', mas devolve todos os
 * candidatos para o caller decidir (ex.: preferir type === 'inicio').
 * @param {object} flow
 * @returns {object[]}
 */
function getStartNodes(flow) {
  const { nodeById, inEdges } = buildGraph(flow);
  const result = [];
  for (const [id, node] of nodeById) {
    if ((inEdges.get(id) || []).length === 0) result.push(node);
  }
  return result;
}

/**
 * Encontra explicitamente o nó tipo 'inicio' do fluxo (gatilho).
 * Cai para getStartNodes() se não houver nenhum nó desse tipo marcado
 * (robustez — não deve acontecer em fluxos validados pelo Flow Builder).
 *
 * FASE 5.2 — Se existir mais de um nó 'inicio', escolhe o que possui
 * conexões de saída. Um nó inicio sem saídas é inoperacional; o que
 * tem saídas é sempre a escolha correcta. Adiciona log temporário para
 * confirmar qual nó início foi seleccionado.
 * @param {object} flow
 * @returns {object|null}
 */
function findTriggerNode(flow) {
  const nodes = flow?.nodes || [];
  const triggers = nodes.filter(n => n.type === 'inicio');

  let trigger = null;
  if (triggers.length > 1) {
    // FASE 5.2 — Dois ou mais nós 'inicio': preferir o que tem saídas.
    const { outEdges } = buildGraph(flow);
    trigger = triggers.find(n => (outEdges.get(String(n.nodeId)) || []).length > 0)
           || triggers[0]; // fallback: primeiro, se nenhum tiver saídas
  } else {
    trigger = triggers[0] || null;
  }

  if (trigger) return trigger;
  const starts = getStartNodes(flow);
  return starts[0] || null;
}

/**
 * Devolve o próximo nó a executar a partir de um nodeId, seguindo uma
 * porta de saída específica (sourcePort). Se não houver portName
 * (nós de saída única, ex.: Mensagem), segue a primeira/única aresta.
 *
 * @param {string} nodeId
 * @param {object} flow
 * @param {string} [portName]  Nome da porta de saída a seguir (ex.: 'Sim',
 *   'Não', 'Btn 1'). Se omitido, usa a primeira aresta disponível.
 * @returns {object|null}  O nó seguinte, ou null se for um nó terminal.
 */
function getNextNode(nodeId, flow, portName) {
  const { nodeById, outEdges } = buildGraph(flow);
  const edges = outEdges.get(String(nodeId)) || [];

  if (!edges.length) return null;

  let edge;
  if (portName) {
    edge = edges.find(e => (e.sourcePort || 'out') === portName);
  }
  // Fallback: primeira aresta (cobre nós de saída única como Mensagem/Pergunta)
  if (!edge) edge = edges[0];

  return nodeById.get(String(edge.targetNodeId)) || null;
}

module.exports = { buildGraph, getStartNodes, findTriggerNode, getNextNode };
