/* ══════════════════════════════════════════════════════════════════════
   ConnectionService — Gestão de até 2 números WhatsApp por conta
   ────────────────────────────────────────────────────────────────────
   Firestore:
     workspaces/{uid}/connections/whatsapp_1  → número principal
     workspaces/{uid}/connections/whatsapp_2  → segundo número (Premium)

   Cada documento:
     { channel, status, phone, sessionId, qrGeneratedAt,
       connectedAt, activeFlowId, createdAt, updatedAt }

   Backend:
     POST /whatsapp/connect        body: { uid, slot }
     POST /whatsapp/disconnect     body: { uid, slot }
     GET  /whatsapp/qr/:uid/:slot
     GET  /whatsapp/status/:uid/:slot
     POST /whatsapp/flow-changed   body: { uid, slot }
   ══════════════════════════════════════════════════════════════════════ */

const ConnectionService = (() => {

  const BACKEND_URL          = window._KORVEX_BACKEND_URL || 'http://localhost:3001';
  const QR_POLL_INTERVAL     = 2000;
  const CONNECT_TIMEOUT      = 60000;
  const STALE_CONNECTING_MS  = 5 * 60 * 1000;
  const SLOTS                = ['whatsapp_1', 'whatsapp_2'];

  // ── CONFIGURAÇÃO DE PLANOS — Fonte única de verdade ──────────────────
  const PLAN_LIMITS = {
    trial:   { maxWhatsappNumbers: 1 },
    pro:     { maxWhatsappNumbers: 1 },
    premium: { maxWhatsappNumbers: 2 },
    admin:   { maxWhatsappNumbers: Infinity },
  };

  function _getMaxWhatsappNumbers(plan) {
    return PLAN_LIMITS[plan]?.maxWhatsappNumbers ?? 1;
  }

  let _uid        = null;
  let _plan       = 'trial';   // 'trial' | 'pro' | 'premium' | 'admin' — define número máximo de WhatsApps

  // Estado por slot
  const _state       = { whatsapp_1: null, whatsapp_2: null };
  const _unsub       = { whatsapp_1: null, whatsapp_2: null };
  const _qrTimer     = { whatsapp_1: null, whatsapp_2: null };
  const _connTimer   = { whatsapp_1: null, whatsapp_2: null };
  let _activeQrSlot  = null;   // slot com o modal QR aberto
  let _manageSlot    = null;   // slot com o modal Gerir Canal aberto
  let _refreshing    = false;

  // ── Referência Firestore por slot ────────────────────────────────────
  function _ref(slot) {
    const db = FirebaseCore.getDb();
    if (!db || !_uid) return null;
    return db.collection('workspaces').doc(_uid)
             .collection('connections').doc(slot);
  }

  function _defaultState(slot) {
    return {
      channel:       slot,
      status:        'disconnected',
      phone:         null,
      sessionId:     null,
      qrGeneratedAt: null,
      activeFlowId:  null,
      createdAt:     Date.now(),
      updatedAt:     Date.now(),
    };
  }

  // ── Inicializar ──────────────────────────────────────────────────────
  async function init(uid) {
    _uid = uid;
    _destroyAll();

    // [FLIGHT RECORDER]
    if (typeof korvexFlightRecorder !== 'undefined') {
      korvexFlightRecorder.recordConnection('init', {
        uid,
        slots: SLOTS.length
      });
    }

    // Determinar plano actual — admin tem sempre acesso premium completo
    const _subStatus = typeof SubscriptionService !== 'undefined'
      ? SubscriptionService.getStatus()
      : 'trial';
    const sub = typeof SubscriptionService !== 'undefined'
      ? SubscriptionService.getCached()
      : null;
    // Admin (por email/uid hardcoded ou plan:'admin') tem acesso total
    const _isAdminAccount = _subStatus === 'admin' || sub?.plan === 'admin';
    // Plano ativo: PRO ou PREMIUM (se não expirou) ou ADMIN
    const _isPaidPlanActive = _isAdminAccount || (sub &&
      (sub.plan === 'pro' || sub.plan === 'premium') &&
      (sub.expiresAt == null || sub.expiresAt > Date.now()));
    // Distinguir entre PRO (1 slot) e PREMIUM (2 slots)
    _plan = 'trial';
    if (_isAdminAccount) {
      _plan = 'admin';
    } else if (_isPaidPlanActive) {
      _plan = sub.plan; // 'pro' ou 'premium'
    }

    for (const slot of SLOTS) {
      const ref = _ref(slot);
      if (!ref) { _renderSlot(slot, _defaultState(slot)); continue; }

      try {
        const snap = await ref.get();
        if (!snap.exists) {
          await ref.set(_defaultState(slot));
        } else {
          await _recoverStale(slot, snap.data());
        }
      } catch (e) {
        console.warn(`[ConnectionService] init ${slot}:`, e.message);
      }

      _startListener(slot);
    }

    // [FLIGHT RECORDER]
    if (typeof korvexFlightRecorder !== 'undefined') {
      korvexFlightRecorder.recordConnection('init_complete', {
        uid,
        plan: _plan,
        activeListeners: SLOTS.length
      });
    }

    _renderAllUI();
  }

  // ── Recuperação de sessão presa ──────────────────────────────────────
  async function _recoverStale(slot, data) {
    if (!data || data.status !== 'connecting') return;
    const age = Date.now() - (data.qrGeneratedAt || data.updatedAt || data.createdAt || 0);
    if (age <= STALE_CONNECTING_MS) return;

    console.info(`[ConnectionService] Sessão presa em ${slot} — a recuperar.`);
    try {
      await fetch(`${BACKEND_URL}/whatsapp/disconnect`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: _uid, slot }),
      });
    } catch {}

    const ref = _ref(slot);
    if (ref) await ref.set({
      status: 'disconnected', phone: null, sessionId: null,
      qrGeneratedAt: null, updatedAt: Date.now(),
    }, { merge: true }).catch(() => {});
  }

  // ── Listeners Firestore ──────────────────────────────────────────────
  function _startListener(slot) {
    const ref = _ref(slot);
    if (!ref) return;

    _unsub[slot] = ref.onSnapshot(snap => {
      const data  = snap.exists ? snap.data() : _defaultState(slot);
      _state[slot] = data;
      _renderSlot(slot, data);
      _updateDashboardStat();
      _updateSidebarStatus();
      if (_manageSlot === slot) _renderManageChannel(slot, data);

      if (data.status === 'connected') {
        _clearConnTimer(slot);
        if (_activeQrSlot === slot) {
          _stopQrPolling(slot);
          setTimeout(() => _closeQrModal(true), 800);
        }
      }

      if (data.status === 'disconnected' && _activeQrSlot === slot) {
        _stopQrPolling(slot);
        _clearConnTimer(slot);
      }
    }, err => console.warn(`[ConnectionService] listener ${slot}:`, err));
  }

  function _stopListener(slot) {
    if (_unsub[slot]) { _unsub[slot](); _unsub[slot] = null; }
  }

  function _destroyAll() {
    SLOTS.forEach(s => {
      _stopListener(s);
      _stopQrPolling(s);
      _clearConnTimer(s);
    });
    _activeQrSlot = null;
    _manageSlot   = null;
    _refreshing   = false;
  }

  function destroy() {
    // [FLIGHT RECORDER]
    if (typeof korvexFlightRecorder !== 'undefined') {
      korvexFlightRecorder.recordConnection('destroy', {
        uid: _uid,
        activeListeners: SLOTS.filter(s => _unsub[s] !== null).length
      });
    }
    _destroyAll();
    _closeQrModal(false);
    _closeManageChannel();
    _uid  = null;
    _plan = 'trial';
    SLOTS.forEach(s => {
      _state[s] = null;
      _renderSlot(s, _defaultState(s));
    });
    _updateDashboardStat();
    _updateSidebarStatus();
  }

  // ══════════════════════════════════════════════════════════════════════
  // Conectar / Desconectar
  // ══════════════════════════════════════════════════════════════════════

  async function connectWhatsApp(slot) {
    slot = slot || 'whatsapp_1';
    if (!_uid) return;

    // [FRONTEND CONNECT CLICK] — Clique em conectar
    console.log(`
[FRONTEND CONNECT CLICK]
┌─ timestamp: ${Date.now()}
├─ uid: ${_uid}
├─ slot: ${slot}
└─ plan: ${_plan}
    `);

    // Verificar se slot está disponível baseado no plano
    const slotIndex = SLOTS.indexOf(slot);
    const maxSessions = _getMaxWhatsappNumbers(_plan);
    if (slotIndex >= maxSessions) {
      if (typeof showToast === 'function') {
        const planName = _plan === 'pro' ? 'Pro' : _plan === 'premium' ? 'Premium' : 'atual';
        showToast(`O ${slotIndex + 1}º número WhatsApp está disponível apenas no plano ${_plan === 'premium' ? 'Premium' : _plan === 'pro' ? 'Pro ou superior' : 'Pro ou Premium'}.`, 'warn');
      }
      return;
    }

    if (_manageSlot) _closeManageChannel();
    _activeQrSlot = slot;
    _openQrModal(slot);
    _setQrModalLoading('A iniciar sessão…');
    await _requestNewSession(slot, 'A iniciar sessão…');
  }

  async function disconnectWhatsApp(slot) {
    slot = slot || 'whatsapp_1';
    if (!_uid) return;

    _stopQrPolling(slot);
    _clearConnTimer(slot);
    _renderSlot(slot, { ...(_state[slot] || {}), status: 'disconnected', phone: null, sessionId: null });
    if (_activeQrSlot === slot) _closeQrModal(false);
    _closeManageChannel();

    try {
      await fetch(`${BACKEND_URL}/whatsapp/disconnect`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: _uid, slot }),
      });
    } catch (e) {
      console.warn('[ConnectionService] disconnect fetch:', e.message);
    } finally {
      const ref = _ref(slot);
      if (ref) await ref.set({
        status: 'disconnected', phone: null, sessionId: null,
        qrGeneratedAt: null, updatedAt: Date.now(),
      }, { merge: true }).catch(() => {});
    }

    if (typeof showToast === 'function')
      showToast('WhatsApp desconectado.', 'info');
  }

  async function refreshQr(slot) {
    slot = slot || _activeQrSlot || 'whatsapp_1';
    if (!_uid || _refreshing) return;
    _refreshing = true;

    _closeManageChannel();
    _activeQrSlot = slot;
    if (!document.getElementById('k-qr-overlay')?.classList.contains('open'))
      _openQrModal(slot);

    _stopQrPolling(slot);
    _clearConnTimer(slot);
    _setQrModalLoading('A gerar novo QR Code…');

    try {
      await fetch(`${BACKEND_URL}/whatsapp/disconnect`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: _uid, slot }),
      }).catch(() => {});
      await _requestNewSession(slot, 'A gerar novo QR Code…');
    } finally {
      _refreshing = false;
    }
  }

  async function _requestNewSession(slot, loadingMsg) {
    try {
      const fetchStartTime = Date.now();
      const fetchUrl = `${BACKEND_URL}/whatsapp/connect`;
      const fetchBody = JSON.stringify({ uid: _uid, slot });
      
      // [FRONTEND CONNECT FETCH] — Antes do fetch POST /connect
      console.log(`
[FRONTEND CONNECT FETCH]
┌─ timestamp: ${fetchStartTime}
├─ uid: ${_uid}
├─ slot: ${slot}
├─ url: ${fetchUrl}
├─ method: POST
└─ bodySize: ${fetchBody.length} bytes
      `);
      
      const res = await fetch(fetchUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: fetchBody,
      });
      
      // [FRONTEND CONNECT RESPONSE] — Resposta recebida
      const responseTime = Date.now();
      const responseBody = await res.json().catch(() => ({}));
      console.log(`
[FRONTEND CONNECT RESPONSE]
┌─ timestamp: ${responseTime}
├─ uid: ${_uid}
├─ slot: ${slot}
├─ statusHTTP: ${res.status}
├─ ok: ${res.ok}
├─ tempoResposta: ${responseTime - fetchStartTime}ms
├─ responseBody: ${JSON.stringify(responseBody).substring(0, 200)}
└─ statusResposta: ${responseBody.status || 'unknown'}
      `);
      
      if (!res.ok) {
        const err = responseBody;
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      _setQrModalLoading(loadingMsg);
      _armConnTimer(slot);
      _startQrPolling(slot);
    } catch (e) {
      console.error('[ConnectionService] _requestNewSession:', e.message);
      _setQrModalError(
        'Não foi possível contactar o servidor Korvex.<br>' +
        `<small style="color:var(--k-muted)">Servidor: <code>${BACKEND_URL}</code></small>`
      );
    }
  }

  // ── Timeout de conexão ───────────────────────────────────────────────
  function _armConnTimer(slot) {
    _clearConnTimer(slot);
    _connTimer[slot] = setTimeout(() => _onConnTimeout(slot), CONNECT_TIMEOUT);
  }

  function _clearConnTimer(slot) {
    if (_connTimer[slot]) { clearTimeout(_connTimer[slot]); _connTimer[slot] = null; }
  }

  async function _onConnTimeout(slot) {
    console.warn(`[ConnectionService] Timeout 60s — ${slot}`);
    _stopQrPolling(slot);
    _connTimer[slot] = null;
    try {
      await fetch(`${BACKEND_URL}/whatsapp/disconnect`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: _uid, slot }),
      });
    } catch {}
    const ref = _ref(slot);
    if (ref) await ref.set({
      status: 'disconnected', phone: null, sessionId: null,
      qrGeneratedAt: null, updatedAt: Date.now(),
    }, { merge: true }).catch(() => {});
    _setQrModalError('Tempo de ligação expirado');
  }

  // ── Polling do QR ────────────────────────────────────────────────────
  function _startQrPolling(slot) {
    _stopQrPolling(slot);

    // [POLL START] — Início do polling
    const pollStartTime = Date.now();
    let pollAttempt = 0;
    console.log(`
[POLL START]
┌─ timestamp: ${pollStartTime}
├─ uid: ${_uid}
├─ slot: ${slot}
├─ intervalo: ${QR_POLL_INTERVAL}ms
└─ delay_inicial: 500ms
    `);

    const poll = async () => {
      if (_activeQrSlot !== slot) return;
      try {
        pollAttempt++;
        const pollRequestTime = Date.now();
        
        // [POLL REQUEST] — Requisição enviada
        console.log(`
[POLL REQUEST]
┌─ timestamp: ${pollRequestTime}
├─ uid: ${_uid}
├─ slot: ${slot}
├─ tentativa: ${pollAttempt}
└─ url: ${BACKEND_URL}/whatsapp/qr/${_uid}/${slot}
        `);

        // [INSTRUMENTAÇÃO QR] Frontend pede QR
        console.log(`[FRONTEND QR POLL] uid: ${_uid}, slot: ${slot}, timestamp: ${pollRequestTime}`);
        const res  = await fetch(`${BACKEND_URL}/whatsapp/qr/${_uid}/${slot}`);
        const data = await res.json();

        // [POLL RESPONSE] — Resposta recebida
        const pollResponseTime = Date.now();
        const qrSize = data.qr ? data.qr.length : 0;
        console.log(`
[POLL RESPONSE]
┌─ timestamp: ${pollResponseTime}
├─ uid: ${_uid}
├─ slot: ${slot}
├─ tentativa: ${pollAttempt}
├─ status: ${data.status}
├─ qrExiste: ${!!data.qr}
├─ tamanhoQR: ${qrSize} bytes
├─ tempoResposta: ${pollResponseTime - pollRequestTime}ms
└─ dataKeys: ${Object.keys(data).join(', ')}
        `);

        // [INSTRUMENTAÇÃO QR] Frontend recebeu resposta QR
        console.log(`[FRONTEND QR RESPONSE] uid: ${_uid}, slot: ${slot}, status: ${data.status}, qrRecebido: ${!!data.qr}, timestamp: ${pollResponseTime}`);

        if (data.status === 'connected') {
          // [UI UPDATE] — Atualização da interface
          console.log(`
[UI UPDATE]
┌─ acao: connected
├─ uid: ${_uid}
├─ slot: ${slot}
└─ timestamp: ${Date.now()}
          `);
          console.log(`[FRONTEND] Conexão bem-sucedida - uid: ${_uid}, slot: ${slot}`);
          _clearConnTimer(slot); _stopQrPolling(slot); return;
        }
        if (data.status === 'disconnected') {
          // [UI UPDATE] — Atualização da interface
          console.log(`
[UI UPDATE]
┌─ acao: disconnected
├─ uid: ${_uid}
├─ slot: ${slot}
└─ timestamp: ${Date.now()}
          `);
          console.log(`[FRONTEND] Desconexão detectada - uid: ${_uid}, slot: ${slot}`);
          _clearConnTimer(slot); _stopQrPolling(slot);
          _setQrModalError('Tempo de ligação expirado'); return;
        }
        if (data.qr) {
          // [UI UPDATE] — Atualização da interface
          console.log(`
[UI UPDATE]
┌─ acao: show_qr
├─ uid: ${_uid}
├─ slot: ${slot}
└─ timestamp: ${Date.now()}
          `);
          console.log(`[FRONTEND] QR Exibindo para utilizador - uid: ${_uid}, slot: ${slot}`);
          _setQrModalImage(data.qr, slot);
        } else if (data.status === 'connecting') {
          // [UI UPDATE] — Atualização da interface
          console.log(`
[UI UPDATE]
┌─ acao: loading
├─ uid: ${_uid}
├─ slot: ${slot}
└─ timestamp: ${Date.now()}
          `);
          console.log(`[FRONTEND] Aguardando QR - uid: ${_uid}, slot: ${slot}`);
          _setQrModalLoading('A aguardar QR Code…');
        }
      } catch (e) {
        // [UI UPDATE] — Atualização da interface (erro)
        console.log(`
[UI UPDATE]
┌─ acao: error
├─ uid: ${_uid}
├─ slot: ${slot}
├─ erro: ${e.message}
└─ timestamp: ${Date.now()}
        `);
        console.warn('[ConnectionService] QR poll error:', e.message);
      }
      _qrTimer[slot] = setTimeout(poll, QR_POLL_INTERVAL);
    };

    _qrTimer[slot] = setTimeout(poll, 500);
  }

  function _stopQrPolling(slot) {
    if (_qrTimer[slot]) { clearTimeout(_qrTimer[slot]); _qrTimer[slot] = null; }
  }

  // ══════════════════════════════════════════════════════════════════════
  // Modal Gerir Canal
  // ══════════════════════════════════════════════════════════════════════

  async function openManageChannel(slot) {
    slot = slot || 'whatsapp_1';
    if (!_uid) return;
    _manageSlot = slot;

    const overlay = document.getElementById('manage-channel-overlay');
    if (overlay) {
      // Actualizar título do modal com o slot
      const title = overlay.querySelector('#mc-slot-label');
      if (title) title.textContent = slot === 'whatsapp_2' ? 'Número 2' : 'Número 1';
      overlay.classList.add('open');
    }

    await _populateFlowSelect();
    _renderManageChannel(slot, _state[slot] || _defaultState(slot));
  }

  function _closeManageChannel() {
    _manageSlot = null;
    const overlay = document.getElementById('manage-channel-overlay');
    if (overlay) overlay.classList.remove('open');
  }

  // Alias público
  function closeManageChannel() { _closeManageChannel(); }

  async function _populateFlowSelect() {
    const select = document.getElementById('mc-flow-select');
    if (!select) return;
    select.innerHTML = '<option value="">— Selecionar fluxo —</option>';
    try {
      const flows = await FlowStorage.list();
      flows
        .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
        .forEach(f => {
          const opt = document.createElement('option');
          opt.value = f.flowId;
          opt.textContent = f.name || 'Sem título';
          select.appendChild(opt);
        });
    } catch (e) {
      console.warn('[ConnectionService] listar fluxos:', e.message);
    }
  }

  function _renderManageChannel(slot, data) {
    const status   = data.status || 'disconnected';
    const isDisc   = status === 'disconnected';

    const discView = document.getElementById('mc-disconnected-view');
    const connView = document.getElementById('mc-connected-view');
    if (discView) discView.style.display = isDisc ? '' : 'none';
    if (connView) connView.style.display = isDisc ? 'none' : '';

    if (isDisc) {
      const btnChange = document.getElementById('mc-btn-change-flow');
      if (btnChange) btnChange.style.display = 'none';
      return;
    }

    _set('mc-phone', data.phone || '—');

    const pill  = document.getElementById('mc-status-pill');
    const label = document.getElementById('mc-status-label');
    if (pill)  pill.className    = 'conn-status-pill ' + status;
    if (label) label.textContent = _statusLabel(status);

    const select = document.getElementById('mc-flow-select');
    if (select) select.value = data.activeFlowId || '';

    const btnRefresh = document.getElementById('mc-btn-refresh-qr');
    const btnDisc    = document.getElementById('mc-btn-disconnect');
    const btnChange  = document.getElementById('mc-btn-change-flow');
    if (btnRefresh) btnRefresh.style.display = status === 'connecting' ? '' : 'none';
    if (btnDisc)    btnDisc.style.display    = (status === 'connecting' || status === 'connected') ? '' : 'none';
    if (btnChange)  btnChange.style.display  = '';

    // Guardar slot activo nos botões para os onclick saberem qual slot usar
    if (btnRefresh) btnRefresh.onclick = () => refreshQr(slot);
    if (btnDisc)    btnDisc.onclick    = () => disconnectWhatsApp(slot);
    if (btnChange)  btnChange.onclick  = () => changeActiveFlow(slot);

    const hint = document.getElementById('mc-flow-hint');
    if (hint) {
      hint.textContent = data.activeFlowId
        ? 'Este fluxo é executado automaticamente quando este número recebe uma mensagem.'
        : 'Sem fluxo ativo — selecione um fluxo e clique em "Alterar Fluxo".';
    }
  }

  async function changeActiveFlow(slot) {
    slot = slot || _manageSlot || 'whatsapp_1';
    if (!_uid) return;
    const select = document.getElementById('mc-flow-select');
    const flowId = select ? select.value : '';
    const ref    = _ref(slot);
    if (!ref) return;

    try {
      await ref.set({ activeFlowId: flowId || null, updatedAt: Date.now() }, { merge: true });
      fetch(`${BACKEND_URL}/whatsapp/flow-changed`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: _uid, slot }),
      }).catch(() => {});
      if (typeof showToast === 'function')
        showToast(flowId ? 'Fluxo ativo atualizado.' : 'Fluxo ativo removido.', 'success');
    } catch (e) {
      console.error('[ConnectionService] changeActiveFlow:', e.message);
      if (typeof showToast === 'function') showToast('Erro ao atualizar o fluxo ativo.', 'error');
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // Modal QR Code
  // ══════════════════════════════════════════════════════════════════════

  function _openQrModal(slot) {
    _ensureQrModal();
    const title = document.getElementById('k-qr-slot-label');
    if (title) title.textContent = slot === 'whatsapp_2' ? '(Número 2)' : '(Número 1)';
    document.getElementById('k-qr-overlay').classList.add('open');
    
    // [MODAL OPEN] — Modal QR aberta
    console.log(`
[MODAL OPEN]
┌─ timestamp: ${Date.now()}
├─ uid: ${_uid}
├─ slot: ${slot}
└─ motivo: usuario_clicou_conectar
    `);
  }

  function _closeQrModal(showSuccess) {
    const overlay = document.getElementById('k-qr-overlay');
    if (overlay) overlay.classList.remove('open');
    const slot = _activeQrSlot;
    
    // [MODAL CLOSED] — Modal QR fechada
    const motivo = showSuccess ? 'conexao_sucesso' : 'usuario_cancelou';
    console.log(`
[MODAL CLOSED]
┌─ timestamp: ${Date.now()}
├─ uid: ${_uid}
├─ slot: ${slot}
├─ showSuccess: ${showSuccess}
└─ motivo: ${motivo}
    `);
    
    _activeQrSlot = null;
    if (slot) { _stopQrPolling(slot); _clearConnTimer(slot); }
    if (showSuccess && typeof showToast === 'function') {
      const phone = slot && _state[slot]?.phone ? ' — ' + _state[slot].phone : '';
      showToast(`WhatsApp conectado${phone}! ✓`, 'success');
    }
  }

  async function _cancelQrModal() {
    const slot = _activeQrSlot;
    _closeQrModal(false);
    if (slot && _state[slot]?.status === 'connecting') {
      try {
        await fetch(`${BACKEND_URL}/whatsapp/disconnect`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uid: _uid, slot }),
        });
      } catch {}
      const ref = _ref(slot);
      if (ref) await ref.set({
        status: 'disconnected', phone: null, sessionId: null,
        qrGeneratedAt: null, updatedAt: Date.now(),
      }, { merge: true }).catch(() => {});
    }
  }

  function _setQrModalLoading(msg) {
    const body = document.getElementById('k-qr-body');
    if (!body) return;
    body.innerHTML = `
      <div class="k-qr-loading">
        <div class="k-qr-spinner"></div>
        <div class="k-qr-hint">${msg}</div>
      </div>`;
  }

  function _setQrModalImage(dataURI, slot) {
    const body = document.getElementById('k-qr-body');
    if (!body) return;
    
    // [SHOW QR] — Mostrando QR para o utilizador
    const qrSize = dataURI.length;
    console.log(`
[SHOW QR]
┌─ timestamp: ${Date.now()}
├─ uid: ${_uid}
├─ slot: ${slot}
├─ tamanhoBase64: ${qrSize} bytes
└─ src.length: ${qrSize}
    `);
    
    body.innerHTML = `
      <img class="k-qr-img" id="k-qr-img" src="${dataURI}" alt="QR Code WhatsApp">
      <div class="k-qr-hint">Abra o WhatsApp → <strong>Dispositivos ligados</strong> → <strong>Ligar um dispositivo</strong></div>
      <div class="k-qr-sub">O código expira em 60 segundos.</div>
      <button class="btn btn-sm k-qr-refresh-btn" onclick="ConnectionService.refreshQr('${slot}')">
        <i class="ti ti-refresh"></i> Atualizar QR
      </button>`;
    
    // Adicionar listeners aos eventos de imagem
    const img = body.querySelector('img');
    if (img) {
      // [IMG UPDATED] — Src atualizado
      console.log(`
[IMG UPDATED]
┌─ timestamp: ${Date.now()}
├─ uid: ${_uid}
├─ slot: ${slot}
├─ src.length: ${dataURI.length} bytes
└─ naturalWidth: 0 (loading)
      `);
      
      img.onload = () => {
        // [IMG LOADED] — Imagem carregada
        console.log(`
[IMG LOADED]
┌─ timestamp: ${Date.now()}
├─ uid: ${_uid}
├─ slot: ${slot}
├─ largura: ${img.naturalWidth}px
└─ altura: ${img.naturalHeight}px
        `);
      };
      
      img.onerror = (err) => {
        // [IMG ERROR] — Erro ao carregar imagem
        console.log(`
[IMG ERROR]
┌─ timestamp: ${Date.now()}
├─ uid: ${_uid}
├─ slot: ${slot}
├─ src.length: ${dataURI.length} bytes
└─ erro: ${err?.message || 'unknown'}
        `);
      };
    }
  }

  function _setQrModalError(msg) {
    const body = document.getElementById('k-qr-body');
    if (!body) return;
    const slot = _activeQrSlot || 'whatsapp_1';
    body.innerHTML = `
      <div class="k-qr-error">
        <i class="ti ti-alert-circle" style="font-size:28px;color:var(--k-danger,#ef4444)"></i>
        <div class="k-qr-hint">${msg}</div>
      </div>
      <button class="btn btn-sm btn-primary k-qr-retry-btn" onclick="ConnectionService.connectWhatsApp('${slot}')">
        <i class="ti ti-rotate-clockwise"></i> Tentar novamente
      </button>`;
  }

  function _ensureQrModal() {
    if (document.getElementById('k-qr-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id        = 'k-qr-overlay';
    overlay.className = 'k-qr-overlay';
    overlay.innerHTML = `
      <div class="k-qr-modal">
        <div class="k-qr-header">
          <div class="k-qr-header-left">
            <i class="ti ti-brand-whatsapp" style="color:#22c55e;font-size:18px"></i>
            <span>Conectar WhatsApp <span id="k-qr-slot-label" style="color:var(--k-muted);font-size:11px"></span></span>
          </div>
          <button class="k-qr-close" onclick="ConnectionService._closeModal()">
            <i class="ti ti-x"></i>
          </button>
        </div>
        <div class="k-qr-body" id="k-qr-body">
          <div class="k-qr-loading">
            <div class="k-qr-spinner"></div>
            <div class="k-qr-hint">A iniciar sessão…</div>
          </div>
        </div>
        <div class="k-qr-footer">
          <button class="btn btn-sm" onclick="ConnectionService._closeModal()">
            <i class="ti ti-x"></i> Cancelar
          </button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Renderização UI — cards dos dois slots
  // ══════════════════════════════════════════════════════════════════════

  let _flowNameCache = new Map();

  async function _flowNameFor(flowId) {
    if (!flowId) return null;
    if (_flowNameCache.has(flowId)) return _flowNameCache.get(flowId);
    try {
      const doc  = await FlowStorage.load(flowId);
      const name = doc?.name || null;
      _flowNameCache.set(flowId, name);
      return name;
    } catch { return null; }
  }

  function _renderAllUI() {
    SLOTS.forEach(slot => _renderSlot(slot, _state[slot] || _defaultState(slot)));
  }

  function _renderSlot(slot, data) {
    const isSlot2  = slot === 'whatsapp_2';
    const status   = data.status || 'disconnected';
    const suffix   = isSlot2 ? '2' : '1';

    // Card principal
    const pill  = document.getElementById(`wa-status-pill-${suffix}`);
    const label = document.getElementById(`wa-status-pill-label-${suffix}`);
    if (pill)  pill.className    = 'conn-status-pill ' + status;
    if (label) label.textContent = _statusLabel(status);

    const details = document.getElementById(`wa-card-details-${suffix}`);
    if (details) {
      if (status !== 'connected') {
        details.innerHTML = '';
      } else {
        const phone = data.phone || '—';
        details.innerHTML = `
          <div class="conn-card-detail-row"><i class="ti ti-phone" style="font-size:11px"></i> ${phone}</div>
          <div class="conn-card-detail-row" id="wa-card-flow-name-${suffix}"><i class="ti ti-hierarchy" style="font-size:11px"></i> A carregar fluxo…</div>`;
        _flowNameFor(data.activeFlowId).then(name => {
          const el = document.getElementById(`wa-card-flow-name-${suffix}`);
          if (!el) return;
          el.innerHTML = name
            ? `<i class="ti ti-hierarchy" style="font-size:11px"></i> ${name}`
            : `<i class="ti ti-alert-triangle" style="font-size:11px;color:#f59e0b"></i> Sem fluxo ativo`;
        });
      }
    }

    // Bloquear/mostrar o card do 2º número conforme o plano
    const card2Wrap = document.getElementById('wa-slot2-wrap');
    if (card2Wrap) {
      const maxSessions = _getMaxWhatsappNumbers(_plan);
      const slot2Available = maxSessions >= 2; // O slot 2 (índice 1) está disponível?
      card2Wrap.style.opacity      = slot2Available ? '1'      : '0.45';
      card2Wrap.style.pointerEvents = slot2Available ? 'auto'  : 'none';
      const lockBadge = document.getElementById('wa-slot2-lock');
      if (lockBadge) lockBadge.style.display = slot2Available ? 'none' : '';
    }
  }

  function _updateDashboardStat() {
    const count = SLOTS.filter(s => _state[s]?.status === 'connected').length;
    const valEl = document.getElementById('dash-wa-count');
    const stEl  = document.getElementById('dash-wa-status');
    if (valEl) valEl.textContent = count;
    if (stEl) {
      if (count > 0) { stEl.textContent = `${count} WhatsApp activo${count > 1 ? 's' : ''}`; stEl.style.color = 'var(--k-green)'; }
      else           { stEl.textContent = 'Nenhuma conexão activa'; stEl.style.color = 'var(--k-muted)'; }
    }
  }

  function _updateSidebarStatus() {
    const count = SLOTS.filter(s => _state[s]?.status === 'connected').length;
    const dot   = document.getElementById('sidebar-conn-dot');
    const lbl   = document.getElementById('sidebar-conn-label');
    if (dot) dot.style.background = count > 0 ? 'var(--k-green)' : 'var(--k-muted)';
    if (lbl) lbl.textContent = count === 0 ? '0 conexões activas'
                              : count === 1 ? '1 conexão activa'
                              : `${count} conexões activas`;
  }

  // ── Helpers ──────────────────────────────────────────────────────────
  function _set(id, val)    { const el = document.getElementById(id); if (el) el.textContent = val; }
  function _statusLabel(s)  { return { connected: 'Conectado', disconnected: 'Desconectado', connecting: 'A conectar…' }[s] || 'Desconectado'; }
  function getStatus(slot)  { return _state[slot || 'whatsapp_1']?.status || 'disconnected'; }
  function isConnected(slot){ return _state[slot || 'whatsapp_1']?.status === 'connected'; }
  function activeCount()    { return SLOTS.filter(s => _state[s]?.status === 'connected').length; }

  return {
    init, destroy,
    connectWhatsApp, disconnectWhatsApp, refreshQr,
    openManageChannel, closeManageChannel, changeActiveFlow,
    getStatus, isConnected, activeCount,
    _closeModal: () => _cancelQrModal(),
  };

})();
