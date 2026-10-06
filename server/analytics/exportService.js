/* ══════════════════════════════════════════════════════════════════════
   analytics/exportService.js — Exportação de relatórios Analytics
   ────────────────────────────────────────────────────────────────────
   Gera CSV nativo (sem dependências externas) a partir dos dados já
   calculados por analyticsService.getAnalytics(). O ficheiro CSV abre
   nativamente no Excel/Google Sheets — cobre os formatos CSV e Excel
   pedidos sem adicionar bibliotecas pesadas ao servidor.

   PDF: gerado no FRONTEND via impressão do browser (window.print) com
   um layout dedicado, para evitar dependências de renderização no
   servidor (puppeteer/pdfkit) que aumentariam significativamente o
   tamanho do deploy.
   ══════════════════════════════════════════════════════════════════════ */

function _csvEscape(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function _csvRow(arr) {
  return arr.map(_csvEscape).join(',') + '\r\n';
}

/**
 * Gera um CSV com o resumo completo do Analytics para o período seleccionado.
 * @param {object} analytics — resultado de analyticsService.getAnalytics()
 * @returns {string} conteúdo CSV (UTF-8, separador vírgula)
 */
function buildAnalyticsCsv(analytics) {
  let csv = '\uFEFF'; // BOM — garante acentuação correcta ao abrir no Excel

  csv += _csvRow(['Relatório Analytics Korvex']);
  csv += _csvRow(['Período', analytics.range]);
  csv += _csvRow(['Gerado em', new Date(analytics.generated_at).toLocaleString('pt-PT')]);
  csv += _csvRow([]);

  // ── Visão geral ──────────────────────────────────────────────────
  csv += _csvRow(['VISÃO GERAL']);
  csv += _csvRow(['Métrica', 'Valor']);
  const o = analytics.overview;
  csv += _csvRow(['Total de mensagens recebidas', o.total_messages_received]);
  csv += _csvRow(['Total de mensagens enviadas', o.total_messages_sent]);
  csv += _csvRow(['Total de conversas', o.total_conversations]);
  csv += _csvRow(['Conversas iniciadas hoje', o.conversations_started_today]);
  csv += _csvRow(['Conversas finalizadas', o.conversations_finished]);
  csv += _csvRow(['Tempo médio de resposta (seg)', o.avg_response_time_ms ? Math.round(o.avg_response_time_ms / 1000) : 'Sem dados']);
  csv += _csvRow(['Média de mensagens por conversa', o.avg_messages_per_conversation]);
  csv += _csvRow([]);

  // ── Evolução diária ──────────────────────────────────────────────
  csv += _csvRow(['EVOLUÇÃO DIÁRIA']);
  csv += _csvRow(['Data', 'Mensagens', 'Conversas', 'Créditos IA']);
  analytics.daily_evolution.forEach(d => {
    csv += _csvRow([d.key, d.messages, d.conversations, d.ai_usage]);
  });
  csv += _csvRow([]);

  // ── Performance de fluxos ────────────────────────────────────────
  csv += _csvRow(['PERFORMANCE DE FLUXOS']);
  csv += _csvRow(['Fluxo', 'Iniciado', 'Concluído', 'Abandonado', 'Taxa de conversão (%)', 'Tempo médio (min)']);
  analytics.flow_performance.flows.forEach(f => {
    csv += _csvRow([
      f.flow_name, f.started, f.finished, f.abandoned, f.conversion_rate,
      f.avg_completion_time_ms ? Math.round(f.avg_completion_time_ms / 60000) : 'Sem dados',
    ]);
  });
  csv += _csvRow([]);

  // ── Clientes ─────────────────────────────────────────────────────
  csv += _csvRow(['CLIENTES']);
  csv += _csvRow(['Novos clientes', analytics.clients.new_clients]);
  csv += _csvRow(['Clientes activos', analytics.clients.active_clients]);
  csv += _csvRow(['Clientes inactivos', analytics.clients.inactive_clients]);
  csv += _csvRow([]);

  if (analytics.clients.top_clients.length > 0) {
    csv += _csvRow(['TOP CLIENTES']);
    csv += _csvRow(['Nome', 'Telefone', 'Nº de mensagens']);
    analytics.clients.top_clients.forEach(c => {
      csv += _csvRow([c.display_name, c.phone, c.message_count]);
    });
    csv += _csvRow([]);
  }

  // ── Horários de actividade ───────────────────────────────────────
  csv += _csvRow(['ACTIVIDADE POR HORA']);
  csv += _csvRow(['Hora', 'Mensagens']);
  analytics.activity_hours.by_hour.forEach((count, hour) => {
    csv += _csvRow([`${String(hour).padStart(2, '0')}:00`, count]);
  });
  csv += _csvRow([]);

  const weekdayNames = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
  csv += _csvRow(['ACTIVIDADE POR DIA DA SEMANA']);
  csv += _csvRow(['Dia', 'Mensagens']);
  analytics.activity_hours.by_weekday.forEach((count, day) => {
    csv += _csvRow([weekdayNames[day], count]);
  });

  return csv;
}

module.exports = { buildAnalyticsCsv };
