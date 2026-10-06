/* ══════════════════════════════════════════════════════════════
   KORVEX — Integração do Dashboard Admin Redesenhado
   ══════════════════════════════════════════════════════════════
   
   Este arquivo renderiza os gráficos do novo dashboard após
   o carregamento dos dados pelo AdminPanel.
   
   NOTA: A integração com AdminPanel._loadDashboard foi removida
   porque _loadDashboard é uma função privada. Em vez disso,
   renderizamos os gráficos após a aba ser ativada.
*/

// Renderizar gráficos quando a aba do dashboard é ativada
document.addEventListener('DOMContentLoaded', () => {
  const dashboardTab = document.querySelector('[onclick*="setTab(\'dashboard\')"]');
  if (dashboardTab) {
    // Guardar o handler original
    const originalOnclick = dashboardTab.onclick;
    
    // Substituir com versão que também renderiza os gráficos
    dashboardTab.onclick = function(e) {
      // Chamar o handler original
      if (originalOnclick && typeof originalOnclick === 'function') {
        originalOnclick.call(this, e);
      }
      
      // Aguardar um pouco para os dados serem carregados
      setTimeout(() => {
        if (typeof DashboardAdminRedesign !== 'undefined') {
          DashboardAdminRedesign.render('admin-panel-dashboard');
        }
      }, 200);
    };
  }
  
  // Também renderizar na abertura do painel admin
  const adminBtn = document.getElementById('btn-admin');
  if (adminBtn) {
    const originalAdminClick = adminBtn.onclick;
    adminBtn.onclick = function(e) {
      if (originalAdminClick && typeof originalAdminClick === 'function') {
        originalAdminClick.call(this, e);
      }
      
      setTimeout(() => {
        if (typeof DashboardAdminRedesign !== 'undefined') {
          DashboardAdminRedesign.render('admin-panel-dashboard');
        }
      }, 300);
    };
  }
});
