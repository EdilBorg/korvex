/* ══════════════════════════════════════════════════════════════════════
   Analytics — Vista premium de métricas reais do workspace
   ────────────────────────────────────────────────────────────────────
   Toda a agregação acontece no SERVIDOR (server/analytics/analyticsService.js).
   Este módulo apenas pede dados já calculados via HTTP e renderiza.
   Nunca usa números fictícios — onde não há dados, mostra estado vazio.

   Rotas consumidas:
     GET /accounts/:uid/analytics?range=today|7d|30d|90d
     GET /accounts/:uid/analytics/credits
     GET /accounts/:uid/analytics/export?range=...&format=csv|excel
   ══════════════════════════════════════════════════════════════════════ */

const AnalyticsView = (() => {

  const BACKEND_URL = window._KORVEX_BACKEND_URL || 'http://localhost:3001';

  let _uid          = null;
  let _range        = 'today';
  let _data         = null;
  let _creditsData  = null;
  let _loading      = false;

  // ── Helpers ────────────────────────────────────────────────────────
  function _fmt(n) {
    if (n === null || n === undefined) return '—';
    return Number(n).toLocaleString('pt-PT');
  }

  function _fmtMs(ms) {
    if (ms === null || ms === undefined) return null;
    if (ms < 60000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3600000) return `${Math.round(ms / 60000)}min`;
    const h = Math.floor(ms / 3600000);
    const m = Math.round((ms % 3600000) / 60000);
    return `${h}h${m > 0 ? ' ' + m + 'min' : ''}`;
  }

  function _emptyVal(val, fallback) {
    return (val === null || val === undefined || val === 0)
      ? `<span class="an-kpi-val empty">${fallback || 'Sem dados'}</span>`
      : `<span class="an-kpi-val">${val}</span>`;
  }

  const WEEKDAY_NAMES  = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  const WEEKDAY_LONG   = ['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];

  // ── Fetch ──────────────────────────────────────────────────────────
  async function _fetchAnalytics(range) {
    const res  = await fetch(`${BACKEND_URL}/accounts/${_uid}/analytics?range=${range}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Erro ao carregar analytics');
    return data;
  }

  async function _fetchCredits() {
    const res  = await fetch(`${BACKEND_URL}/accounts/${_uid}/analytics/credits`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Erro ao carregar tokens');
    return data;
  }

  async function _loadAll() {
    if (!_uid || _loading) return;
    _loading = true;
    try {
      const [analytics, creditsRes] = await Promise.all([
        _fetchAnalytics(_range),
        _fetchCredits(),
      ]);
      _data        = analytics;
      _creditsData = creditsRes;
      _render();
    } catch (e) {
      console.error('[AnalyticsView] Erro ao carregar:', e.message);
      _showError(e.message);
    } finally {
      _loading = false;
    }
  }

  // ── Secção 1: Visão Geral ─────────────────────────────────────────
  function _renderOverview(o) {
    const avgResp = o.avg_response_time_ms !== null ? _fmtMs(o.avg_response_time_ms) : null;

    return `
      <div class="an-section">
        <div class="an-section-head">
          <i class="ti ti-layout-grid"></i>
          <span class="an-section-title">Visão Geral</span>
        </div>
        <div class="an-kpi-grid">
          <div class="an-kpi-card">
            <div class="an-kpi-label">Mensagens recebidas</div>
            ${_emptyVal(o.total_messages_received > 0 ? _fmt(o.total_messages_received) : null)}
          </div>
          <div class="an-kpi-card">
            <div class="an-kpi-label">Mensagens enviadas</div>
            ${_emptyVal(o.total_messages_sent > 0 ? _fmt(o.total_messages_sent) : null)}
          </div>
          <div class="an-kpi-card">
            <div class="an-kpi-label">Total de conversas</div>
            ${_emptyVal(o.total_conversations > 0 ? _fmt(o.total_conversations) : null)}
          </div>
          <div class="an-kpi-card">
            <div class="an-kpi-label">Iniciadas hoje</div>
            ${_emptyVal(o.conversations_started_today > 0 ? _fmt(o.conversations_started_today) : null, '0')}
          </div>
          <div class="an-kpi-card">
            <div class="an-kpi-label">Conversas finalizadas</div>
            ${_emptyVal(o.conversations_finished > 0 ? _fmt(o.conversations_finished) : null, '0')}
          </div>
          <div class="an-kpi-card">
            <div class="an-kpi-label">Tempo médio de resposta</div>
            ${_emptyVal(avgResp)}
          </div>
          <div class="an-kpi-card">
            <div class="an-kpi-label">Msgs por conversa</div>
            ${_emptyVal(o.avg_messages_per_conversation > 0 ? o.avg_messages_per_conversation : null)}
          </div>
        </div>
      </div>`;
  }

  // ── Secção 2: Evolução diária (canvas nativo, sem libs externas) ──
  function _drawLineChart(canvas, series) {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const padL = 36, padR = 10, padT = 14, padB = 24;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const datasets = [
      { key: 'messages',     color: '#0078f0', label: 'Mensagens' },
      { key: 'conversations',color: '#22c55e', label: 'Conversas' },
      { key: 'ai_usage',     color: '#818cf8', label: 'Uso IA',  scale: true },
    ];

    const maxMsg  = Math.max(...series.map(s => s.messages), 1);
    const maxConv = Math.max(...series.map(s => s.conversations), 1);
    const maxAi   = Math.max(...series.map(s => s.ai_usage), 1);
    const maxVal  = Math.max(maxMsg, maxConv);

    // Grid horizontal
    ctx.strokeStyle = 'rgba(26,42,68,.5)';
    ctx.lineWidth = 1;
    const gridLines = 4;
    for (let i = 0; i <= gridLines; i++) {
      const y = padT + (plotH / gridLines) * i;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(W - padR, y);
      ctx.stroke();

      const val = Math.round(maxVal - (maxVal / gridLines) * i);
      ctx.fillStyle = '#4a6080';
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(val, padL - 6, y + 3);
    }

    const stepX = series.length > 1 ? plotW / (series.length - 1) : plotW;

    // Desenhar cada linha (mensagens e conversas na mesma escala; IA escalada à parte)
    [datasets[0], datasets[1]].forEach(ds => {
      ctx.beginPath();
      ctx.strokeStyle = ds.color;
      ctx.lineWidth = 2;
      series.forEach((s, i) => {
        const x = padL + stepX * i;
        const y = padT + plotH - (s[ds.key] / maxVal) * plotH;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();

      // Pontos
      ctx.fillStyle = ds.color;
      series.forEach((s, i) => {
        const x = padL + stepX * i;
        const y = padT + plotH - (s[ds.key] / maxVal) * plotH;
        ctx.beginPath();
        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      });
    });

    // Linha IA — escala própria, tracejada
    if (maxAi > 0) {
      ctx.beginPath();
      ctx.strokeStyle = '#818cf8';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      series.forEach((s, i) => {
        const x = padL + stepX * i;
        const y = padT + plotH - (s.ai_usage / maxAi) * plotH;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Labels eixo X (mostrar no máximo ~7 labels para não sobrepor)
    ctx.fillStyle = '#4a6080';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    const labelEvery = Math.max(1, Math.ceil(series.length / 7));
    series.forEach((s, i) => {
      if (i % labelEvery !== 0 && i !== series.length - 1) return;
      const x = padL + stepX * i;
      const [, m, d] = s.key.split('-');
      ctx.fillText(`${d}/${m}`, x, H - 6);
    });
  }

  function _renderDailyEvolution(series) {
    const hasData = series.some(s => s.messages > 0 || s.conversations > 0 || s.ai_usage > 0);

    return `
      <div class="an-section">
        <div class="an-section-head">
          <i class="ti ti-chart-bar"></i>
          <span class="an-section-title">Evolução Diária</span>
        </div>
        <div class="an-chart-card">
          ${hasData ? `
            <div class="an-chart-legend">
              <div class="an-legend-item"><span class="an-legend-dot" style="background:#0078f0"></span>Mensagens</div>
              <div class="an-legend-item"><span class="an-legend-dot" style="background:#22c55e"></span>Conversas</div>
              <div class="an-legend-item"><span class="an-legend-dot" style="background:#818cf8"></span>Uso IA (escala própria)</div>
            </div>
            <div class="an-chart-body"><canvas id="an-evolution-canvas" style="width:100%;height:100%"></canvas></div>
          ` : `
            <div class="an-empty-state" style="padding:40px 0">
              <i class="ti ti-chart-bar"></i>
              <p>Sem dados disponíveis ainda</p>
            </div>
          `}
        </div>
      </div>`;
  }

  // ── Secção 3+4: Utilização IA / Créditos ───────────────────────────
  function _drawDonut(canvas, pct, color) {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const size = canvas.clientWidth;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, size, size);

    const cx = size / 2, cy = size / 2, r = size / 2 - 10;
    const lineWidth = 14;

    ctx.lineCap = 'round';

    // Trilho
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,.06)';
    ctx.lineWidth = lineWidth;
    ctx.stroke();

    // Progresso
    const startAngle = -Math.PI / 2;
    const endAngle   = startAngle + (Math.PI * 2) * Math.min(pct, 100) / 100;
    ctx.beginPath();
    ctx.arc(cx, cy, r, startAngle, endAngle);
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }

  function _renderAiUsage(c) {
    const limit     = c.monthly_limit || 0;
    const used      = c.monthly_used  || 0;
    const remaining = c.monthly_remaining ?? Math.max(0, limit - used);
    const pct       = c.monthly_percent ?? (limit > 0 ? Math.round((used / limit) * 100) : 0);

    const level = pct >= 90 ? 'critical' : pct >= 70 ? 'warn' : '';
    const barColor   = level === 'critical' ? '#ef4444' : level === 'warn' ? '#f59e0b' : '#0078f0';

    const showAlert = remaining < 500000 && limit > 0;

    return `
      <div class="an-section">
        <div class="an-section-head">
          <i class="ti ti-cpu"></i>
          <span class="an-section-title">Utilização da IA &amp; Tokens</span>
        </div>

        ${showAlert ? `
          <div class="an-credits-alert" style="margin-bottom:10px">
            <i class="ti ti-alert-triangle"></i>
            <span>Restam apenas ${_fmt(remaining)} tokens. Considere comprar mais tokens antes do fim do ciclo.</span>
          </div>` : ''}

        <div class="an-credits-grid">

          <div class="an-credits-main">
            <div class="an-credits-top">
              <div>
                <div class="an-credits-limit-label">Limite Total (Plano Premium)</div>
                <div class="an-credits-limit-val">${_fmt(limit)} tokens</div>
              </div>
              <div class="an-credits-pct-badge ${level}">${pct}%</div>
            </div>

            <div class="an-credits-bar-track">
              <div class="an-credits-bar-fill ${level}" style="width:${Math.min(pct,100)}%"></div>
            </div>

            <div class="an-credits-foot">
              <span>Utilizados: <strong>${_fmt(used)}</strong></span>
              <span>Restantes: <strong>${_fmt(remaining)}</strong></span>
            </div>

            <div class="an-credits-renew">
              <i class="ti ti-refresh"></i>
              Renova automaticamente no próximo ciclo mensal.
            </div>
          </div>

          <div class="an-donut-card">
            <div class="an-donut-wrap">
              <canvas id="an-credits-donut" style="width:100%;height:100%"></canvas>
              <div class="an-donut-center">
                <div class="an-donut-pct">${pct}%</div>
                <div class="an-donut-label">utilizado</div>
              </div>
            </div>
            <div class="an-est-list">
              <div class="an-est-row"><span>Média / conversa</span><span>${c.avg_credits_per_conversation ? _fmt(c.avg_credits_per_conversation) : 'Sem dados'}</span></div>
              <div class="an-est-row"><span>Média diária</span><span>${c.avg_daily_usage ? _fmt(c.avg_daily_usage) : 'Sem dados'}</span></div>
              <div class="an-est-row"><span>Dias restantes (estim.)</span><span>${c.estimated_days_remaining !== null && c.estimated_days_remaining !== undefined ? c.estimated_days_remaining + ' dias' : 'Sem dados'}</span></div>
            </div>
          </div>

        </div>
      </div>`;
  }

  // ── Secção 5: Performance de Fluxos ─────────────────────────────────
  function _renderFlowPerformance(fp) {
    if (!fp.flows || fp.flows.length === 0) {
      return `
        <div class="an-section">
          <div class="an-section-head">
            <i class="ti ti-hierarchy"></i>
            <span class="an-section-title">Performance dos Fluxos</span>
          </div>
          <div class="an-flow-table">
            <div class="an-empty-mini">Sem dados disponíveis ainda. As métricas aparecem quando os fluxos começarem a ser usados.</div>
          </div>
        </div>`;
    }

    const highlights = `
      <div class="an-flow-cards">
        <div class="an-flow-highlight">
          <div class="an-flow-highlight-label"><i class="ti ti-flame"></i> Mais utilizado</div>
          <div class="an-flow-highlight-name">${fp.most_used_flow ? fp.most_used_flow.flow_name : '—'}</div>
          <div class="an-flow-highlight-sub">${fp.most_used_flow ? fp.most_used_flow.started + ' inícios' : 'Sem dados'}</div>
        </div>
        <div class="an-flow-highlight">
          <div class="an-flow-highlight-label"><i class="ti ti-circle-check"></i> Mais conversões</div>
          <div class="an-flow-highlight-name">${fp.most_converted_flow ? fp.most_converted_flow.flow_name : '—'}</div>
          <div class="an-flow-highlight-sub">${fp.most_converted_flow ? fp.most_converted_flow.finished + ' concluídas (' + fp.most_converted_flow.conversion_rate + '%)' : 'Sem dados'}</div>
        </div>
        <div class="an-flow-highlight">
          <div class="an-flow-highlight-label"><i class="ti ti-alert-circle"></i> Mais abandonos</div>
          <div class="an-flow-highlight-name">${fp.most_abandoned_flow ? fp.most_abandoned_flow.flow_name : '—'}</div>
          <div class="an-flow-highlight-sub">${fp.most_abandoned_flow ? fp.most_abandoned_flow.abandoned + ' abandonos' : 'Sem dados'}</div>
        </div>
      </div>`;

    const rows = fp.flows.map(f => `
      <tr>
        <td>${f.flow_name}</td>
        <td>${_fmt(f.started)}</td>
        <td>${_fmt(f.finished)}</td>
        <td>${_fmt(f.abandoned)}</td>
        <td><span class="an-conv-badge">${f.conversion_rate}%</span></td>
        <td>${f.avg_completion_time_ms ? _fmtMs(f.avg_completion_time_ms) : '—'}</td>
      </tr>`).join('');

    return `
      <div class="an-section">
        <div class="an-section-head">
          <i class="ti ti-hierarchy"></i>
          <span class="an-section-title">Performance dos Fluxos</span>
        </div>
        ${highlights}
        <div class="an-flow-table">
          <table>
            <thead><tr>
              <th>Fluxo</th><th>Iniciado</th><th>Concluído</th><th>Abandonado</th><th>Conversão</th><th>Tempo médio</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  }

  // ── Secção 6: Horários de actividade ────────────────────────────────
  function _renderActivityHours(ah) {
    const hasHourData = ah.by_hour.some(v => v > 0);
    const hasWeekData = ah.by_weekday.some(v => v > 0);
    const maxHour = Math.max(...ah.by_hour, 1);
    const maxWeek = Math.max(...ah.by_weekday, 1);

    const hourBars = ah.by_hour.map((v, h) => {
      const pct = Math.round((v / maxHour) * 100);
      return `
        <div class="an-hourbar-col">
          <div class="an-hourbar" style="height:${Math.max(pct,2)}%" title="${h}h: ${v} mensagens"></div>
          ${h % 3 === 0 ? `<div class="an-hourbar-label">${h}h</div>` : '<div class="an-hourbar-label"></div>'}
        </div>`;
    }).join('');

    const weekRows = ah.by_weekday.map((v, d) => {
      const pct = Math.round((v / maxWeek) * 100);
      return `
        <div class="an-weekday-row">
          <span class="an-weekday-name">${WEEKDAY_LONG[d]}</span>
          <div class="an-weekday-bar-wrap"><div class="an-weekday-bar-fill" style="width:${pct}%"></div></div>
          <span class="an-weekday-val">${v}</span>
        </div>`;
    }).join('');

    return `
      <div class="an-section">
        <div class="an-section-head">
          <i class="ti ti-clock"></i>
          <span class="an-section-title">Horários de Maior Actividade</span>
        </div>
        <div class="an-hours-grid">
          <div class="an-hours-card">
            <div style="font-size:11px;color:var(--k-muted);margin-bottom:12px">Mensagens por hora do dia</div>
            ${hasHourData ? `<div class="an-hourbars">${hourBars}</div>` : `<div class="an-empty-mini">Sem dados disponíveis ainda</div>`}
          </div>
          <div class="an-weekday-card">
            <div style="font-size:11px;color:var(--k-muted);margin-bottom:12px">Mensagens por dia da semana</div>
            ${hasWeekData ? weekRows : `<div class="an-empty-mini">Sem dados disponíveis ainda</div>`}
          </div>
        </div>
      </div>`;
  }

  // ── Secção 7: Clientes ──────────────────────────────────────────────
  function _renderClients(c) {
    const topRows = (c.top_clients && c.top_clients.length > 0)
      ? c.top_clients.map((tc, i) => `
          <div class="an-top-client-row">
            <span class="an-top-client-rank">#${i + 1}</span>
            <span class="an-top-client-name">${tc.display_name}</span>
            <span class="an-top-client-phone">${tc.phone}</span>
            <span class="an-top-client-count">${_fmt(tc.message_count)} msgs</span>
          </div>`).join('')
      : `<div class="an-empty-mini">Sem dados suficientes para o ranking de clientes ainda.</div>`;

    return `
      <div class="an-section">
        <div class="an-section-head">
          <i class="ti ti-users"></i>
          <span class="an-section-title">Clientes</span>
        </div>
        <div class="an-clients-grid">
          <div class="an-client-stat">
            <div class="an-client-icon" style="background:rgba(34,197,94,.1);color:#22c55e"><i class="ti ti-user-plus"></i></div>
            <div>
              <div class="an-client-val">${_fmt(c.new_clients)}</div>
              <div class="an-client-label">Novos clientes</div>
            </div>
          </div>
          <div class="an-client-stat">
            <div class="an-client-icon" style="background:rgba(0,120,240,.1);color:#0078f0"><i class="ti ti-user-check"></i></div>
            <div>
              <div class="an-client-val">${_fmt(c.active_clients)}</div>
              <div class="an-client-label">Clientes activos</div>
            </div>
          </div>
          <div class="an-client-stat">
            <div class="an-client-icon" style="background:rgba(245,158,11,.1);color:#f59e0b"><i class="ti ti-user-off"></i></div>
            <div>
              <div class="an-client-val">${_fmt(c.inactive_clients)}</div>
              <div class="an-client-label">Clientes inactivos</div>
            </div>
          </div>
        </div>
        <div class="an-top-clients">${topRows}</div>
      </div>`;
  }

  // ── Render geral ──────────────────────────────────────────────────
  function _render() {
    const root = document.getElementById('an-root');
    if (!root || !_data) return;

    const d = _data;
    const c = _creditsData;

    root.innerHTML = `
      ${_renderOverview(d.overview)}
      ${_renderDailyEvolution(d.daily_evolution)}
      ${_renderAiUsage(c)}
      ${_renderFlowPerformance(d.flow_performance)}
      ${_renderActivityHours(d.activity_hours)}
      ${_renderClients(d.clients)}
    `;

    // Desenhar canvas depois do HTML estar no DOM
    const evoCanvas = document.getElementById('an-evolution-canvas');
    if (evoCanvas) _drawLineChart(evoCanvas, d.daily_evolution);

    const donutCanvas = document.getElementById('an-credits-donut');
    if (donutCanvas) {
      const pct = c.monthly_percent ?? 0;
      const color = pct >= 90 ? '#ef4444' : pct >= 70 ? '#f59e0b' : '#0078f0';
      _drawDonut(donutCanvas, pct, color);
    }
  }

  function _showError(msg) {
    const root = document.getElementById('an-root');
    if (root) {
      root.innerHTML = `
        <div class="an-empty-state">
          <i class="ti ti-alert-circle" style="color:#ef4444"></i>
          <p style="color:#ef4444">${msg}</p>
        </div>`;
    }
  }

  // ── Tabs de período ──────────────────────────────────────────────
  function _bindRangeTabs() {
    const tabs = document.querySelectorAll('.an-range-tab');
    tabs.forEach(tab => {
      tab.onclick = () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        _range = tab.dataset.range;
        const root = document.getElementById('an-root');
        if (root) root.innerHTML = `<div class="an-loading"><i class="ti ti-loader-2"></i><p>A carregar métricas...</p></div>`;
        _loadAll();
      };
    });
  }

  // ── Exportação ───────────────────────────────────────────────────
  function _bindExportMenu() {
    const btn  = document.getElementById('an-export-btn');
    const menu = document.getElementById('an-export-menu');
    if (!btn || !menu) return;

    btn.onclick = (e) => {
      e.stopPropagation();
      menu.classList.toggle('open');
    };
    document.addEventListener('click', () => menu.classList.remove('open'));
  }

  function exportReport(format) {
    if (!_uid) return;

    if (format === 'pdf') {
      // PDF gerado via impressão do browser — evita dependências pesadas
      // de renderização no servidor (puppeteer/pdfkit).
      window.print();
      return;
    }

    // CSV / Excel — ambos servidos como CSV (abre nativamente no Excel)
    const url = `${BACKEND_URL}/accounts/${_uid}/analytics/export?range=${_range}&format=${format}`;
    window.open(url, '_blank');
  }

  // ── Público ─────────────────────────────────────────────────────
  function render() {
    const u = typeof AuthService !== 'undefined' ? AuthService.currentUser() : null;
    _uid = u ? u.uid : null;
    if (!_uid) { _showError('Utilizador não autenticado.'); return; }

    _bindRangeTabs();
    _bindExportMenu();
    _loadAll();
  }

  function destroy() {
    _data = null;
    _creditsData = null;
  }

  return { render, destroy, exportReport };
})();
