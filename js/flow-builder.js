function initCanvas() {
  const wrap = document.getElementById('fb-wrap');

  // ══════════════════════════════════════════════════════════════════
  // FASE 3.1.4 — comportamento de clique no fundo vazio do canvas:
  //   • Clique normal (sem Shift) + arrastar → MOVER o canvas (pan),
  //     tal como Miro/Figma. É o comportamento mais intuitivo e o que
  //     o utilizador esperava por padrão.
  //   • Shift + clique + arrastar           → selecção rectangular de
  //     múltiplos nós (passou para Shift, já que o clique simples agora
  //     move o canvas).
  //   • Alt+clique ou botão do meio          → continuam também a fazer
  //     pan, por compatibilidade com quem já tinha esse hábito.
  // ══════════════════════════════════════════════════════════════════
  wrap.addEventListener('mousedown', e => {
    if (e.target.closest('.fb-node') || e.target.closest('.fb-port') || e.target.closest('.minimap')) return;
    if (e.button === 2) { closeCtx(); return; }
    if (e.button === 1) { startPan(e); return; }
    if (e.button === 0 && e.altKey) { startPan(e); return; }
    if (e.button === 0 && !e.shiftKey) { startPan(e); return; }

    closeCtx();
    // Chegou aqui apenas com Shift+clique → selecção rectangular
    sel.clear(); updateSel();

    const wr = wrap.getBoundingClientRect();
    const sx = (e.clientX - wr.left - panX) / zoom;
    const sy = (e.clientY - wr.top  - panY) / zoom;

    const box = document.getElementById('sel-box');
    let bx0 = sx, by0 = sy;

    const onMove = ev => {
      const cx = (ev.clientX - wr.left - panX) / zoom;
      const cy = (ev.clientY - wr.top  - panY) / zoom;
      const lx = Math.min(bx0, cx) * zoom + panX;
      const ly = Math.min(by0, cy) * zoom + panY;
      const lw = Math.abs(cx - bx0) * zoom;
      const lh = Math.abs(cy - by0) * zoom;
      box.style.cssText = `display:block;left:${lx}px;top:${ly}px;width:${lw}px;height:${lh}px`;
    };
    const onUp = ev => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      box.style.display = 'none';
      const cx = (ev.clientX - wr.left - panX) / zoom;
      const cy = (ev.clientY - wr.top  - panY) / zoom;
      const minX = Math.min(bx0,cx), maxX = Math.max(bx0,cx);
      const minY = Math.min(by0,cy), maxY = Math.max(by0,cy);
      if (Math.abs(maxX-minX) > 4 || Math.abs(maxY-minY) > 4) {
        nodes.forEach(n => {
          if (n.x >= minX && n.x <= maxX && n.y >= minY && n.y <= maxY) sel.add(n.id);
        });
        updateSel();
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  wrap.addEventListener('contextmenu', e => {
    e.preventDefault();
    const node = e.target.closest('.fb-node');
    if (node) {
      const nid = parseInt(node.dataset.nid);
      if (!sel.has(nid)) { sel.clear(); sel.add(nid); updateSel(); }
      showCtx(e, nid);
    } else {
      ctxClickPos = e;
      ctxNodeTarget = null;
      showCtxEmpty(e);
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // FASE 3.1.4 — BUGFIX: scroll/trackpad estava a fazer ZOOM na maior
  // parte das vezes (sempre que deltaX era pequeno, o que cobre quase
  // todo o scroll vertical normal de rato e muitos gestos de trackpad),
  // em vez de mover o canvas (pan). O utilizador esperava poder navegar
  // livremente com scroll/trackpad/arrastar sem o zoom mudar sozinho.
  //
  // Comportamento corrigido (convenção comum em Figma/Miro/Google Maps):
  //   • Scroll vertical normal (rato)        → pan vertical
  //   • Scroll horizontal / Shift+scroll     → pan horizontal
  //   • Gesto de 2 dedos no trackpad         → pan nas duas direcções
  //   • Ctrl/Cmd + scroll (rato OU trackpad) → zoom centrado no cursor
  // Zoom continua também disponível pelos botões +/- e atalhos de teclado.
  // ══════════════════════════════════════════════════════════════════
  wrap.addEventListener('wheel', e => {
    e.preventDefault();

    if (e.ctrlKey || e.metaKey) {
      // Único caso que faz zoom: Ctrl/Cmd + scroll (rato ou trackpad)
      const wr = wrap.getBoundingClientRect();
      const mx = e.clientX - wr.left, my = e.clientY - wr.top;
      const oldZ = zoom;
      zoom = Math.min(2.5, Math.max(0.15, zoom + (e.deltaY > 0 ? -0.08 : 0.08)));
      panX = mx - (mx - panX) * (zoom / oldZ);
      panY = my - (my - panY) * (zoom / oldZ);
      updateTransform();
      return;
    }

    if (e.shiftKey) {
      // Shift+wheel → forçar pan horizontal
      panX -= e.deltaY;
      panY -= e.deltaX;
      updateTransform();
      return;
    }

    // Pan normal — cobre scroll vertical de rato e gestos de trackpad
    // (verticais, horizontais, ou diagonais) sem qualquer modificador.
    panX -= e.deltaX;
    panY -= e.deltaY;
    updateTransform();
  }, {passive: false});
}

function startPan(e) {
  const wrap = document.getElementById('fb-wrap');
  wrap.classList.add('panning');
  const sx = e.clientX - panX, sy = e.clientY - panY;
  const onMove = ev => { panX = ev.clientX - sx; panY = ev.clientY - sy; updateTransform(); };
  const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); wrap.classList.remove('panning'); };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

let _transformRaf = null;
function updateTransform() {
  if (_transformRaf) return; // already scheduled — skip redundant call
  _transformRaf = requestAnimationFrame(() => {
    _transformRaf = null;
    const c = cvs(); if (!c) return;
    c.style.transform = `translate(${panX}px,${panY}px) scale(${zoom})`;
    document.getElementById('fb-zoom-val').textContent = Math.round(zoom * 100) + '%';
    const g = document.getElementById('fb-grid');
    if (g) {
      const sz = 24 * zoom;
      g.style.backgroundSize = `${sz}px ${sz}px`;
      g.style.backgroundPosition = `${((panX % sz) + sz) % sz}px ${((panY % sz) + sz) % sz}px`;
    }
    _schedMini();
  });
}

function fbZoom(d) {
  const wrap = document.getElementById('fb-wrap');
  const r = wrap.getBoundingClientRect();
  const cx = r.width / 2, cy = r.height / 2;
  const oldZ = zoom;
  zoom = Math.min(2.5, Math.max(0.15, zoom + d));
  panX = cx - (cx - panX) * (zoom / oldZ);
  panY = cy - (cy - panY) * (zoom / oldZ);
  updateTransform();
}

function fbFit() {
  if (!nodes.length) return;
  const wrap = document.getElementById('fb-wrap');
  const r = wrap.getBoundingClientRect();
  const minX = Math.min(...nodes.map(n => n.x));
  const minY = Math.min(...nodes.map(n => n.y));
  const maxX = Math.max(...nodes.map(n => n.x + 215));
  const maxY = Math.max(...nodes.map(n => n.y + 130));
  const scX = (r.width - 120) / (maxX - minX || 1);
  const scY = (r.height - 120) / (maxY - minY || 1);
  zoom = Math.min(scX, scY, 1.3);
  panX = (r.width  - (maxX - minX) * zoom) / 2 - minX * zoom;
  panY = (r.height - (maxY - minY) * zoom) / 2 - minY * zoom;
  updateTransform();
}

// ─── Auto layout ──────────────────────────────
function fbAutoLayout() {
  if (!nodes.length) return;
  const inDeg = {};
  nodes.forEach(n => inDeg[n.id] = 0);
  edges.forEach(e => inDeg[e.to] = (inDeg[e.to] || 0) + 1);
  const next = {};
  nodes.forEach(n => next[n.id] = []);
  edges.forEach(e => next[e.fr] && next[e.fr].push(e.to));

  const level = {};
  const roots = nodes.filter(n => !inDeg[n.id]).map(n => n.id);
  if (!roots.length) roots.push(nodes[0].id);
  const q = [...roots];
  roots.forEach(id => level[id] = 0);
  while (q.length) {
    const cur = q.shift();
    (next[cur] || []).forEach(nxt => {
      const lv = (level[cur] || 0) + 1;
      if (level[nxt] === undefined || lv > level[nxt]) { level[nxt] = lv; q.push(nxt); }
    });
  }
  nodes.forEach(n => { if (level[n.id] === undefined) level[n.id] = 0; });

  const byLev = {};
  nodes.forEach(n => { const l = level[n.id]; (byLev[l] = byLev[l] || []).push(n); });
  const COL = 290, ROW = 180;
  Object.entries(byLev).forEach(([lv, ns]) => {
    const total = ns.length;
    ns.forEach((n, i) => {
      n.x = 100 + i * COL - (total - 1) * COL / 2;
      n.y = 60 + parseInt(lv) * ROW;
    });
  });

  push(); render(); fbFit(); toast('Fluxo organizado', 'ok');
}

// ─── FASE 2.5 — Block Library Sidebar ──────────
// Substituição completa do block picker modal pelo painel lateral estilo BotPro.
// Interface limpa: apenas ícone + nome. Sem descrições. Sem categorias em grid.
// Animação de entrada lateral esquerda.

let pickerPos = null; // posição guardada para compatibilidade com context menu

// ── Abrir biblioteca ────────────────────────────
function openBlockLib(pos) {
  pickerPos = pos || null;
  const lib = document.getElementById('block-lib');
  const bd  = document.getElementById('block-lib-backdrop');
  const inp = document.getElementById('block-lib-q');
  lib.classList.add('open');
  if (bd) bd.classList.add('open');
  inp.value = '';
  setTimeout(() => { inp.focus(); renderBlockLib(''); }, 60);
}

// ── Alias para compatibilidade (context menu usa openPicker) ────────────
function openPicker(pos) { openBlockLib(pos); }

// ── Fechar biblioteca ───────────────────────────
function closeBlockLib() {
  document.getElementById('block-lib').classList.remove('open');
  const bd = document.getElementById('block-lib-backdrop');
  if (bd) bd.classList.remove('open');
}
function closePicker() { closeBlockLib(); }

// ── FASE 2.6 — Categorias profissionais da biblioteca ──────────────
// Mapeamento de tipos de bloco → categoria visual limpa.
// Ícones Tabler. Categorias alinhadas com imagem de referência.
const _LIB_CATS = [
  { key: 'inicio',        label: 'Início',              icon: 'ti-rocket',       types: ['inicio'],                                      color:'rgba(52,211,153,.15)',  colorBorder:'rgba(52,211,153,.3)',  colorIcon:'#34d399' },
  { key: 'conteudo',      label: 'Conteúdo',            icon: 'ti-message-2',    types: ['mensagem','imagem','video','audio','documento','delay'], color:'rgba(248,113,113,.15)', colorBorder:'rgba(248,113,113,.3)',  colorIcon:'#f87171' },
  { key: 'menu',          label: 'Menu',                icon: 'ti-layout-list',  types: ['botao','lista'],                               color:'rgba(0,200,240,.15)',  colorBorder:'rgba(0,200,240,.3)',  colorIcon:'#00c8f0' },
  { key: 'randomizador',  label: 'Randomizador',        icon: 'ti-arrows-shuffle', types: ['randomizador'],                              color:'rgba(251,191,36,.15)',  colorBorder:'rgba(251,191,36,.3)',  colorIcon:'#fbbf24' },
  { key: 'etiqueta',      label: 'Etiqueta',            icon: 'ti-bookmark',     types: ['tag','removertag'],                            color:'rgba(244,114,182,.15)', colorBorder:'rgba(244,114,182,.3)', colorIcon:'#f472b6' },
  { key: 'controlador',   label: 'Controlador de Chat', icon: 'ti-adjustments',  types: ['pergunta','aguardar'],                         color:'rgba(167,139,250,.15)', colorBorder:'rgba(167,139,250,.3)', colorIcon:'#a78bfa' },
  { key: 'departamentos', label: 'Departamentos',       icon: 'ti-building',     types: ['transferir'],                                  color:'rgba(251,146,60,.15)',  colorBorder:'rgba(251,146,60,.3)',  colorIcon:'#fb923c' },
  { key: 'salvar',        label: 'Salvar',              icon: 'ti-device-floppy',types: ['salvar'],                                     color:'rgba(52,211,153,.15)',  colorBorder:'rgba(52,211,153,.3)',  colorIcon:'#34d399' },
  { key: 'remarketing',   label: 'Remarketing',         icon: 'ti-speakerphone', types: ['remarketing'],                                color:'rgba(251,191,36,.15)',  colorBorder:'rgba(251,191,36,.3)',  colorIcon:'#fbbf24' },
  { key: 'condicao',      label: 'Condição',            icon: 'ti-git-fork',     types: ['condicao'],                                    color:'rgba(251,191,36,.15)',  colorBorder:'rgba(251,191,36,.3)',  colorIcon:'#fbbf24' },
  { key: 'conexao',       label: 'Conexão de Fluxo',   icon: 'ti-link',         types: ['encerrar'],                                    color:'rgba(148,163,184,.15)', colorBorder:'rgba(148,163,184,.3)', colorIcon:'#94a3b8' },
  { key: 'atraso',        label: 'Atraso Inteligente',  icon: 'ti-clock',        types: ['atraso'],                                      color:'rgba(0,200,240,.15)',  colorBorder:'rgba(0,200,240,.3)',  colorIcon:'#00c8f0' },
  { key: 'integracoes',   label: 'Integrações',        icon: 'ti-plug',         types: ['webhook','api'],                               color:'rgba(0,200,240,.15)',  colorBorder:'rgba(0,200,240,.3)',  colorIcon:'#00c8f0' },
];

// ── Renderizar lista de blocos ──────────────────
// ── FASE 3.4 — Painel de blocos premium (grid 2 colunas, cards visuais) ──
function renderBlockLib(q) {
  const body = document.getElementById('block-lib-body');
  if (!body) return;
  body.innerHTML = '';
  const lq = q.toLowerCase().trim();

  let found = 0;
  _LIB_CATS.forEach(cat => {
    // Filtrar: categoria aparece se o label ou qualquer sub-tipo bate na pesquisa
    const anyMatch = !lq
      || cat.label.toLowerCase().includes(lq)
      || cat.types.some(t => DEF[t] && DEF[t].n.toLowerCase().includes(lq));
    if (!anyMatch) return;
    found++;

    // Uma linha por categoria — ícone colorido + nome da categoria
    const card = document.createElement('div');
    card.className = 'block-lib-row';
    card.innerHTML = `
      <div class="block-lib-row-ico" style="background:${cat.color || 'rgba(0,200,240,.12)'};border-color:${cat.colorBorder || 'rgba(0,200,240,.2)'}">
        <i class="ti ${cat.icon}" style="color:${cat.colorIcon || '#00c8f0'}"></i>
      </div>
      <span class="block-lib-row-name">${cat.label}</span>
      <i class="ti ti-chevron-right block-lib-row-arr"></i>`;
    card.addEventListener('click', () => {
      // Criar nó com o primeiro tipo da categoria e abrir modal composto
      addNode(cat.types[0], pickerPos);
      closeBlockLib();
    });
    body.appendChild(card);
  });

  if (!found) {
    body.innerHTML = '<div class="block-lib-empty">Nenhum bloco encontrado.</div>';
  }
}

// ── Alias renderPicker para compatibilidade ─────
function renderPicker(q) { renderBlockLib(q); }

function addNode(type, pos) {
  const def = DEF[type]; if (!def) return;

  // FASE 5.3 — Impedir múltiplos blocos Início
  if (type === 'inicio' && nodes.some(n => n.t === 'inicio')) {
    toast('Já existe um bloco Início neste fluxo.', 'err');
    return;
  }

  const wrap = document.getElementById('fb-wrap');
  const r = wrap.getBoundingClientRect();
  let x, y;
  if (pos) { x = pos.x; y = pos.y; }
  else {
    x = Math.round((r.width / 2 - panX - 140) / zoom / 20) * 20;
    y = Math.round((r.height / 2 - panY - 70) / zoom / 20) * 20;
    // NodeMap iteration is O(n) but happens only once on add — acceptable
    while (nodes.some(n => Math.abs(n.x - x) < 25 && Math.abs(n.y - y) < 25)) x += 320;
  }
  // Use NodeTypeRegistry for type-specific defaults (Firebase-ready schema)
  const regDef = NodeTypeRegistry.get(type);
  const data = regDef ? NodeTypeRegistry.getDefaultData(type) : {};
  // Also seed legacy DEFS.fs select defaults for unregistered types
  if (!regDef && def.fs) def.fs.forEach(f => { if (f.tp==='sel' && f.o) data[f.id]=f.o[0]; });
  // Se o tipo pertence a uma categoria composta, pré-popular _items com este sub-tipo
  const catKey = _getCompositeCat(type);
  if (catKey) {
    data._items = [{ type, data: {} }];
  }
  const n = {id: uid(), t: type, x, y, lbl: def.n, data};
  nodes.push(n);
  NodeMap.set(n.id, n); // keep NodeMap in sync immediately
  push(); render();
  sel.clear(); sel.add(n.id); updateSel();
  setTimeout(() => openPanel(n.id), 50);
}

// ─── FASE 2.6 — Node Editor Modal (UX profissional) ──────────────
// Substituição completa do painel lateral por modal central.
// Zero exposição técnica: sem {{variáveis}}, sem JSON, sem IDs internos.
// Cada tipo de bloco tem um builder específico e limpo.

// ── Auto-geração de nomes internos ─────────────────────────────────
function _autoVarName(prefix) {
  return (prefix || 'var') + '_' + Math.random().toString(36).slice(2, 7);
}

// ── Utilitários de construção do modal ─────────────────────────────
function _nmField(label, sublabel, html) {
  const d = document.createElement('div');
  d.className = 'nm-field';
  d.innerHTML = `
    <div class="nm-label">${label}</div>
    ${sublabel ? `<div class="nm-sublabel">${sublabel}</div>` : ''}
    ${html}`;
  return d;
}

function _nmTA(id, placeholder, value, rows) {
  return `<textarea class="nm-textarea" id="${id}" placeholder="${placeholder}" rows="${rows||4}">${value||''}</textarea>`;
}
function _nmIN(id, placeholder, value, type) {
  return `<input class="nm-input" id="${id}" type="${type||'text'}" placeholder="${placeholder}" value="${value||''}">`;
}
function _nmSEL(id, options, value) {
  const opts = options.map(o => `<option${o===value?' selected':''}>${o}</option>`).join('');
  return `<select class="nm-select" id="${id}">${opts}</select>`;
}

// ── Builders por tipo ───────────────────────────────────────────────
const _NMBuilders = {

  inicio(n, body) {
    const triggers = ['Mensagem recebida', 'Palavra-chave', 'Horário'];
    const cur = n.data.trigger || 'Mensagem recebida';
    const seg = document.createElement('div');
    seg.className = 'nm-field';
    seg.innerHTML = `<div class="nm-label">Quando este fluxo inicia</div>
      <div class="nm-segment" id="nm-trigger-seg">
        ${triggers.map(t => `<button class="nm-seg-btn${t===cur?' active':''}" data-val="${t}">${t}</button>`).join('')}
      </div>`;
    body.appendChild(seg);
    seg.querySelectorAll('.nm-seg-btn').forEach(b => {
      b.addEventListener('click', () => {
        seg.querySelectorAll('.nm-seg-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        document.getElementById('nm-kw-wrap').style.display =
          b.dataset.val === 'Palavra-chave' ? '' : 'none';
      });
    });
    const kwWrap = document.createElement('div');
    kwWrap.id = 'nm-kw-wrap';
    kwWrap.style.display = cur === 'Palavra-chave' ? '' : 'none';
    kwWrap.appendChild(_nmField('Palavras-chave', 'Separe com vírgula: oi, olá, menu',
      _nmIN('nm-keyword', 'oi, olá, menu', n.data.keyword)));
    body.appendChild(kwWrap);

    // FASE 4 — Opção: Responder em grupos
    const allowGroups = n.data.allowGroups === true;
    const grpField = document.createElement('div');
    grpField.className = 'nm-field';
    grpField.innerHTML = `
      <div class="nm-label" style="display:flex;align-items:center;gap:6px">
        <i class="ti ti-users-group" style="font-size:13px;color:var(--k-muted)"></i>
        Responder em grupos
      </div>
      <div class="nm-segment" id="nm-group-seg">
        <button class="nm-seg-btn${!allowGroups ? ' active' : ''}" data-val="false">Não</button>
        <button class="nm-seg-btn${allowGroups  ? ' active' : ''}" data-val="true">Sim</button>
      </div>
      <div style="font-size:10px;color:var(--k-muted);margin-top:4px;line-height:1.5">
        Por defeito: <b>Não</b>. Quando activo, o bot responde em grupos de WhatsApp onde estiver adicionado.
      </div>`;
    body.appendChild(grpField);
  },

  mensagem(n, body) {
    body.appendChild(_nmField('Mensagem',
      'Escreva o que o utilizador vai receber.',
      _nmTA('nm-txt', 'Olá! Como posso ajudar?', n.data.txt)));
  },

  imagem(n, body) {
    body.appendChild(_nmField('Endereço da imagem',
      'Cole o link directo para a imagem (https://...)',
      _nmIN('nm-url', 'https://exemplo.com/imagem.jpg', n.data.url)));
    body.appendChild(_nmField('Legenda', 'Opcional',
      _nmIN('nm-cap', '', n.data.cap)));
    // Live preview
    const prev = document.createElement('div');
    prev.style.cssText = 'border-radius:10px;overflow:hidden;max-height:120px;background:var(--k-surface2);display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--k-muted);margin-top:4px';
    if (n.data.url) {
      const img = document.createElement('img');
      img.src = n.data.url; img.style.cssText = 'max-width:100%;max-height:120px;display:block';
      img.onerror = () => { prev.textContent = 'Imagem não encontrada'; };
      prev.appendChild(img);
    } else { prev.textContent = 'A pré-visualização aparece aqui'; }
    body.appendChild(prev);
    setTimeout(() => {
      const inp = document.getElementById('nm-url');
      if (inp) inp.addEventListener('input', () => {
        prev.innerHTML = '';
        if (inp.value) {
          const img = document.createElement('img');
          img.src = inp.value; img.style.cssText = 'max-width:100%;max-height:120px;display:block';
          img.onerror = () => { prev.textContent = 'Imagem não encontrada'; };
          prev.appendChild(img);
        } else { prev.textContent = 'A pré-visualização aparece aqui'; }
      });
    }, 0);
  },

  video(n, body) {
    body.appendChild(_nmField('Endereço do vídeo',
      'Cole o link directo para o ficheiro de vídeo.',
      _nmIN('nm-url', 'https://exemplo.com/video.mp4', n.data.url)));
    body.appendChild(_nmField('Legenda', 'Opcional',
      _nmIN('nm-cap', '', n.data.cap)));
  },

  audio(n, body) {
    body.appendChild(_nmField('Endereço do áudio',
      'Cole o link directo para o ficheiro de áudio.',
      _nmIN('nm-url', 'https://exemplo.com/audio.ogg', n.data.url)));
  },

  documento(n, body) {
    body.appendChild(_nmField('Endereço do ficheiro',
      'Cole o link para o PDF ou documento.',
      _nmIN('nm-url', 'https://exemplo.com/catalogo.pdf', n.data.url)));
    body.appendChild(_nmField('Nome do ficheiro', 'Como o ficheiro aparece para o utilizador',
      _nmIN('nm-fn', 'catalogo.pdf', n.data.fn)));
  },

  pergunta(n, body) {
    body.appendChild(_nmField('Pergunta',
      'O que pretende perguntar ao utilizador?',
      _nmTA('nm-txt', 'Qual é o seu nome?', n.data.txt)));
    // Tipo de resposta esperada — escolha visual
    const tipos = ['Texto', 'Número', 'Email', 'Telefone'];
    const curTipo = n.data._rtype || 'Texto';
    const tipoCont = document.createElement('div');
    tipoCont.className = 'nm-field';
    tipoCont.innerHTML = `<div class="nm-label">Tipo de resposta esperada</div>
      <div class="nm-segment">
        ${tipos.map(t => `<button class="nm-seg-btn${t===curTipo?' active':''}" data-val="${t}">${t}</button>`).join('')}
      </div>`;
    body.appendChild(tipoCont);
    tipoCont.querySelectorAll('.nm-seg-btn').forEach(b => {
      b.addEventListener('click', () => {
        tipoCont.querySelectorAll('.nm-seg-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
      });
    });
    // Nome da informação — usado para gerar variável automaticamente
    body.appendChild(_nmField('Nome desta informação',
      'Como quer chamar o que o utilizador responde? (ex: Nome, Email)',
      _nmIN('nm-varname', 'Nome', n.data._varname || '')));
    // Campo var escondido (auto-gerado)
    const hidden = document.createElement('input');
    hidden.type = 'hidden'; hidden.id = 'nm-var';
    hidden.value = n.data.var || _autoVarName('resp');
    body.appendChild(hidden);
  },

  aguardar(n, body) {
    const row = document.createElement('div'); row.className = 'nm-row';
    const fTo = _nmField('Tempo máximo de espera', '',
      _nmIN('nm-to', '30', n.data.to, 'number'));
    const fUn = _nmField('Unidade', '',
      _nmSEL('nm-unit', ['Minutos', 'Horas'], n.data._unit || 'Minutos'));
    row.appendChild(fTo); row.appendChild(fUn);
    body.appendChild(row);
    // Var escondida
    const hidden = document.createElement('input');
    hidden.type = 'hidden'; hidden.id = 'nm-var';
    hidden.value = n.data.var || _autoVarName('resp');
    body.appendChild(hidden);
  },

  salvar(n, body) {
    // Informação: o bot gera o nome da variável automaticamente
    const info = document.createElement('div');
    info.style.cssText = 'background:rgba(52,211,153,.10);border:1px solid rgba(52,211,153,.25);border-radius:8px;padding:10px 12px;font-size:12px;color:var(--k-muted);line-height:1.6;margin-bottom:4px';
    info.innerHTML = `<i class="ti ti-info-circle" style="color:#34d399;margin-right:5px"></i>
      O bot guarda automaticamente a <b>última mensagem recebida</b> numa variável gerada automaticamente
      (<code style="background:rgba(52,211,153,.15);padding:1px 5px;border-radius:4px">{{resposta_1}}</code>,
      <code style="background:rgba(52,211,153,.15);padding:1px 5px;border-radius:4px">{{resposta_2}}</code>, …).
      Use essa variável nos blocos seguintes para personalizar as mensagens.`;
    body.appendChild(info);
  },

  botao(n, body) {
    body.appendChild(_nmField('Mensagem',
      'Texto que aparece antes dos botões.',
      _nmTA('nm-txt', 'Escolha uma opção:', n.data.txt, 3)));
    // Botões dinâmicos
    const btnsCur = (n.data.btns || '').split('\n').filter(Boolean);
    if (!btnsCur.length) btnsCur.push('');
    const listWrap = document.createElement('div');
    listWrap.className = 'nm-field';
    listWrap.innerHTML = '<div class="nm-label">Opções do menu</div>';
    const list = document.createElement('div'); list.className = 'nm-options-list'; list.id = 'nm-btns-list';
    listWrap.appendChild(list);
    body.appendChild(listWrap);
    function addBtnRow(val) {
      const row = document.createElement('div'); row.className = 'nm-option-row';
      row.innerHTML = `<input class="nm-input nm-btn-item" placeholder="Opção..." value="${val||''}">
        <button class="nm-option-remove"><i class="ti ti-x"></i></button>`;
      row.querySelector('.nm-option-remove').addEventListener('click', () => row.remove());
      list.appendChild(row);
    }
    btnsCur.forEach(v => addBtnRow(v));
    const addBtn = document.createElement('button');
    addBtn.className = 'nm-add-option';
    addBtn.innerHTML = '<i class="ti ti-plus"></i> Adicionar opção';
    addBtn.addEventListener('click', () => addBtnRow(''));
    listWrap.appendChild(addBtn);
  },

  lista(n, body) {
    body.appendChild(_nmField('Mensagem',
      'Texto que aparece antes da lista.',
      _nmTA('nm-txt', 'Escolha:', n.data.txt, 3)));
    body.appendChild(_nmField('Texto do botão', 'Rótulo do botão que abre a lista',
      _nmIN('nm-bl', 'Ver opções', n.data.bl)));
    const itemsCur = (n.data.items || '').split('\n').filter(Boolean);
    if (!itemsCur.length) itemsCur.push('');
    const listWrap = document.createElement('div');
    listWrap.className = 'nm-field';
    listWrap.innerHTML = '<div class="nm-label">Itens da lista</div>';
    const list = document.createElement('div'); list.className = 'nm-options-list'; list.id = 'nm-items-list';
    listWrap.appendChild(list);
    body.appendChild(listWrap);
    function addItemRow(val) {
      const row = document.createElement('div'); row.className = 'nm-option-row';
      row.innerHTML = `<input class="nm-input nm-item-item" placeholder="Item..." value="${val||''}">
        <button class="nm-option-remove"><i class="ti ti-x"></i></button>`;
      row.querySelector('.nm-option-remove').addEventListener('click', () => row.remove());
      list.appendChild(row);
    }
    itemsCur.forEach(v => addItemRow(v));
    const addBtn = document.createElement('button');
    addBtn.className = 'nm-add-option';
    addBtn.innerHTML = '<i class="ti ti-plus"></i> Adicionar item';
    addBtn.addEventListener('click', () => addItemRow(''));
    listWrap.appendChild(addBtn);
  },

  condicao(n, body) {
    // What to check — shown as "informação guardada"
    body.appendChild(_nmField('Informação a verificar',
      'Que dado do utilizador quer avaliar?',
      _nmSEL('nm-var', ['Nome','Email','Telefone','Resposta','Opção escolhida','Personalizado'], n.data._varfriendly || 'Resposta')));
    const customWrap = document.createElement('div');
    customWrap.id = 'nm-custom-var-wrap';
    customWrap.style.display = (n.data._varfriendly === 'Personalizado') ? '' : 'none';
    customWrap.appendChild(_nmField('Nome da variável', '', _nmIN('nm-customvar', '', n.data.var)));
    body.appendChild(customWrap);
    setTimeout(() => {
      const sel = document.getElementById('nm-var');
      if (sel) sel.addEventListener('change', () => {
        document.getElementById('nm-custom-var-wrap').style.display =
          sel.value === 'Personalizado' ? '' : 'none';
      });
    }, 0);
    body.appendChild(_nmField('Condição',
      'Que comparação quer fazer?',
      _nmSEL('nm-op', ['é igual a','é diferente de','contém','não contém','começa com','é um número','não está vazio','está vazio'],
        n.data.op || 'é igual a')));
    const valWrap = document.createElement('div'); valWrap.id = 'nm-val-wrap';
    valWrap.style.display = ['não está vazio','está vazio'].includes(n.data.op) ? 'none' : '';
    valWrap.appendChild(_nmField('Valor', 'Com o que comparar?', _nmIN('nm-val', '', n.data.val)));
    body.appendChild(valWrap);
    setTimeout(() => {
      const op = document.getElementById('nm-op');
      if (op) op.addEventListener('change', () => {
        document.getElementById('nm-val-wrap').style.display =
          ['não está vazio','está vazio'].includes(op.value) ? 'none' : '';
      });
    }, 0);
  },

  tag(n, body) {
    body.appendChild(_nmField('Etiquetas a adicionar',
      'Escreva e pressione Enter para adicionar cada etiqueta.',
      ''));
    _buildTagInput(body, 'nm-tags', n.data.tags || '');
  },

  removertag(n, body) {
    body.appendChild(_nmField('Etiquetas a remover',
      'Escreva e pressione Enter para seleccionar cada etiqueta.',
      ''));
    _buildTagInput(body, 'nm-tags', n.data.tags || '');
  },

  transferir(n, body) {
    body.appendChild(_nmField('Departamento ou agente',
      'Para onde transferir o atendimento?',
      _nmIN('nm-agent', 'Vendas', n.data.agent)));
    body.appendChild(_nmField('Nota para o agente', 'Informação opcional enviada ao agente',
      _nmTA('nm-msg', 'Novo cliente a aguardar atendimento.', n.data.msg, 3)));
  },

  delay(n, body) {
    const row = document.createElement('div'); row.className = 'nm-row';
    const fSecs = _nmField('Tempo de espera', '', _nmIN('nm-secs', '3', n.data.secs, 'number'));
    const fUnit = _nmField('Unidade', '', _nmSEL('nm-unit', ['Segundos','Minutos'], n.data._unit || 'Segundos'));
    row.appendChild(fSecs); row.appendChild(fUnit);
    body.appendChild(row);
    // Indicador "a digitar" é activado automaticamente durante o delay.
  },

  encerrar(n, body) {
    body.appendChild(_nmField('Mensagem de encerramento', 'Opcional — enviada antes de fechar o fluxo.',
      _nmTA('nm-msg', 'Obrigado pelo contacto! Até breve.', n.data.msg, 3)));
  },

  webhook(n, body) {
    body.appendChild(_nmField('URL de destino',
      'Endereço para onde enviar os dados.',
      _nmIN('nm-url', 'https://meuservidor.com/webhook', n.data.url)));
    body.appendChild(_nmField('Método',
      '',
      _nmSEL('nm-method', ['POST','GET','PUT','PATCH','DELETE'], n.data.method || 'POST')));
  },

  api(n, body) {
    body.appendChild(_nmField('Endereço da API',
      'URL do serviço que quer consultar.',
      _nmIN('nm-endpoint', 'https://api.exemplo.com/dados', n.data.endpoint)));
    body.appendChild(_nmField('Método',
      '',
      _nmSEL('nm-method', ['GET','POST','PUT','PATCH','DELETE'], n.data.method || 'GET')));
  },
};

// ── Tag chip input builder ──────────────────────────────────────────
function _buildTagInput(body, id, initialValue) {
  const wrap = document.createElement('div');
  wrap.className = 'nm-tags-wrap'; wrap.id = id + '-wrap';
  const input = document.createElement('input');
  input.className = 'nm-tag-input'; input.id = id;
  input.placeholder = 'Escreva e pressione Enter...';
  wrap.appendChild(input);
  body.appendChild(wrap);
  const tags = (initialValue || '').split(',').map(t => t.trim()).filter(Boolean);
  function addChip(val) {
    if (!val) return;
    const chip = document.createElement('span'); chip.className = 'nm-tag-chip';
    chip.innerHTML = `${val} <button type="button"><i class="ti ti-x"></i></button>`;
    chip.dataset.val = val;
    chip.querySelector('button').addEventListener('click', () => chip.remove());
    wrap.insertBefore(chip, input);
  }
  tags.forEach(t => addChip(t));
  input.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ',') && input.value.trim()) {
      e.preventDefault();
      addChip(input.value.trim()); input.value = '';
    }
    if (e.key === 'Backspace' && !input.value) {
      const chips = wrap.querySelectorAll('.nm-tag-chip');
      if (chips.length) chips[chips.length-1].remove();
    }
  });
  wrap.addEventListener('click', () => input.focus());
}

// ── Colectar dados do modal ─────────────────────────────────────────
function _nmCollect(n) {
  const def = DEF[n.t] || {};
  const get = id => { const el = document.getElementById(id); return el ? el.value : undefined; };

  // Rótulo do bloco
  const lbl = get('nm-lbl'); if (lbl !== undefined) n.lbl = lbl;

  // Dados por tipo
  switch (n.t) {
    case 'inicio':
      n.data.trigger     = document.querySelector('#nm-trigger-seg .nm-seg-btn.active')?.dataset.val || 'Mensagem recebida';
      n.data.keyword     = get('nm-keyword') || '';
      // FASE 4 — gravar opção de grupos (padrão: false)
      n.data.allowGroups = document.querySelector('#nm-group-seg .nm-seg-btn.active')?.dataset.val === 'true';
      break;
    case 'mensagem':
      n.data.txt = get('nm-txt') || '';
      break;
    case 'imagem':
    case 'video':
    case 'audio':
      n.data.url = get('nm-url') || '';
      n.data.cap = get('nm-cap') || '';
      break;
    case 'documento':
      n.data.url = get('nm-url') || '';
      n.data.fn  = get('nm-fn') || '';
      break;
    case 'pergunta': {
      n.data.txt      = get('nm-txt') || '';
      n.data._varname = get('nm-varname') || '';
      n.data._rtype   = document.querySelector('.nm-seg-btn.active')?.dataset.val || 'Texto';
      // Auto-gerar variável interna a partir do nome amigável
      const vname = (n.data._varname || 'resposta').toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
        .replace(/[^a-z0-9]/g,'_').replace(/_+/g,'_').slice(0,20);
      n.data.var = '{{' + vname + '}}';
      break;
    }
    case 'aguardar':
      n.data.to   = get('nm-to') || '30';
      n.data._unit = get('nm-unit') || 'Minutos';
      // var auto-preservada do campo hidden
      n.data.var  = get('nm-var') || n.data.var || _autoVarName('resp');
      break;
    case 'botao': {
      n.data.txt = get('nm-txt') || '';
      const items = [...document.querySelectorAll('.nm-btn-item')].map(i => i.value.trim()).filter(Boolean);
      n.data.btns = items.join('\n');
      // outs guardados nos dados do nó — mkNode usa n.data.btns directamente
      break;
    }
    case 'lista': {
      n.data.txt = get('nm-txt') || '';
      n.data.bl  = get('nm-bl') || 'Ver opções';
      const items = [...document.querySelectorAll('.nm-item-item')].map(i => i.value.trim()).filter(Boolean);
      n.data.items = items.join('\n');
      // outs guardados nos dados do nó — mkNode usa n.data.items directamente
      break;
    }
    case 'condicao': {
      const friendly = get('nm-var') || 'Resposta';
      n.data._varfriendly = friendly;
      const varMap = { 'Nome':'{{nome}}','Email':'{{email}}','Telefone':'{{telefone}}',
        'Resposta':'{{resposta}}','Opção escolhida':'{{opcao}}' };
      n.data.var = friendly === 'Personalizado' ? (get('nm-customvar') || '{{resposta}}') : (varMap[friendly] || '{{resposta}}');
      n.data.op  = get('nm-op') || 'é igual a';
      n.data.val = get('nm-val') || '';
      break;
    }
    case 'tag':
    case 'removertag': {
      const chips = [...document.querySelectorAll('#nm-tags-wrap .nm-tag-chip')].map(c => c.dataset.val);
      const typed = document.getElementById('nm-tags')?.value?.trim();
      if (typed) chips.push(typed);
      n.data.tags = chips.join(', ');
      break;
    }
    case 'transferir':
      n.data.agent = get('nm-agent') || '';
      n.data.msg   = get('nm-msg') || '';
      break;
    case 'delay':
      n.data.secs   = get('nm-secs') || '3';
      n.data._unit  = get('nm-unit') || 'Segundos';
      break;
    case 'encerrar':
      n.data.msg = get('nm-msg') || '';
      break;
    case 'webhook':
      n.data.url    = get('nm-url') || '';
      n.data.method = get('nm-method') || 'POST';
      break;
    case 'api':
      n.data.endpoint = get('nm-endpoint') || '';
      n.data.method   = get('nm-method') || 'GET';
      break;
  }
}

// ══════════════════════════════════════════════════════════════════
// FASE 2.7C — Modal de bloco composto
// Categorias com múltiplos sub-tipos (Conteúdo, Menu, Etiqueta, etc.)
// abrem um picker de sub-tipos dentro do modal. O utilizador escolhe
// um sub-tipo → aparece o editor desse sub-tipo com chip identificador
// + o picker de tipos restantes persiste em baixo para adicionar mais.
// Os itens ficam guardados em n.data._items = [{type, data}].
// Categorias com tipo único abrem direto o editor (comportamento anterior).
// ══════════════════════════════════════════════════════════════════

// Mapa: key da categoria → tipos compostos (mais de 1 tipo na categoria)
const _COMPOSITE_CATS = {
  conteudo:      ['mensagem','imagem','video','audio','documento','delay'],
  menu:          ['botao','lista'],
  controlador:   ['pergunta'],
  etiqueta:      ['tag','removertag'],
};

// Cores de chip por tipo (tom suave)
const _CHIP_COLORS = {
  mensagem:  { bg:'rgba(0,200,240,.15)',  border:'rgba(0,200,240,.35)',  text:'#00c8f0' },
  imagem:    { bg:'rgba(0,200,240,.15)',  border:'rgba(0,200,240,.35)',  text:'#00c8f0' },
  video:     { bg:'rgba(0,200,240,.15)',  border:'rgba(0,200,240,.35)',  text:'#00c8f0' },
  audio:     { bg:'rgba(167,139,250,.15)', border:'rgba(167,139,250,.35)', text:'#a78bfa' },
  documento: { bg:'rgba(148,163,184,.15)', border:'rgba(148,163,184,.35)', text:'#94a3b8' },
  botao:     { bg:'rgba(0,200,240,.15)',  border:'rgba(0,200,240,.35)',  text:'#00c8f0' },
  lista:     { bg:'rgba(0,200,240,.15)',  border:'rgba(0,200,240,.35)',  text:'#00c8f0' },
  pergunta:  { bg:'rgba(167,139,250,.15)', border:'rgba(167,139,250,.35)', text:'#a78bfa' },
  aguardar:  { bg:'rgba(167,139,250,.15)', border:'rgba(167,139,250,.35)', text:'#a78bfa' },
  tag:       { bg:'rgba(167,139,250,.15)', border:'rgba(167,139,250,.35)', text:'#a78bfa' },
  removertag:{ bg:'rgba(244,114,182,.15)', border:'rgba(244,114,182,.35)', text:'#f472b6' },
};

// Detectar se um nó pertence a uma categoria composta
function _getCompositeCat(nType) {
  for (const [key, types] of Object.entries(_COMPOSITE_CATS)) {
    if (types.includes(nType)) return key;
  }
  return null;
}

// Detectar se um nó tem dados compostos (._items) ou é tipo raiz de categoria composta
function _isCompositeMode(n) {
  const catKey = _getCompositeCat(n.t);
  return !!catKey;
}

// ── Construir editor de um item composto (dentro do bloco composto) ──
function _buildCompositeItemEditor(itemType, itemData, idx, container, allTypes) {
  const def = DEF[itemType] || {};
  const col = _CHIP_COLORS[itemType] || { bg:'rgba(0,120,240,.12)', border:'rgba(0,120,240,.3)', text:'#0078f0' };

  const wrapper = document.createElement('div');
  wrapper.className = 'nm-composite-item';
  wrapper.dataset.idx = idx;
  wrapper.dataset.type = itemType;

  // Chip cabeçalho com ícone, nome e botão remover
  const chip = document.createElement('div');
  chip.className = 'nm-composite-chip';
  chip.style.cssText = `background:${col.bg};border-color:${col.border};`;
  chip.innerHTML = `
    <i class="ti ${def.ic || 'ti-cube'}" style="color:${col.text};font-size:13px"></i>
    <span style="color:${col.text};font-size:12px;font-weight:500">${def.n || itemType}</span>
    <button class="nm-composite-remove" title="Remover"><i class="ti ti-x"></i></button>`;
  chip.querySelector('.nm-composite-remove').addEventListener('click', () => {
    wrapper.remove();
    _refreshCompositePickerVisibility(container, allTypes);
  });
  wrapper.appendChild(chip);

  // Editor do sub-tipo
  const editorBody = document.createElement('div');
  editorBody.className = 'nm-composite-editor';
  // Criar nó temporário para o builder
  const tmpNode = { t: itemType, data: Object.assign({}, itemData || {}) };
  const builder = _NMBuilders[itemType];
  if (builder) {
    builder(tmpNode, editorBody);
  } else {
    const d = DEF[itemType] || {};
    (d.fs || []).forEach(f => {
      const val = tmpNode.data[f.id] !== undefined ? tmpNode.data[f.id] : '';
      editorBody.appendChild(_nmField(f.l, '',
        f.tp === 'area' ? _nmTA(`nm-ci-${idx}-${f.id}`, f.ph||'', val)
        : f.tp === 'sel' ? _nmSEL(`nm-ci-${idx}-${f.id}`, f.o||[], val)
        : _nmIN(`nm-ci-${idx}-${f.id}`, f.ph||'', val)));
    });
  }
  // Prefixar todos os IDs dos campos com o índice para evitar colisões
  editorBody.querySelectorAll('[id]').forEach(el => {
    if (!el.id.startsWith('nm-ci-')) el.id = `nm-ci-${idx}-${el.id}`;
  });
  wrapper.appendChild(editorBody);

  return wrapper;
}

// Atualizar visibilidade do picker (remover tipos já sem picker visível)
function _refreshCompositePickerVisibility(container, allTypes) {
  // nada a fazer aqui — picker mostra sempre todos os tipos disponíveis
}

// ── Construir picker de tipos para bloco composto ──────────────────
function _buildCompositePicker(container, catTypes) {
  const pickerWrap = document.createElement('div');
  pickerWrap.className = 'nm-composite-picker-wrap';

  const sep = document.createElement('div');
  sep.className = 'nm-composite-sep';
  sep.innerHTML = '<span>Adicionar ao bloco</span>';
  pickerWrap.appendChild(sep);

  const grid = document.createElement('div');
  grid.className = 'nm-composite-picker-grid';

  catTypes.forEach(t => {
    const def = DEF[t] || {};
    const col = _CHIP_COLORS[t] || {};
    const btn = document.createElement('button');
    btn.className = 'nm-composite-picker-btn';
    btn.dataset.type = t;
    btn.innerHTML = `
      <i class="ti ${def.ic || 'ti-cube'}" style="color:${col.text || '#0078f0'}"></i>
      <span>${def.n || t}</span>`;
    btn.addEventListener('click', () => {
      // Inserir novo item antes do picker
      const items = container.querySelectorAll('.nm-composite-item');
      const idx = items.length;
      const newItem = _buildCompositeItemEditor(t, {}, idx, container, catTypes);
      container.insertBefore(newItem, pickerWrap);
      // Scroll para o novo item
      setTimeout(() => newItem.scrollIntoView({ behavior:'smooth', block:'nearest' }), 50);
    });
    grid.appendChild(btn);
  });

  pickerWrap.appendChild(grid);
  return pickerWrap;
}

// ── Colectar dados de um item composto ────────────────────────────
function _collectCompositeItem(wrapper) {
  const type = wrapper.dataset.type;
  const idx  = wrapper.dataset.idx;
  const data = {};
  const get  = id => { const el = document.getElementById(id); return el ? el.value : undefined; };
  const pfx  = `nm-ci-${idx}-`;

  switch(type) {
    case 'mensagem':
      data.txt = get(`${pfx}nm-txt`) || '';
      break;
    case 'imagem':
    case 'video':
      data.url = get(`${pfx}nm-url`) || '';
      data.cap = get(`${pfx}nm-cap`) || '';
      break;
    case 'audio':
      data.url = get(`${pfx}nm-url`) || '';
      break;
    case 'documento':
      data.url = get(`${pfx}nm-url`) || '';
      data.fn  = get(`${pfx}nm-fn`) || '';
      break;
    case 'botao': {
      data.txt  = get(`${pfx}nm-txt`) || '';
      const items = [...wrapper.querySelectorAll('.nm-btn-item')].map(i=>i.value.trim()).filter(Boolean);
      data.btns = items.join('\n');
      break;
    }
    case 'lista': {
      data.txt   = get(`${pfx}nm-txt`) || '';
      data.bl    = get(`${pfx}nm-bl`)  || 'Ver opções';
      const items = [...wrapper.querySelectorAll('.nm-item-item')].map(i=>i.value.trim()).filter(Boolean);
      data.items = items.join('\n');
      break;
    }
    case 'pergunta': {
      data.txt      = get(`${pfx}nm-txt`) || '';
      data._varname = get(`${pfx}nm-varname`) || '';
      data._rtype   = wrapper.querySelector('.nm-seg-btn.active')?.dataset.val || 'Texto';
      const vname = (data._varname||'resposta').toLowerCase().normalize('NFD')
        .replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'_').replace(/_+/g,'_').slice(0,20);
      data.var = '{{'+vname+'}}';
      break;
    }
    case 'delay':
      data.secs   = get(`${pfx}nm-secs`) || '3';
      data._unit  = get(`${pfx}nm-unit`) || 'Segundos';
      break;
    case 'aguardar':
      data.to    = get(`${pfx}nm-to`) || '30';
      data._unit = get(`${pfx}nm-unit`) || 'Minutos';
      data.var   = get(`${pfx}nm-var`) || _autoVarName('resp');
      break;
    case 'tag':
    case 'removertag': {
      const chips = [...wrapper.querySelectorAll('.nm-tag-chip')].map(c=>c.dataset.val);
      const typed = wrapper.querySelector('.nm-tag-input')?.value?.trim();
      if (typed) chips.push(typed);
      data.tags = chips.join(', ');
      break;
    }
    default: {
      // Colectar campos genéricos prefixados
      wrapper.querySelectorAll('[id]').forEach(el => {
        const rawId = el.id.replace(pfx,'').replace('nm-','');
        if (el.value !== undefined) data[rawId] = el.value;
      });
    }
  }
  return { type, data };
}

// ── Abrir modal ─────────────────────────────────────────────────────
function openPanel(nid) {
  const n = NodeMap.get(nid); if (!n) return;
  activeId = nid;
  const def = DEF[n.t] || {};

  // Cabeçalho do modal
  document.getElementById('node-modal-title').textContent    = def.n || n.t;
  document.getElementById('node-modal-subtitle').textContent = def.d || '';
  const iconEl = document.getElementById('node-modal-icon');
  const iconI  = document.getElementById('node-modal-icon-i');
  iconEl.style.background = (def.c || '#0078f0') + '18';
  iconI.className = `ti ${def.ic || 'ti-cube'}`;
  iconI.style.color = def.c || '#0078f0';

  const body = document.getElementById('node-modal-body');
  body.innerHTML = '';

  // ── Modo composto ───────────────────────────────────────────────
  const catKey   = _getCompositeCat(n.t);
  const catTypes = catKey ? _COMPOSITE_CATS[catKey] : null;

  if (catTypes) {
    // Actualizar ícone/título para o da categoria
    const catDef = _LIB_CATS.find(c => c.key === catKey);
    if (catDef) {
      document.getElementById('node-modal-title').textContent = catDef.label;
      document.getElementById('node-modal-subtitle').textContent = 'Compõe os passos deste bloco';
      iconEl.style.background = '#0078f018';
      iconI.className = `ti ${catDef.icon}`;
      iconI.style.color = '#0078f0';
    }

    // Container dos itens compostos + picker
    const compositeContainer = document.createElement('div');
    compositeContainer.id = 'nm-composite-container';

    // Itens já existentes (re-abertura)
    const existingItems = n.data._items || [];
    if (existingItems.length > 0) {
      existingItems.forEach((item, idx) => {
        const w = _buildCompositeItemEditor(item.type, item.data, idx, compositeContainer, catTypes);
        compositeContainer.appendChild(w);
      });
    } else {
      // Primeira abertura: mostrar picker direto (sem itens ainda)
    }

    // Picker sempre em baixo
    const picker = _buildCompositePicker(compositeContainer, catTypes);
    compositeContainer.appendChild(picker);
    body.appendChild(compositeContainer);

  } else {
    // ── Modo simples (tipo único) ───────────────────────────────────
    const builder = _NMBuilders[n.t];
    if (builder) {
      builder(n, body);
    } else {
      (def.fs || []).forEach(f => {
        const val = n.data[f.id] !== undefined ? n.data[f.id] : '';
        body.appendChild(_nmField(f.l, '',
          f.tp === 'area' ? _nmTA('nm-'+f.id, f.ph||'', val)
          : f.tp === 'sel' ? _nmSEL('nm-'+f.id, f.o||[], val)
          : _nmIN('nm-'+f.id, f.ph||'', val)));
      });
    }
  }

  // Rótulo do bloco (sempre no fundo)
  const nameRow = document.createElement('div'); nameRow.className = 'nm-name-field';
  nameRow.innerHTML = `<label>Rótulo</label><input id="nm-lbl" value="${n.lbl || def.n || ''}" placeholder="Nome do bloco...">`;
  body.appendChild(nameRow);

  document.getElementById('node-modal-overlay').classList.add('open');
}

// ── Guardar e fechar modal ─────────────────────────────────────────
function saveNodeModal() {
  if (!activeId) return;
  const n = NodeMap.get(activeId); if (!n) return;
  const def = DEF[n.t] || {};

  const catKey = _getCompositeCat(n.t);
  if (catKey) {
    // Colectar itens compostos
    const wrappers = document.querySelectorAll('#nm-composite-container .nm-composite-item');
    n.data._items = [...wrappers].map(w => _collectCompositeItem(w));

    // Rótulo
    const lbl = document.getElementById('nm-lbl');
    if (lbl) n.lbl = lbl.value;

    // Preview no canvas: rebuild completo com ícones por sub-tipo
    const domEl = nEl(activeId);
    if (domEl) {
      const catDef = _LIB_CATS.find(c => c.key === catKey);
      domEl.querySelector('.fb-node-lbl').textContent = n.lbl || (catDef ? catDef.label : def.n) || n.t;
      const _ITEM_ICONS_FB = {
        mensagem:'ti-message', imagem:'ti-photo', video:'ti-video',
        audio:'ti-microphone', documento:'ti-file', delay:'ti-clock',
        botao:'ti-layout-grid', lista:'ti-list', pergunta:'ti-help-circle',
        aguardar:'ti-clock', tag:'ti-tag', removertag:'ti-tag-off',
      };
      const bodyEl = domEl.querySelector('.fb-node-body');
      if (bodyEl && n.data._items && n.data._items.length) {
        bodyEl.innerHTML = n.data._items.map(it => {
          const itDef = DEF[it.type] || {};
          const ico = _ITEM_ICONS_FB[it.type] || itDef.ic || 'ti-circle';
          if (it.type === 'delay') {
            const secs = (it.data && it.data.secs) ? it.data.secs : '?';
            return `<div class="node-item-delay"><i class="ti ti-clock"></i> ${secs} segundo${secs==1?'':'s'}</div>`;
          }
          const firstField = itDef.fs && itDef.fs[0];
          let txt = (it.data && firstField ? it.data[firstField.id] : '') || itDef.d || it.type;
          if (txt.length > 32) txt = txt.slice(0,30) + '…';
          const itCol = itDef.c || '#00c8f0';
          return `<div class="node-item-row" style="--item-color:${itCol}"><span class="node-item-ico"><i class="ti ${ico}"></i></span><span class="node-item-txt">${txt}</span></div>`;
        }).join('');
      } else if (bodyEl) {
        bodyEl.innerHTML = `<span style="color:var(--k-muted);font-style:italic">Sem conteúdo</span>`;
      }
      // Re-posicionar portas após rebuild do body
      if (domEl._positionOutPorts) domEl._positionOutPorts();
    }
  } else {
    _nmCollect(n);
    // Actualizar nó no canvas
    const domEl = nEl(activeId);
    if (domEl) {
      domEl.querySelector('.fb-node-lbl').textContent = n.lbl || def.n || n.t;
      let prev = NodeTypeRegistry.getPreview(n);
      if (!prev && def.fs && def.fs[0]) prev = n.data[def.fs[0].id] || '';
      if (prev && prev.length > 55) prev = prev.slice(0, 53) + '…';
      domEl.querySelector('.fb-node-body').innerHTML =
        prev ? prev.replace(/</g,'&lt;')
             : `<span style="color:var(--k-muted);font-style:italic">${def.d || ''}</span>`;
      if (domEl._positionOutPorts) domEl._positionOutPorts();
    }
  }

  push();
  schedSave();
  toast('Guardado', 'ok');
  closeNodeModal();
}

function closeNodeModal() {
  document.getElementById('node-modal-overlay').classList.remove('open');
  activeId = null;
}

// ── Compatibilidade com chamadas existentes ─────────────────────────
function applyLive()   { /* no-op — substituído por saveNodeModal */ }
function applyPanel()  { saveNodeModal(); }
function closePanel()  { closeNodeModal(); }

// ─── Context menu ─────────────────────────────
let ctxNodeTarget = null;
let ctxClickPos   = null;

function showCtx(e, nid) {
  e.preventDefault(); e.stopPropagation();
  ctxNodeTarget = nid;
  const m = document.getElementById('ctx');
  m.style.left = e.clientX + 'px'; m.style.top = e.clientY + 'px';
  m.classList.add('open');
  document.getElementById('ctx-edit').style.display = '';
  document.addEventListener('mousedown', closeCtx, {once: true, capture: true});
}

function showCtxEmpty(e) {
  const m = document.getElementById('ctx');
  m.style.left = e.clientX + 'px'; m.style.top = e.clientY + 'px';
  m.classList.add('open');
  document.getElementById('ctx-edit').style.display = 'none';
  document.addEventListener('mousedown', closeCtx, {once: true, capture: true});
}

function closeCtx() { document.getElementById('ctx').classList.remove('open'); }

// ─── Node operations ──────────────────────────
function deleteSel() {
  if (!sel.size) return;
  // Remove edges connected to deleted nodes from _edgeIdSet
  edges.forEach(e => { if (sel.has(e.fr) || sel.has(e.to)) _edgeIdSet.delete(e.id); });
  nodes = nodes.filter(n => !sel.has(n.id));
  edges = edges.filter(e => !sel.has(e.fr) && !sel.has(e.to));
  sel.clear(); closePanel(); push(); render(); toast('Eliminado');
}

function duplicateSel() {
  const ids = Array.from(sel); const newSel = new Set();
  ids.forEach(id => {
    const n = NodeMap.get(id); if (!n) return;
    const nid = uid();
    nodes.push({...n, id: nid, x: n.x + 240, y: n.y + 30, data: {...n.data}});
    newSel.add(nid);
  });
  sel.clear(); newSel.forEach(id => sel.add(id));
  push(); render(); updateSel(); toast('Duplicado', 'ok');
}

function copyNodes() {
  clipboard = Array.from(sel).map(id => NodeMap.get(id)).filter(Boolean);
  toast(`${clipboard.length} bloco(s) copiado(s)`);
}

function pasteNodes() {
  if (!clipboard.length) return;
  sel.clear();
  clipboard.forEach(n => {
    const nid = uid();
    nodes.push({...n, id: nid, x: n.x + 240, y: n.y + 30, data: {...n.data}});
    sel.add(nid);
  });
  push(); render(); updateSel(); toast('Colado', 'ok');
}

// ─── Minimap ──────────────────────────────────
function drawMini() {
  const cv = document.getElementById('minimap'); if (!cv) return;
  if (!nodes.length) {
    // Fast clear when empty
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#0a0a0f'; ctx.fillRect(0, 0, 136, 86);
    return;
  }
  const ctx = cv.getContext('2d');
  const W = 136, H = 86;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0a0a0f'; ctx.fillRect(0, 0, W, H);

  const minX = Math.min(...nodes.map(n => n.x)) - 20;
  const minY = Math.min(...nodes.map(n => n.y)) - 20;
  const maxX = Math.max(...nodes.map(n => n.x + 215)) + 20;
  const maxY = Math.max(...nodes.map(n => n.y + 130)) + 20;
  const sc   = Math.min((W - 10) / (maxX - minX), (H - 10) / (maxY - minY));
  const ox   = 5 - minX * sc, oy = 5 - minY * sc;

  ctx.strokeStyle = '#0078f044'; ctx.lineWidth = 1;
  edges.forEach(e => {
    const fn = NodeMap.get(e.fr), tn = NodeMap.get(e.to);
    if (!fn || !tn) return;
    ctx.beginPath();
    ctx.moveTo(fn.x * sc + ox + 100 * sc, fn.y * sc + oy + 120 * sc);
    ctx.lineTo(tn.x * sc + ox + 100 * sc, tn.y * sc + oy);
    ctx.stroke();
  });

  nodes.forEach(n => {
    const def = DEF[n.t];
    ctx.fillStyle = (def?.c || '#0078f0') + '55';
    ctx.beginPath();
    ctx.roundRect(n.x * sc + ox, n.y * sc + oy, Math.max(8, 215 * sc), Math.max(5, 120 * sc), 2);
    ctx.fill();
    if (sel.has(n.id)) {
      ctx.strokeStyle = '#00c8f0'; ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.strokeStyle = '#0078f044'; ctx.lineWidth = 1; // reset for next edge
    }
  });

  const wrap = document.getElementById('fb-wrap'); if (!wrap) return;
  const r = wrap.getBoundingClientRect();
  ctx.strokeStyle = '#00c8f088'; ctx.lineWidth = 1.5;
  ctx.strokeRect(
    (-panX / zoom) * sc + ox, (-panY / zoom) * sc + oy,
    (r.width  / zoom) * sc,   (r.height / zoom) * sc
  );
}

// FASE 3.2.1 — _updateToolbarStatus removido: já não existe conceito de
// status (draft/published/archived).

// ─── Save & autosave ──────────────────────────
// schedSave é chamado pelo motor em cada mutação.
// Delega toda a lógica de persistência ao FlowRepository.
// saveTimer declarado no topo do ficheiro

// FASE 3.2.1 — NOTA: schedSave/doSave/fbSave estão duplicadas em
// js/repository.js, carregado DEPOIS deste ficheiro no index.html — é
// essa versão (com o indicador "Salvo automaticamente há X segundos")
// que está realmente activa em execução. Mantidas aqui apenas por
// compatibilidade com chamadas existentes neste ficheiro; não editar
// estas cópias sem também actualizar js/repository.js.

function schedSave() {
  const st = document.getElementById('fb-status');
  st.className = 'fb-save-status';
  st.innerHTML = '<i class="ti ti-circle-dashed" style="font-size:11px"></i> A guardar…';

  // Actualiza o nome a partir do input antes de persistir
  const nameEl = document.getElementById('fb-name');
  if (nameEl) FlowRepository.setName(nameEl.value);

  FlowRepository.commitState(nodes, edges);

  // Feedback visual após o debounce (1 400 ms + margem)
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const st2 = document.getElementById('fb-status');
    if (st2) {
      st2.className = 'fb-save-status saved';
      st2.innerHTML = '<i class="ti ti-check" style="font-size:11px"></i> Salvo automaticamente agora mesmo';
    }
  }, 1600);
}

function doSave() {
  // Persistência imediata (sem debounce) — para Ctrl+S e botão Salvar
  const nameEl = document.getElementById('fb-name');
  if (nameEl) FlowRepository.setName(nameEl.value);
  FlowRepository.commitState(nodes, edges, true);
  const st = document.getElementById('fb-status');
  if (st) {
    st.className = 'fb-save-status saved';
    st.innerHTML = '<i class="ti ti-check" style="font-size:11px"></i> Salvo automaticamente agora mesmo';
  }
}

function fbSave() { doSave(); toast('Fluxo guardado', 'ok'); }

/* ══════════════════════════════════════════════════════════════════════
   FASE 2.7 — WorkflowEngine  (Modo Design — sem execução)
   ────────────────────────────────────────────────────────────────────
   Analisa e valida a estrutura do fluxo.
   Não envia mensagens, não chama APIs, não processa automações.

   Será consumido por:
     • ExecutorEngine   — execução real de automações
     • WhatsApp Engine  — envio de mensagens
     • FlowSimulator    — simulação de caminhos
     • Firebase Functions — execução serverless
   ══════════════════════════════════════════════════════════════════════ */
const WorkflowEngine = (() => {

  /* ─── Internal helpers ─────────────────────────────────────────── */

  /**
   * Builds a lightweight adjacency representation from the live
   * nodes[] / edges[] arrays.  All methods accept this object so
   * callers can pass a snapshot instead of the live state (useful
   * for the future ExecutorEngine running inside Firebase Functions).
   *
   * @param {object} flow  { nodes: [], edges: [] }
   * @returns {object} graph context
   */
  function _buildGraph(flow) {
    const ns = flow.nodes || [];
    const es = flow.edges || [];

    // O(1) node lookup
    const nodeById = new Map(ns.map(n => [n.id, n]));

    // out-edges per node:  nodeId → [edge, …]
    const outEdges = new Map(ns.map(n => [n.id, []]));
    // in-edges per node:   nodeId → [edge, …]
    const inEdges  = new Map(ns.map(n => [n.id, []]));

    es.forEach(e => {
      if (outEdges.has(e.fr)) outEdges.get(e.fr).push(e);
      if (inEdges.has(e.to))  inEdges.get(e.to).push(e);
    });

    return { ns, es, nodeById, outEdges, inEdges };
  }

  /* ─── Public API ───────────────────────────────────────────────── */

  /**
   * getStartNodes(flow)
   * Returns every node that has no incoming edges (potential entry points).
   */
  function getStartNodes(flow) {
    const { ns, inEdges } = _buildGraph(flow);
    return ns.filter(n => (inEdges.get(n.id) || []).length === 0);
  }

  /**
   * getEndNodes(flow)
   * Returns every node that has no outgoing edges (potential exit points).
   */
  function getEndNodes(flow) {
    const { ns, outEdges } = _buildGraph(flow);
    return ns.filter(n => (outEdges.get(n.id) || []).length === 0);
  }

  /**
   * getNextNodes(nodeId, flow)
   * Returns the direct successor nodes of nodeId.
   */
  function getNextNodes(nodeId, flow) {
    const { outEdges, nodeById } = _buildGraph(flow);
    return (outEdges.get(nodeId) || [])
      .map(e => nodeById.get(e.to))
      .filter(Boolean);
  }

  /**
   * getPreviousNodes(nodeId, flow)
   * Returns the direct predecessor nodes of nodeId.
   */
  function getPreviousNodes(nodeId, flow) {
    const { inEdges, nodeById } = _buildGraph(flow);
    return (inEdges.get(nodeId) || [])
      .map(e => nodeById.get(e.fr))
      .filter(Boolean);
  }

  /**
   * getExecutionPath(startNodeId, flow)
   * Returns an ordered list of nodes along the primary (first-edge) path
   * from startNodeId to any end node.  Cycle-safe via visited set.
   * Returns { path: [node…], truncated: bool }
   */
  function getExecutionPath(startNodeId, flow) {
    const { outEdges, nodeById } = _buildGraph(flow);
    const visited = new Set();
    const path    = [];
    let   cur     = startNodeId;

    while (cur !== undefined && cur !== null) {
      if (visited.has(cur)) {
        // Cycle detected — stop traversal but flag it
        return { path, truncated: true, cycleAt: cur };
      }
      visited.add(cur);
      const node = nodeById.get(cur);
      if (!node) break;
      path.push(node);

      const nexts = outEdges.get(cur) || [];
      cur = nexts.length ? nexts[0].to : null;
    }
    return { path, truncated: false, cycleAt: null };
  }

  /**
   * getAllPaths(startNodeId, flow)
   * DFS enumeration of ALL paths from a start node.
   * Returns an array of paths, each path being an array of node IDs.
   * Caps at MAX_PATHS to prevent combinatorial explosion.
   */
  const MAX_PATHS = 64;

  function getAllPaths(startNodeId, flow) {
    const { outEdges } = _buildGraph(flow);
    const results = [];
    const stack   = [[startNodeId, new Set([startNodeId])]];

    while (stack.length && results.length < MAX_PATHS) {
      const [cur, visited] = stack.pop();
      const nexts = (outEdges.get(cur) || []).map(e => e.to);

      if (!nexts.length) {
        // Leaf — record path
        results.push([...visited]);
        continue;
      }

      for (const nxt of nexts) {
        if (visited.has(nxt)) {
          // Cycle — record truncated path
          results.push([...visited, `⟳${nxt}`]);
        } else {
          const newVisited = new Set(visited);
          newVisited.add(nxt);
          stack.push([nxt, newVisited]);
        }
      }
    }
    return results;
  }

  /* ─── Validation ───────────────────────────────────────────────── */

  /**
   * validate(flow)
   * Structural validation — returns:
   * {
   *   valid: bool,
   *   errors:   [{ code, message, nodeIds? }],
   *   warnings: [{ code, message, nodeIds? }],
   * }
   *
   * Checks:
   *   CYCLE          — infinite loop
   *   ORPHAN         — node with no edges at all
   *   ISOLATED       — node with in-edges but no out-edges and not type 'encerrar'
   *   NO_START       — no trigger/start node
   *   MULTI_START    — more than one trigger node
   *   INVALID_EDGE   — edge pointing to non-existent node
   *   NODE_INVALID   — node fails NodeTypeRegistry validation
   *   UNCONNECTED_PORT — output port defined but never connected
   */
  function validate(flow) {
    const { ns, es, nodeById, outEdges, inEdges } = _buildGraph(flow);
    const errors   = [];
    const warnings = [];

    if (!ns.length) {
      return { valid: false, errors: [{ code:'EMPTY', message:'O fluxo está vazio' }], warnings: [] };
    }

    // ── INVALID_EDGE ─────────────────────────────────────────────
    es.forEach(e => {
      if (!nodeById.has(e.fr)) {
        errors.push({ code:'INVALID_EDGE', message:`Conexão ${e.id}: nó origem ${e.fr} não existe`, nodeIds:[e.fr] });
      }
      if (!nodeById.has(e.to)) {
        errors.push({ code:'INVALID_EDGE', message:`Conexão ${e.id}: nó destino ${e.to} não existe`, nodeIds:[e.to] });
      }
    });

    // ── CYCLE detection (DFS with colour marking) ─────────────────
    // colour: 0=white, 1=grey (in stack), 2=black (done)
    const colour = new Map(ns.map(n => [n.id, 0]));
    const cycleNodes = new Set();

    function _dfs(nid) {
      colour.set(nid, 1);
      for (const e of (outEdges.get(nid) || [])) {
        const c = colour.get(e.to);
        if (c === 1) {
          cycleNodes.add(e.to);
          cycleNodes.add(nid);
        } else if (c === 0 && nodeById.has(e.to)) {
          _dfs(e.to);
        }
      }
      colour.set(nid, 2);
    }
    ns.forEach(n => { if (colour.get(n.id) === 0) _dfs(n.id); });

    if (cycleNodes.size) {
      errors.push({
        code: 'CYCLE',
        message: `Ciclo infinito detectado envolvendo ${cycleNodes.size} bloco(s)`,
        nodeIds: [...cycleNodes],
      });
    }

    // ── ORPHAN (no edges at all) ─────────────────────────────────
    const orphans = ns.filter(n =>
      (inEdges.get(n.id)||[]).length === 0 &&
      (outEdges.get(n.id)||[]).length === 0
    );
    orphans.forEach(n => {
      warnings.push({ code:'ORPHAN', message:`Bloco "${n.lbl||n.t}" não tem conexões`, nodeIds:[n.id] });
    });

    // ── NO_START / MULTI_START ───────────────────────────────────
    const startNodes = ns.filter(n => n.t === 'inicio');
    // FASE 5.3 — diagnóstico
    console.log(`[FLOW VALIDATION] Inicios encontrados: ${startNodes.length}`);
    if (!startNodes.length) {
      errors.push({ code:'NO_START', message:'Nenhum bloco de Início encontrado' });
    } else if (startNodes.length > 1) {
      errors.push({
        code:'MULTI_START',
        message:'Este fluxo possui múltiplos blocos Início. Remova os duplicados.',
        nodeIds: startNodes.map(n=>n.id),
      });
    }

    // ── ISOLATED (in-edges but no out-edges, not an end type) ───
    const endTypes = new Set(['encerrar']);
    const isolated = ns.filter(n =>
      (outEdges.get(n.id)||[]).length === 0 &&
      (inEdges.get(n.id)||[]).length  >  0 &&
      !endTypes.has(n.t)
    );
    isolated.forEach(n => {
      warnings.push({
        code:'ISOLATED',
        message:`Bloco "${n.lbl||n.t}" não tem saída mas não é um bloco de Fim`,
        nodeIds:[n.id],
      });
    });

    // ── NODE_INVALID (via NodeTypeRegistry) ─────────────────────
    ns.forEach(n => {
      const vcheck = NodeTypeRegistry.validate(n);
      if (!vcheck.valid) {
        errors.push({
          code:'NODE_INVALID',
          message:`"${n.lbl||n.t}": ${vcheck.errors.join('; ')}`,
          nodeIds:[n.id],
        });
      }
    });

    // ── UNCONNECTED_PORT ─────────────────────────────────────────
    ns.forEach(n => {
      const def = DEF[n.t]; if (!def || !def.outs || !def.outs.length) return;
      // Para botao/lista: usar outs do nó (dados reais)
      let nodeOuts = def.outs;
      if (n.t === 'botao' && n.data && n.data.btns) {
        const btns = n.data.btns.split('\n').map(b => b.trim()).filter(Boolean);
        if (btns.length > 0) nodeOuts = btns;
      } else if (n.t === 'lista' && n.data && n.data.items) {
        const its = n.data.items.split('\n').map(b => b.trim()).filter(Boolean);
        if (its.length > 0) nodeOuts = its;
      }
      nodeOuts.forEach(port => {
        const connected = (outEdges.get(n.id)||[]).some(e => e.fp === port);
        if (!connected) {
          warnings.push({
            code:'UNCONNECTED_PORT',
            message:`"${n.lbl||n.t}" — porta "${port}" não está ligada`,
            nodeIds:[n.id],
          });
        }
      });
    });

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /* ─── Analysis ─────────────────────────────────────────────────── */

  /**
   * analyse(flow)
   * Returns a full diagnostic report:
   * {
   *   stats:       { nodeCount, edgeCount, depth, pathCount, typeBreakdown }
   *   startNodes:  [node…]
   *   endNodes:    [node…]
   *   validation:  { valid, errors, warnings }
   *   paths:       [[nodeId…]…]  (up to MAX_PATHS)
   *   executionPath: { path, truncated, cycleAt }  (from first start node)
   *   timestamp:   ISO string
   * }
   */
  function analyse(flow) {
    const { ns, es, outEdges } = _buildGraph(flow);

    // ── Depth (longest path from any start) ─────────────────────
    const starts = getStartNodes(flow);
    let depth = 0;
    let pathCount = 0;
    let longestPath = [];

    starts.forEach(s => {
      const allP = getAllPaths(s.id, flow);
      pathCount += allP.length;
      allP.forEach(p => {
        if (p.length > depth) {
          depth = p.length;
          longestPath = p;
        }
      });
    });

    // ── Type breakdown ───────────────────────────────────────────
    const typeBreakdown = {};
    ns.forEach(n => { typeBreakdown[n.t] = (typeBreakdown[n.t] || 0) + 1; });

    // ── ExecutorHints summary ────────────────────────────────────
    const executorHints = {};
    ns.forEach(n => {
      const hint = NodeTypeRegistry.getExecutorHint(n.t);
      if (hint) executorHints[hint] = (executorHints[hint] || 0) + 1;
    });

    // ── Primary execution path ───────────────────────────────────
    const execPath = starts.length
      ? getExecutionPath(starts[0].id, flow)
      : { path: [], truncated: false, cycleAt: null };

    return {
      stats: {
        nodeCount:     ns.length,
        edgeCount:     es.length,
        depth,
        pathCount:     Math.min(pathCount, MAX_PATHS),
        pathsCapped:   pathCount >= MAX_PATHS,
        typeBreakdown,
        executorHints,
      },
      startNodes:    getStartNodes(flow),
      endNodes:      getEndNodes(flow),
      validation:    validate(flow),
      paths:         starts.length ? getAllPaths(starts[0].id, flow) : [],
      executionPath: execPath,
      longestPath,
      timestamp:     new Date().toISOString(),
    };
  }

  /* ─── Diagnostic helpers ────────────────────────────────────────── */

  /**
   * highlight(nodeIds)
   * Pulses the specified nodes on the canvas for visual feedback.
   * Does not alter state — purely cosmetic.
   */
  function highlight(nodeIds) {
    nodeIds.forEach(id => {
      const el = document.querySelector(`.fb-node[data-nid="${id}"]`);
      if (!el) return;
      el.classList.add('wf-highlight');
      setTimeout(() => el.classList.remove('wf-highlight'), 1800);
    });
  }

  /**
   * focusNode(nodeId)
   * Pans+zooms the canvas so the node is centred.
   */
  function focusNode(nodeId) {
    const n = NodeMap.get(nodeId); if (!n) return;
    const wrap = document.getElementById('fb-wrap');
    if (!wrap) return;
    const r = wrap.getBoundingClientRect();
    zoom = 1;
    panX = r.width  / 2 - n.x - 107;
    panY = r.height / 2 - n.y - 60;
    updateTransform();
    setTimeout(() => {
      const el = document.querySelector(`.fb-node[data-nid="${nodeId}"]`);
      if (el) { el.classList.add('wf-highlight'); setTimeout(() => el.classList.remove('wf-highlight'), 1800); }
    }, 80);
  }

  return {
    getStartNodes,
    getEndNodes,
    getNextNodes,
    getPreviousNodes,
    getExecutionPath,
    getAllPaths,
    validate,
    analyse,
    highlight,
    focusNode,
  };
})();

/* ─── Diagnostic UI ─────────────────────────────────────────────────
   Renders the WorkflowEngine.analyse() report into the overlay panel.
   No business logic here — pure presentation layer.
   ─────────────────────────────────────────────────────────────────── */

function fbAnalyse() {
  const flow   = { nodes, edges };
  const report = WorkflowEngine.analyse(flow);
  // FASE 5.3 — Actualizar destaque visual de nós inicio duplicados
  const multiStart = (report.validation.errors || []).find(e => e.code === 'MULTI_START');
  setMultiStartErrors(multiStart ? multiStart.nodeIds : []);
  _renderWfDiag(report);
  document.getElementById('wf-overlay').classList.add('open');
}

function closeWfDiag() {
  document.getElementById('wf-overlay').classList.remove('open');
}

function fbTest() {
  // fbTest now runs a quick structural validation and reports via toast
  const report = WorkflowEngine.analyse({ nodes, edges });
  const v = report.validation;
  // FASE 5.3 — Actualizar destaque visual de nós inicio duplicados
  const multiStart = (v.errors || []).find(e => e.code === 'MULTI_START');
  setMultiStartErrors(multiStart ? multiStart.nodeIds : []);
  if (!v.valid) {
    toast(`${v.errors.length} erro(s) no fluxo — clique Analisar`, 'err');
  } else if (v.warnings.length) {
    toast(`Fluxo OK · ${v.warnings.length} aviso(s) — clique Analisar`);
  } else {
    toast(`Fluxo válido · ${report.stats.nodeCount} blocos · ${report.stats.pathCount} caminho(s) ✓`, 'ok');
  }
}

function _renderWfDiag(report) {
  const body  = document.getElementById('wf-body');
  const badge = document.getElementById('wf-badge');
  body.innerHTML = '';

  const v = report.validation;
  const s = report.stats;

  // Badge
  if (!v.valid) {
    badge.textContent = `${v.errors.length} erro(s)`;
    badge.className   = 'wf-badge err';
  } else if (v.warnings.length) {
    badge.textContent = `${v.warnings.length} aviso(s)`;
    badge.className   = 'wf-badge warn';
  } else {
    badge.textContent = 'Válido';
    badge.className   = 'wf-badge';
  }

  // ── Stats ────────────────────────────────────────────────────
  const sec1 = _wfSection(body, 'Estatísticas');
  const grid  = document.createElement('div');
  grid.className = 'wf-stat-grid';
  [
    ['Blocos',       s.nodeCount],
    ['Conexões',     s.edgeCount],
    ['Profundidade', s.depth],
    ['Caminhos',     s.pathsCapped ? `${s.pathCount}+` : s.pathCount],
  ].forEach(([lbl, val]) => {
    grid.innerHTML += `<div class="wf-stat"><div class="wf-stat-label">${lbl}</div><div class="wf-stat-val">${val}</div></div>`;
  });
  sec1.appendChild(grid);

  // Type breakdown
  const typeRows = Object.entries(s.typeBreakdown)
    .sort((a,b) => b[1]-a[1])
    .map(([t,c]) => {
      const def = DEF[t];
      return `<span style="font-size:11px;color:var(--k-muted)">${def?def.n:t}</span><span style="margin-left:auto;font-size:11px;font-weight:500">${c}</span>`;
    });
  if (typeRows.length) {
    const tb = document.createElement('div');
    tb.style.cssText = 'display:flex;flex-direction:column;gap:3px;margin-top:6px';
    typeRows.forEach(r => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;padding:3px 6px;background:var(--k-surface2);border-radius:4px';
      row.innerHTML = r;
      tb.appendChild(row);
    });
    sec1.appendChild(tb);
  }

  // ── Errors ───────────────────────────────────────────────────
  if (v.errors.length) {
    const sec2 = _wfSection(body, `Erros (${v.errors.length})`);
    const ul = document.createElement('ul'); ul.className = 'wf-list';
    v.errors.forEach(e => {
      const li = _wfListItem('ti-circle-x', 'wf-err', e.message, e.nodeIds);
      ul.appendChild(li);
    });
    sec2.appendChild(ul);
  }

  // ── Warnings ─────────────────────────────────────────────────
  if (v.warnings.length) {
    const sec3 = _wfSection(body, `Avisos (${v.warnings.length})`);
    const ul = document.createElement('ul'); ul.className = 'wf-list';
    v.warnings.forEach(w => {
      const li = _wfListItem('ti-alert-triangle', 'wf-warn', w.message, w.nodeIds);
      ul.appendChild(li);
    });
    sec3.appendChild(ul);
  }

  // ── All clear ────────────────────────────────────────────────
  if (v.valid && !v.warnings.length) {
    const sec2 = _wfSection(body, 'Validação');
    const ok = document.createElement('div');
    ok.className = 'wf-list';
    ok.innerHTML = `<li class="wf-ok"><span class="wf-li-icon ti ti-circle-check"></span> Fluxo sem erros ou avisos</li>`;
    sec2.appendChild(ok);
  }

  // ── Entry & exit nodes ───────────────────────────────────────
  const sec4 = _wfSection(body, 'Pontos de Entrada & Saída');
  const eeSec = document.createElement('div');
  eeSec.style.cssText = 'display:flex;flex-direction:column;gap:8px';

  const startWrap = document.createElement('div');
  startWrap.innerHTML = '<div style="font-size:10px;color:var(--k-muted);margin-bottom:4px">ENTRADA</div>';
  const startPills = document.createElement('div'); startPills.style.cssText='display:flex;gap:4px;flex-wrap:wrap';
  if (report.startNodes.length) {
    report.startNodes.forEach(n => startPills.appendChild(_wfPill(n)));
  } else {
    startPills.innerHTML = '<span class="wf-empty">Nenhum</span>';
  }
  startWrap.appendChild(startPills);
  eeSec.appendChild(startWrap);

  const endWrap = document.createElement('div');
  endWrap.innerHTML = '<div style="font-size:10px;color:var(--k-muted);margin-bottom:4px">SAÍDA</div>';
  const endPills = document.createElement('div'); endPills.style.cssText='display:flex;gap:4px;flex-wrap:wrap';
  if (report.endNodes.length) {
    report.endNodes.forEach(n => endPills.appendChild(_wfPill(n)));
  } else {
    endPills.innerHTML = '<span class="wf-empty">Nenhum</span>';
  }
  endWrap.appendChild(endPills);
  eeSec.appendChild(endWrap);
  sec4.appendChild(eeSec);

  // ── Primary execution path ───────────────────────────────────
  if (report.executionPath.path.length) {
    const sec5 = _wfSection(body, 'Caminho Principal');
    if (report.executionPath.truncated) {
      const warn = document.createElement('div');
      warn.style.cssText = 'font-size:10px;color:#f59e0b;margin-bottom:6px';
      warn.innerHTML = '<i class="ti ti-alert-triangle"></i> Ciclo detectado — caminho truncado';
      sec5.appendChild(warn);
    }
    const pathRow = document.createElement('div');
    pathRow.className = 'wf-path-row';
    report.executionPath.path.forEach((n, i) => {
      pathRow.appendChild(_wfPill(n));
      if (i < report.executionPath.path.length - 1) {
        const arr = document.createElement('span');
        arr.className = 'wf-path-arrow'; arr.textContent = '→';
        pathRow.appendChild(arr);
      }
    });
    sec5.appendChild(pathRow);
  }

  // ── Timestamp ────────────────────────────────────────────────
  const ts = document.createElement('div');
  ts.style.cssText = 'font-size:10px;color:var(--k-muted);text-align:right;padding-top:8px;border-top:0.5px solid var(--k-border);margin-top:8px';
  ts.textContent = 'Análise: ' + new Date(report.timestamp).toLocaleTimeString('pt-MZ');
  body.appendChild(ts);
}

/* Helpers for diagnostic UI */
function _wfSection(parent, title) {
  const sec = document.createElement('div'); sec.className = 'wf-section';
  const h   = document.createElement('div'); h.className = 'wf-section-title'; h.textContent = title;
  sec.appendChild(h);
  parent.appendChild(sec);
  return sec;
}

function _wfListItem(icon, cls, message, nodeIds) {
  const li = document.createElement('li'); li.className = cls;
  const ic = document.createElement('i'); ic.className = `ti ${icon} wf-li-icon`;
  const txt = document.createElement('span'); txt.style.flex='1';

  // Node pills
  const pillsHtml = (nodeIds||[]).map(id => {
    const n = NodeMap.get(id);
    return n ? `<span class="wf-node-pill" onclick="WorkflowEngine.focusNode(${id});closeWfDiag()"><i class="ti ti-crosshair" style="font-size:9px"></i>${n.lbl||n.t}</span>` : '';
  }).join(' ');

  txt.innerHTML = message + (pillsHtml ? '<br><span style="display:flex;gap:3px;flex-wrap:wrap;margin-top:3px">' + pillsHtml + '</span>' : '');
  li.appendChild(ic); li.appendChild(txt);
  return li;
}

function _wfPill(node) {
  const pill = document.createElement('span');
  pill.className = 'wf-node-pill';
  pill.title = node.t;
  const def = DEF[node.t];
  pill.innerHTML = `<i class="ti ${def?def.ic:'ti-box'}" style="font-size:9px"></i>${node.lbl||node.t}`;
  pill.onclick = () => { WorkflowEngine.focusNode(node.id); closeWfDiag(); };
  return pill;
}


/* ══════════════════════════════════════════════════════════════════════
   FASE 2.8 — FlowSimulator
   ────────────────────────────────────────────────────────────────────
   Simula o percurso de um fluxo sem enviar mensagens, executar APIs,
   webhooks ou qualquer comunicação com o WhatsApp.

   Integra-se com:
     • WorkflowEngine  — validação e construção do grafo
     • NodeTypeRegistry — preview e metadados dos blocos
     • ExecutorEngine  — preparado para integração futura

   NÃO executa:
     • Mensagens reais
     • APIs / Webhooks
     • WhatsApp
   ══════════════════════════════════════════════════════════════════════ */

// ─── FASE 2.5 — buildPalette (mantida para compatibilidade) ────────
// A palette lateral de ícones foi substituída pelo block-lib sidebar.
// Esta função é chamada em app.js no DOMContentLoaded — não deve causar erros.
// O backdrop de fecho é aqui injectado para não precisar de mais HTML.
function buildPalette() {
  // Injectar backdrop se ainda não existir
  if (!document.getElementById('block-lib-backdrop')) {
    const bd = document.createElement('div');
    bd.id        = 'block-lib-backdrop';
    bd.className = 'block-lib-backdrop';
    bd.addEventListener('click', closeBlockLib);
    const fbBody = document.querySelector('.fb-body');
    if (fbBody) fbBody.insertBefore(bd, fbBody.firstChild);
  }
  // Conectar input de pesquisa
  const inp = document.getElementById('block-lib-q');
  if (inp) {
    inp.addEventListener('input',   e => renderBlockLib(e.target.value));
    inp.addEventListener('keydown', e => { if (e.key === 'Escape') closeBlockLib(); });
  }
  // FASE 2.7 — Activar clique no minimap para pan
  if (typeof _initMinimapClick === 'function') _initMinimapClick();
}

// ─── Keyboard shortcuts ───────────────────────
document.addEventListener('keydown', e => {
  const vf = document.getElementById('view-flows');
  if (!vf || !vf.classList.contains('active')) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selEdge) { deleteSelEdge(); return; }
    deleteSel(); return;
  }
  if ((e.ctrlKey||e.metaKey) && !e.shiftKey && e.key === 'z') { e.preventDefault(); fbUndo(); return; }
  if ((e.ctrlKey||e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); fbRedo(); return; }
  if ((e.ctrlKey||e.metaKey) && e.key === 'c') { copyNodes(); return; }
  if ((e.ctrlKey||e.metaKey) && e.key === 'v') { pasteNodes(); return; }
  if ((e.ctrlKey||e.metaKey) && e.key === 'd') { e.preventDefault(); duplicateSel(); return; }
  if ((e.ctrlKey||e.metaKey) && e.key === 'a') { e.preventDefault(); nodes.forEach(n => sel.add(n.id)); updateSel(); return; }
  if ((e.ctrlKey||e.metaKey) && e.key === 's') { e.preventDefault(); fbSave(); return; }
  if (e.key === 'a' || e.key === 'A') { openBlockLib(); return; }
  if (e.key === 'l' || e.key === 'L') { fbAutoLayout(); return; }
  if (e.key === 'f' || e.key === 'F') { fbFit(); return; }
  if (e.key === 'd' || e.key === 'D') { fbAnalyse(); return; }
  if (e.key === '=' || e.key === '+') { fbZoom(0.1); return; }
  if (e.key === '-') { fbZoom(-0.1); return; }
  if (e.key === '0') { zoom = 1; panX = 80; panY = 60; updateTransform(); return; }
  if (e.key === 'Escape') {
    closePanel();
    closeBlockLib();
    closeWfDiag();
    sel.clear(); updateSel();
    document.getElementById('ctx').classList.remove('open');
    closeEdgeCtx();
    if (selEdge) { selEdge = null; renderEdges(); }
  }
});

// ─── Context menu actions ─────────────────────
document.getElementById('ctx-edit').addEventListener('click', () => {
  if (ctxNodeTarget) { sel.clear(); sel.add(ctxNodeTarget); updateSel(); openPanel(ctxNodeTarget); }
  closeCtx();
});
document.getElementById('ctx-dup').addEventListener('click', () => { if (ctxNodeTarget) { sel.clear(); sel.add(ctxNodeTarget); } duplicateSel(); closeCtx(); });
document.getElementById('ctx-copy').addEventListener('click', () => { if (ctxNodeTarget) { sel.clear(); sel.add(ctxNodeTarget); } copyNodes(); closeCtx(); });
document.getElementById('ctx-paste').addEventListener('click', () => { pasteNodes(); closeCtx(); });
document.getElementById('ctx-del').addEventListener('click', () => { if (ctxNodeTarget) { sel.clear(); sel.add(ctxNodeTarget); } deleteSel(); closeCtx(); });
document.getElementById('ctx-add').addEventListener('click', () => {
  let pos = null;
  if (ctxClickPos) {
    const wr = document.getElementById('fb-wrap').getBoundingClientRect();
    pos = {
      x: Math.round((ctxClickPos.clientX - wr.left - panX) / zoom / 20) * 20,
      y: Math.round((ctxClickPos.clientY - wr.top  - panY) / zoom / 20) * 20,
    };
  }
  closeCtx(); openBlockLib(pos);
});

// ─── Picker search ────────────────────────────
// FASE 2.5 — picker-q substituído por block-lib-q (wired in buildPalette)

// ─── Flow name autosave ───────────────────────
document.getElementById('fb-name').addEventListener('input', schedSave);

/* ══════════════════════════════════════════════════════════════════════
   FASE 2.9 — FlowPublisher
   ────────────────────────────────────────────────────────────────────
   Gere o ciclo de vida dos fluxos: publicar, arquivar, duplicar,
   criar novo. Toda a lógica passa pelo FlowRepository + FlowStorage.
   Nenhuma comunicação externa é feita aqui.
   ══════════════════════════════════════════════════════════════════════ */