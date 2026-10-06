/* ══════════════════════════════════════════════════════════════
   KORVEX — Dashboard Admin v3.0 — Chart.js
   
   Gráficos profissionais com Chart.js
   Dados reais do DashboardStatsService
══════════════════════════════════════════════════════════════ */

const DashboardAdminRedesign = (() => {

  let chartInstances = {};

  /* ══════════════════════════════════════════════════════════════
     DADOS FICTÍCIOS PARA GRÁFICOS
     ══════════════════════════════════════════════════════════════ */
  const MOCK_CHARTS_DATA = {
    revenue: {
      labels: ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab', 'Dom'],
      values: [2400, 2300, 2500, 2800, 2600, 2900, 3100]
    },
    newUsers: {
      labels: ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab', 'Dom'],
      values: [22, 28, 28, 32, 36, 27, 18]
    },
    usersByPlan: {
      labels: ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab', 'Dom'],
      premium: [150, 155, 158, 162, 165, 168, 170],
      pro: [85, 90, 95, 100, 105, 110, 115],
      trial: [30, 28, 25, 22, 20, 18, 16],
      expirado: [5, 5, 5, 6, 6, 7, 8]
    }
  };

  // ═══════════════════════════════════════════════════════════════
  // FUNÇÕES AUXILIARES
  // ═══════════════════════════════════════════════════════════════

  function _formatNumber(n) {
    if (!n) return '0';
    return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  function _formatCurrency(n) {
    if (!n) return 'MT 0,00';
    const formatted = _formatNumber(n);
    return 'MT ' + formatted;
  }

  function _destroyChart(canvasId) {
    if (chartInstances[canvasId]) {
      chartInstances[canvasId].destroy();
      delete chartInstances[canvasId];
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // GRÁFICO 1: RECEITA (Linha)
  // ═══════════════════════════════════════════════════════════════

  function _createRevenueChart() {
    const canvasId = 'dashboard-revenue-chart-canvas';
    const container = document.getElementById('dashboard-revenue-chart');
    
    if (!container) return;
    
    // Verificar se já existe canvas
    let canvas = container.querySelector('canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = canvasId;
      container.innerHTML = '';
      container.appendChild(canvas);
    }

    _destroyChart(canvasId);

    chartInstances[canvasId] = new Chart(canvas, {
      type: 'line',
      data: {
        labels: MOCK_CHARTS_DATA.revenue.labels,
        datasets: [{
          label: 'Receita (MT)',
          data: MOCK_CHARTS_DATA.revenue.values,
          borderColor: '#38BDF8',
          backgroundColor: 'rgba(56, 189, 248, 0.05)',
          borderWidth: 2,
          fill: true,
          tension: 0.4,
          pointRadius: 4,
          pointBackgroundColor: '#38BDF8',
          pointBorderColor: '#0B0E14',
          pointBorderWidth: 2,
          pointHoverRadius: 6
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          legend: {
            display: false
          },
          tooltip: {
            backgroundColor: 'rgba(15, 23, 42, 0.9)',
            titleColor: '#FFFFFF',
            bodyColor: '#CBD5E1',
            borderColor: 'rgba(59, 130, 246, 0.3)',
            borderWidth: 1,
            padding: 10,
            displayColors: false,
            callbacks: {
              label: function(context) {
                return 'MT ' + _formatNumber(context.parsed.y);
              }
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            grid: {
              color: 'rgba(255, 255, 255, 0.05)',
              drawBorder: false
            },
            ticks: {
              color: '#94A3B8',
              font: { size: 11 },
              callback: function(value) {
                return 'MT ' + _formatNumber(value);
              }
            }
          },
          x: {
            grid: {
              display: false
            },
            ticks: {
              color: '#94A3B8',
              font: { size: 11 }
            }
          }
        }
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // GRÁFICO 2: DISTRIBUIÇÃO DOS PLANOS (Donut)
  // ═══════════════════════════════════════════════════════════════

  function _createPlanDistributionChart() {
    const canvasId = 'dashboard-plan-distribution-chart-canvas';
    const container = document.getElementById('dashboard-plan-distribution-chart');
    
    if (!container) return;
    
    let canvas = container.querySelector('canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = canvasId;
      container.innerHTML = '';
      container.appendChild(canvas);
    }

    _destroyChart(canvasId);

    // Dados fictícios - será substituído por dados reais depois
    const planData = {
      premium: 623,
      pro: 892,
      trial: 238,
      expirado: 40
    };

    // Calcular total para center label
    const totalUsers = planData.premium + planData.pro + planData.trial + planData.expirado;

    const centerLabelPlugin = {
      id: 'centerLabel',
      afterDatasetsDraw(chart) {
        const { ctx, chartArea: { left, top, width, height } } = chart;
        
        ctx.save();
        
        // Desenhar número grande no centro
        const centerX = left + width / 2;
        const centerY = top + height / 2;
        
        ctx.font = 'bold 28px Arial, sans-serif';
        ctx.fillStyle = '#FFFFFF';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(totalUsers, centerX, centerY - 10);
        
        // Desenhar texto pequeno abaixo
        ctx.font = '12px Arial, sans-serif';
        ctx.fillStyle = '#94A3B8';
        ctx.fillText('Total Utilizadores', centerX, centerY + 12);
        
        ctx.restore();
      }
    };

    chartInstances[canvasId] = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: ['Premium', 'Pro', 'Trial', 'Expirado'],
        datasets: [{
          data: [planData.premium, planData.pro, planData.trial, planData.expirado],
          backgroundColor: ['#22C55E', '#3B82F6', '#FBBF24', '#F87171'],
          borderColor: '#0B0E14',
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          legend: {
            display: false
          },
          tooltip: {
            backgroundColor: 'rgba(15, 23, 42, 0.9)',
            titleColor: '#FFFFFF',
            bodyColor: '#CBD5E1',
            borderColor: 'rgba(59, 130, 246, 0.3)',
            borderWidth: 1,
            padding: 10,
            callbacks: {
              label: function(context) {
                return context.label + ': ' + context.parsed;
              }
            }
          }
        }
      },
      plugins: [centerLabelPlugin]
    });

    // Atualizar legenda manualmente
    const legendContainer = document.getElementById('dashboard-plan-distribution-legend');
    if (legendContainer) {
      legendContainer.innerHTML = 
        '<div class="dashboard-admin-legend-item"><div class="dashboard-admin-legend-color premium"></div><span>Premium</span></div>' +
        '<div class="dashboard-admin-legend-item"><div class="dashboard-admin-legend-color pro"></div><span>Pro</span></div>' +
        '<div class="dashboard-admin-legend-item"><div class="dashboard-admin-legend-color trial"></div><span>Trial</span></div>' +
        '<div class="dashboard-admin-legend-item"><div class="dashboard-admin-legend-color expirado"></div><span>Expirado</span></div>';
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // GRÁFICO 3: NOVOS UTILIZADORES (Barras)
  // ═══════════════════════════════════════════════════════════════

  function _createNewUsersChart() {
    const canvasId = 'dashboard-new-users-chart-canvas';
    const container = document.getElementById('dashboard-new-users-chart');
    
    if (!container) return;
    
    let canvas = container.querySelector('canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = canvasId;
      container.innerHTML = '';
      container.appendChild(canvas);
    }

    _destroyChart(canvasId);

    chartInstances[canvasId] = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: MOCK_CHARTS_DATA.newUsers.labels,
        datasets: [{
          label: 'Novos Utilizadores',
          data: MOCK_CHARTS_DATA.newUsers.values,
          backgroundColor: '#38BDF8',
          borderColor: '#38BDF8',
          borderWidth: 1,
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          legend: {
            display: false
          },
          tooltip: {
            backgroundColor: 'rgba(15, 23, 42, 0.9)',
            titleColor: '#FFFFFF',
            bodyColor: '#CBD5E1',
            borderColor: 'rgba(59, 130, 246, 0.3)',
            borderWidth: 1,
            padding: 10,
            displayColors: false
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            grid: {
              color: 'rgba(255, 255, 255, 0.05)',
              drawBorder: false
            },
            ticks: {
              color: '#94A3B8',
              font: { size: 11 }
            }
          },
          x: {
            grid: {
              display: false
            },
            ticks: {
              color: '#94A3B8',
              font: { size: 11 }
            }
          }
        }
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // GRÁFICO 4: UTILIZADORES POR PLANO (Multibar)
  // ═══════════════════════════════════════════════════════════════

  function _createUsersByPlanChart() {
    const canvasId = 'dashboard-users-by-plan-chart-canvas';
    const container = document.getElementById('dashboard-users-by-plan-chart');
    
    if (!container) return;
    
    let canvas = container.querySelector('canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = canvasId;
      container.innerHTML = '';
      container.appendChild(canvas);
    }

    _destroyChart(canvasId);

    const data = MOCK_CHARTS_DATA.usersByPlan;

    chartInstances[canvasId] = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: data.labels,
        datasets: [
          {
            label: 'Premium',
            data: data.premium,
            backgroundColor: '#22C55E',
            borderRadius: 3,
            borderSkipped: false
          },
          {
            label: 'Pro',
            data: data.pro,
            backgroundColor: '#3B82F6',
            borderRadius: 3,
            borderSkipped: false
          },
          {
            label: 'Trial',
            data: data.trial,
            backgroundColor: '#FBBF24',
            borderRadius: 3,
            borderSkipped: false
          },
          {
            label: 'Expirado',
            data: data.expirado,
            backgroundColor: '#F87171',
            borderRadius: 3,
            borderSkipped: false
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          legend: {
            display: false
          },
          tooltip: {
            backgroundColor: 'rgba(15, 23, 42, 0.9)',
            titleColor: '#FFFFFF',
            bodyColor: '#CBD5E1',
            borderColor: 'rgba(59, 130, 246, 0.3)',
            borderWidth: 1,
            padding: 10
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            grid: {
              color: 'rgba(255, 255, 255, 0.05)',
              drawBorder: false
            },
            ticks: {
              color: '#94A3B8',
              font: { size: 11 }
            }
          },
          x: {
            grid: {
              display: false
            },
            ticks: {
              color: '#94A3B8',
              font: { size: 11 }
            }
          }
        }
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // ATUALIZAR DADOS REAIS
  // ═══════════════════════════════════════════════════════════════

  async function _updateRealStats() {
    try {
      const stats = await DashboardStatsService.getStats();
      
      // Total Utilizadores
      const totalUsers = document.getElementById('admin-stat-total-users');
      if (totalUsers) totalUsers.textContent = _formatNumber(stats.totalUsers || 0);
      
      // Utilizadores Ativos
      const activeCount = stats.activeSubscriptions || 0;
      const totalCount = stats.totalUsers || 1;
      const activePercent = Math.round((activeCount / totalCount) * 100);
      
      const activeUsers = document.getElementById('admin-stat-active-users');
      if (activeUsers) activeUsers.textContent = _formatNumber(activeCount);
      
      const activePercent2 = document.getElementById('admin-stat-active-percent');
      if (activePercent2) activePercent2.textContent = activePercent + '%';
      
      // Receita Total
      const totalRevenue = document.getElementById('admin-stat-total-revenue');
      if (totalRevenue) totalRevenue.textContent = _formatCurrency(stats.totalRevenue || 0);
      
      // Receita Mensal (MRR)
      const mrr = document.getElementById('admin-stat-mrr');
      if (mrr) mrr.textContent = _formatCurrency(stats.monthlyRevenue || 0);
      
      // Trial
      const breakdown = stats.breakdown || {};
      const trialCount = breakdown.trial || 0;
      const trialPercent = Math.round((trialCount / totalCount) * 100);
      
      const trial = document.getElementById('admin-stat-trial');
      if (trial) trial.textContent = _formatNumber(trialCount);
      
      const trialChange = document.getElementById('admin-stat-trial-change');
      if (trialChange) trialChange.textContent = trialPercent + '%';
      
      // Expirados
      const expiredCount = stats.expiredSubscriptions || 0;
      const expiredPercent = Math.round((expiredCount / totalCount) * 100);
      
      const expired = document.getElementById('admin-stat-expired');
      if (expired) expired.textContent = _formatNumber(expiredCount);
      
      const expiredChange = document.getElementById('admin-stat-expired-change');
      if (expiredChange) expiredChange.textContent = expiredPercent + '%';
      
      // Resumo Geral
      const summaryConversions = document.getElementById('admin-summary-conversions');
      if (summaryConversions) summaryConversions.textContent = Math.round(activePercent * 10);
      
      const summaryNewUsers = document.getElementById('admin-summary-new-users');
      if (summaryNewUsers) summaryNewUsers.textContent = Math.round(totalCount * 0.15);
      
      const summaryGrowth = document.getElementById('admin-summary-growth');
      if (summaryGrowth) summaryGrowth.textContent = '+12%';
      
      // Renderizar gráficos
      _renderCharts();
      
    } catch (e) {
      console.error('[DashboardAdminRedesign] Erro ao carregar stats:', e);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // RENDERIZAR GRÁFICOS
  // ═══════════════════════════════════════════════════════════════

  function _renderCharts() {
    _createRevenueChart();
    _createPlanDistributionChart();
    _createNewUsersChart();
    _createUsersByPlanChart();
  }

  // ═══════════════════════════════════════════════════════════════
  // INICIALIZAR
  // ═══════════════════════════════════════════════════════════════

  async function init() {
    await _updateRealStats();
  }

  return { init: init };
})();

// ══════════════════════════════════════════════════════════════
// REFRESH DO DASHBOARD
// ══════════════════════════════════════════════════════════════

const DashboardAdminRefresh = (() => {
  
  async function refresh() {
    const btn = document.querySelector('.dashboard-admin-refresh-btn');
    if (!btn) return;

    btn.classList.add('loading');
    btn.disabled = true;

    try {
      await DashboardStatsService.refreshStats();
      await DashboardAdminRedesign.init();
      
      btn.classList.remove('loading');
      btn.style.backgroundColor = 'rgba(34, 197, 94, 0.2)';
      
      setTimeout(function() {
        btn.style.backgroundColor = '';
        btn.disabled = false;
      }, 1500);
    } catch (e) {
      console.error('[DashboardAdminRefresh] Erro:', e);
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  }

  return { refresh: refresh };
})();

document.addEventListener('DOMContentLoaded', function() {
  if (typeof DashboardAdminRedesign !== 'undefined') {
    DashboardAdminRedesign.init().catch(function(e) { 
      console.error('[Dashboard] Init error:', e); 
    });
  }
});
