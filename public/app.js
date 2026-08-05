(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const loginView = $('loginView');
  const mainView = $('mainView');
  const threadListEl = $('threadList');
  const messagesEl = $('messages');
  const approvalArea = $('approvalArea');
  const chatTitle = $('chatTitle');
  const statusLine = $('statusLine');
  const metaLine = $('metaLine');
  const inputBox = $('inputBox');

  const APP_VERSION = '8.9';
  const EFFORT_LABELS = { minimal: '极低', low: '轻度', medium: '中', high: '高', xhigh: '极高', max: '最高' };
  const STUCK_IDLE_SEC = 240;
  const STUCK_TOTAL_SEC = 600;
  let relayCfg = window.RELAY_CONFIG || null;
  if (!relayCfg && window.AndroidBridge && window.AndroidBridge.getRelayConfig) {
    try {
      const s = window.AndroidBridge.getRelayConfig();
      if (s) relayCfg = JSON.parse(s);
    } catch (_) {}
  }
  let currentEffort = 'medium';
  if (relayCfg && relayCfg.effort) {
    currentEffort = relayCfg.effort;
  } else if (window.AndroidBridge && window.AndroidBridge.getEffort) {
    try { currentEffort = window.AndroidBridge.getEffort() || 'medium'; } catch (_) {}
  }
  if (!EFFORT_LABELS[currentEffort]) currentEffort = 'medium';

  function getPersistentDeviceId() {
    if (window.AndroidBridge && window.AndroidBridge.getDeviceId) {
      try { return window.AndroidBridge.getDeviceId(); } catch (_) {}
    }
    let id = localStorage.getItem('codexDeviceId');
    if (!id) {
      id = 'web' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      try { localStorage.setItem('codexDeviceId', id); } catch (_) {}
    }
    return id;
  }
  let relayChannel = null;
  const relayChannelsSet = new Set();
  let relayPending = new Map();
  let relayRpcId = 0;
  let relayConnecting = false;

  function stopAllRelayChannels() {
    for (const ch of relayChannelsSet) {
      try { ch.stop(); } catch (_) {}
    }
    relayChannelsSet.clear();
  }

  const state = {
    threads: [],
    currentId: null,
    turnId: null,
    running: false,
    blocks: new Map(),   // itemId -> block element
    approvals: new Map(), // requestId -> card element
    pendingImages: []
  };
  let pinnedIds = new Set();
  try { pinnedIds = new Set(JSON.parse(localStorage.getItem('pinnedThreads') || '[]')); } catch (_) {}

  let es = null;
  let turnPollTimer = null;
  let thinkTimer = null;
  let turnWatchdog = null;
  let turnStartAt = 0;
  let lastTurnActivityAt = 0;
  let liveReplyId = null;
  let liveSeq = 0;
  let turnStartLastMsgId = null;
  let quotedMsg = null;
  let autoSpeak = true;
  autoSpeak = readAutoSpeakPref();
  const speakButtons = new Map();
  const ttsMem = new Map();
  const ttsGenerating = new Map();
  let ttsGenEpoch = 0;
  let ttsActiveKey = null;
  let ttsActiveState = 'idle';
  let ttsSession = 0;
  const ttsWaitResolvers = new Set();
  let ttsAudioEl = null;
  let ttsBlobUrl = null;
  let ttsStreamState = null;
  let ttsLanReader = null;
  const pollRefreshed = {}; // doneId -> true，轮询兜底刷新去重

  // ---------- 通信层（局域网 / 中继） ----------
  async function lanCall(method, params, timeoutMs) {
    let url, init;
    const json = () => ({ 'Content-Type': 'application/json' });
    switch (method) {
      case 'me':
        url = '/api/me'; init = { method: 'GET' };
        break;
      case 'threads':
        url = '/api/threads'; init = { method: 'GET' };
        break;
      case 'threadCreate':
        url = '/api/threads'; init = { method: 'POST', headers: json(), body: JSON.stringify(params || {}) };
        break;
      case 'threadRead':
        url = '/api/threads/' + encodeURIComponent(params.threadId); init = { method: 'GET' };
        break;
      case 'threadDelete':
        url = '/api/threads/' + encodeURIComponent(params.threadId); init = { method: 'DELETE' };
        break;
      case 'turnStart':
        url = '/api/threads/' + encodeURIComponent(params.threadId) + '/turns';
        init = { method: 'POST', headers: json(), body: JSON.stringify({ text: params.text, images: params.images || [] }) };
        break;
      case 'interrupt':
        url = '/api/threads/' + encodeURIComponent(params.threadId) + '/interrupt';
        init = { method: 'POST', headers: json(), body: JSON.stringify({ turnId: params.turnId }) };
        break;
      case 'approve':
        url = '/api/approve';
        init = { method: 'POST', headers: json(), body: JSON.stringify({ requestId: params.requestId, decision: params.decision }) };
        break;
      case 'ttsGenerate':
        url = '/api/tts';
        init = { method: 'POST', headers: json(), body: JSON.stringify({ text: (params && params.text) || '' }) };
        break;
      case 'ttsStatus':
        url = '/api/tts/status';
        init = { method: 'POST', headers: json(), body: JSON.stringify({ text: (params && params.text) || '' }) };
        break;
      default:
        throw new Error('未知方法: ' + method);
    }
    const r = await fetch(url, init);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '请求失败');
    return data;
  }

  function relayCall(method, params, timeoutMs) {
    if (!relayChannel || !relayChannel.ready) return Promise.reject(new Error('中继未连接'));
    const id = ++relayRpcId;
    return new Promise((resolve, reject) => {
      relayPending.set(id, { resolve, reject });
      relayChannel.send({ type: 'rpc', id, method, params: params || {}, clientId: relayChannel.clientId }).catch(e => {
        relayPending.delete(id);
        reject(e);
      });
      setTimeout(() => {
        if (relayPending.has(id)) {
          relayPending.delete(id);
          reject(new Error('请求超时: ' + method));
        }
      }, timeoutMs || 120000);
    });
  }

  function rejectPendingRelay(reason) {
    for (const p of relayPending.values()) {
      try { p.reject(new Error(reason)); } catch (_) {}
    }
    relayPending.clear();
  }

  function apiCall(method, params, timeoutMs) {
    return relayCfg ? relayCall(method, params, timeoutMs) : lanCall(method, params, timeoutMs);
  }

  function onRelayMessage(msg) {
    if (!msg) return;
    if (msg.type === 'phone-rpc') {
      handlePhoneRpc(msg);
      return;
    }
    if (msg.type === 'response') {
      if (msg.to && relayChannel && msg.to !== relayChannel.clientId) return;
      const p = relayPending.get(msg.id);
      if (p) {
        relayPending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error || '请求失败'));
      }
      return;
    }
    if (msg.type === 'tts-stream') {
      if (msg.to && relayChannel && msg.to !== relayChannel.clientId) return;
      ttsStreamPush({ id: msg.id, b64: msg.b64 });
      return;
    }
    if (msg.type === 'tts-stream-end') {
      if (msg.to && relayChannel && msg.to !== relayChannel.clientId) return;
      ttsStreamPush({ id: msg.id, end: true, ok: msg.ok, error: msg.error });
      return;
    }
    if (msg.type === 'event' && msg.payload) {
      const payload = msg.payload;
      if (payload.type === 'notification') {
        handleNotification({ method: payload.method, params: payload.params });
      } else if (payload.type === 'approval-request') {
        traceEvent('approval-request');
        handleApprovalRequest(payload);
      }
    }
  }

  async function handlePhoneRpc(msg) {
    if (msg.to && relayChannel && msg.to !== relayChannel.clientId) return;
    const id = msg.id;
    try {
      if (msg.method === 'listApps') {
        let list = [];
        if (window.AndroidBridge && window.AndroidBridge.getInstalledApps) {
          const s = window.AndroidBridge.getInstalledApps();
          list = JSON.parse(s || '[]');
        }
        addSystemLine('📱 电脑正在读取手机应用列表…');
        relayChannel.send({ type: 'phone-rpc-response', id, ok: true, result: { apps: list } }).catch(() => {});
      } else if (msg.method === 'uninstallApp') {
        const pkg = (msg.params && msg.params.package) || '';
        if (!pkg) throw new Error('缺少包名');
        if (!window.AndroidBridge || !window.AndroidBridge.uninstallApp) throw new Error('当前页面不支持卸载');
        const r = window.AndroidBridge.uninstallApp(pkg);
        addSystemLine('📱 电脑请求卸载: ' + pkg + '（请在系统弹窗确认）');
        relayChannel.send({ type: 'phone-rpc-response', id, ok: true, result: { started: !!r } }).catch(() => {});
      } else if (msg.method === 'openApp' || msg.method === 'openAppBackground' || msg.method === 'openAppSettings') {
        const pkg = (msg.params && msg.params.package) || '';
        if (!pkg) throw new Error('缺少包名');
        if (!window.AndroidBridge || !window.AndroidBridge[msg.method]) throw new Error('当前页面不支持此操作');
        const r = window.AndroidBridge[msg.method](pkg);
        addSystemLine('📱 电脑请求: ' + (msg.method === 'openApp' ? '打开应用 ' + pkg : msg.method === 'openAppBackground' ? '后台打开应用 ' + pkg : '打开应用设置 ' + pkg));
        relayChannel.send({ type: 'phone-rpc-response', id, ok: true, result: { started: !!r } }).catch(() => {});
      } else if (msg.method === 'goHome' || msg.method === 'requestIgnoreBattery') {
        if (!window.AndroidBridge || !window.AndroidBridge[msg.method]) throw new Error('当前页面不支持此操作');
        const r = window.AndroidBridge[msg.method]();
        addSystemLine('📱 电脑请求: ' + (msg.method === 'goHome' ? '返回手机桌面' : '打开电池优化设置'));
        relayChannel.send({ type: 'phone-rpc-response', id, ok: true, result: { started: !!r } }).catch(() => {});
      } else {
        throw new Error('未知手机操作: ' + msg.method);
      }
    } catch (e) {
      relayChannel.send({ type: 'phone-rpc-response', id, ok: false, error: (e && e.message) || '操作失败' }).catch(() => {});
    }
  }

  async function connectRelay() {
    if (relayConnecting) return;
    relayConnecting = true;
    if (!window.crypto || !window.crypto.subtle) {
      setStatus('手机浏览器不支持加密', true);
      showToast('当前手机浏览器不支持加密，请更新系统 WebView 后再试', true);
      relayConnecting = false;
      return;
    }
    setStatus('正在连接中继…', true);
    try {
      const brokers = [];
      try {
        const w = localStorage.getItem('workingBroker');
        if (w) brokers.push(w);
      } catch (_) {}
      if (relayCfg && relayCfg.broker) brokers.push(relayCfg.broker);
      brokers.push('wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081/mqtt');
      const seen = new Set();
      let lastErr = '中继连接失败';
      stopAllRelayChannels();
      relayChannel = null;
      for (const broker of brokers) {
        if (seen.has(broker)) continue;
        seen.add(broker);
        try {
          const ch = await tryRelayBroker(broker);
          relayChannel = ch;
          try { localStorage.setItem('workingBroker', broker); } catch (_) {}
          testPairing();
          loadThreads();
          break;
        } catch (e) {
          lastErr = (e && e.message) || lastErr;
        }
      }
      if (!relayChannel) throw new Error(lastErr);
    } catch (e) {
      setStatus('中继连接失败: ' + e.message, true);
      showToast('中继连接失败: ' + e.message, true);
    } finally {
      relayConnecting = false;
    }
  }

  function tryRelayBroker(broker) {
    return new Promise((resolve, reject) => {
      let settled = false;
      function fail(err) {
        if (settled) return;
        settled = true;
        if (relayChannel === ch) relayChannel = null;
        try { ch.stop(); } catch (_) {}
        relayChannelsSet.delete(ch);
        reject(err);
      }
      function pingVia(targetCh) {
        return new Promise((res, rej) => {
          const id = ++relayRpcId;
          const timer = setTimeout(() => {
            relayPending.delete(id);
            rej(new Error('配对超时'));
          }, 8000);
          relayPending.set(id, {
            resolve: (r) => { clearTimeout(timer); res(r); },
            reject: (e) => { clearTimeout(timer); rej(e); }
          });
          targetCh.send({ type: 'rpc', id, method: 'ping', params: {}, clientId: targetCh.clientId }).catch(e => {
            relayPending.delete(id);
            clearTimeout(timer);
            rej(e);
          });
        });
      }
      const ch = new RelayChannel({
        broker,
        roomCode: relayCfg.roomCode,
        password: relayCfg.password,
        clientId: 'cb_' + getPersistentDeviceId(),
        role: 'phone',
        onMessage: onRelayMessage,
        onError: (s) => {
          setStatus('配对异常: ' + s, true);
          showToast('⚠ ' + s + '：请检查手机里的配对码和访问密码是否与电脑一致', true);
        },
        onChunkError: (s) => {
          if (ttsActiveKey || ttsStreamState) {
            showToast('音频传输中断，正在重试…', true);
          }
        },
        onStatus: (s) => {
          if (s === 'connected') {
            if (!ch._connected) {
              ch._connected = true;
              setStatus('中继已连接');
              showToast('中继已连接');
              addSystemLine('中继已连接 · ' + new Date().toLocaleTimeString());
              relayChannel = ch;
              pingVia(ch).then(() => {
                if (settled) return;
                settled = true;
                resolve(ch);
              }).catch((e) => {
                fail(new Error('配对验证失败: ' + ((e && e.message) || e)));
              });
            } else {
              setStatus('中继已连接');
              addSystemLine('中继已恢复 · ' + new Date().toLocaleTimeString());
              testPairing();
              loadThreads();
            }
          } else {
            setStatus(s, true);
            rejectPendingRelay('中继连接断开，正在重连…');
            if (s.indexOf('失败') >= 0) showToast(s, true);
            if (!ch._connected) fail(new Error(s || '连接失败'));
          }
        }
      });
      relayChannelsSet.add(ch);
      ch.start().catch(e => {
        fail(new Error('无法连接中继服务器: ' + ((e && e.message) || e)));
      });
      setTimeout(() => {
        if (!settled) fail(new Error('中继连接超时'));
      }, 15000);
    });
  }

  async function testPairing() {
    try {
      const r = await Promise.race([
        relayCall('ping', {}),
        new Promise((_, reject) => setTimeout(() => reject(new Error('配对测试超时')), 10000))
      ]);
      addSystemLine('配对成功 · 电脑端版本 v' + ((r && r.version) || '?'));
      showToast('配对成功，密码一致 ✓');
    } catch (e) {
      if ((e.message || '').indexOf('未知方法') >= 0) {
        addSystemLine('配对成功 · 通道正常（电脑端版本较旧）');
        showToast('配对成功，密码一致 ✓');
      } else {
        setStatus('配对失败: ' + e.message, true);
        const tip = '⚠ 配对失败：手机保存的配对码/密码与电脑不一致，请核对电脑窗口显示的值后点「重连」';
        addSystemLine(tip);
        showToast(tip, true);
      }
    }
  }

  // ---------- login ----------
  async function init() {
    if (relayCfg) {
      loginView.classList.add('hidden');
      mainView.classList.remove('hidden');
      metaLine.textContent = 'v' + APP_VERSION + ' ｜ 中继模式 ｜ 配对码: ' + relayCfg.roomCode + ' ｜ 推理: ' + (EFFORT_LABELS[currentEffort] || currentEffort);
      $('reconnectBtn').classList.remove('hidden');
      await connectRelay();
      loadThreads();
      return;
    }
    try {
      const r = await fetch('/api/me');
      const data = await r.json();
      if (data.ok) {
        showMain(data);
      } else {
        showLogin();
      }
    } catch (_) {
      showLogin();
    }
  }

  function showLogin() {
    loginView.classList.remove('hidden');
    mainView.classList.add('hidden');
  }

  function showMain(meta) {
    loginView.classList.add('hidden');
    mainView.classList.remove('hidden');
    metaLine.textContent = 'v' + APP_VERSION + ' ｜ 工作目录: ' + meta.workspace + (meta.model ? ' ｜ 模型: ' + meta.model : '');
    loadThreads();
    if (!relayCfg) connectSSE();
  }

  $('loginBtn').addEventListener('click', async () => {
    const pw = $('passwordInput').value;
    $('loginError').classList.add('hidden');
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw })
      });
      if (r.ok) {
        const meta = await (await fetch('/api/me')).json();
        showMain(meta);
      } else {
        $('loginError').classList.remove('hidden');
      }
    } catch (_) {
      $('loginError').textContent = '连接失败，请确认电脑端软件在运行';
      $('loginError').classList.remove('hidden');
    }
  });

  // ---------- threads ----------
  async function loadThreads() {
    try {
      const data = await apiCall('threads');
      state.threads = Array.isArray(data) ? data : (data.threads || data.data || []);
      renderThreads();
      if (!state.running) setStatus('已连接');
    } catch (e) {
      setStatus('无法读取会话列表', true);
      showToast('读取会话列表失败', true);
    }
  }

  function renderThreads() {
    threadListEl.innerHTML = '';
    if (!state.threads.length) {
      threadListEl.innerHTML = '<div class="meta-line" style="padding:12px">还没有对话，点“新对话”开始</div>';
      return;
    }
    const sorted = [...state.threads].sort((a, b) => {
      const ap = pinnedIds.has(a.id) ? 0 : 1;
      const bp = pinnedIds.has(b.id) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    for (const t of sorted) {
      const el = document.createElement('div');
      el.className = 'thread-item' + (t.id === state.currentId ? ' active' : '');
      const title = t.name || t.title || t.preview || '（无标题）';
      const time = new Date((t.updatedAt || Date.now()) * 1000).toLocaleString();
      el.innerHTML = '<div class="t-title">' + (pinnedIds.has(t.id) ? '📌 ' : '') + escapeHtml(title) + '</div><div class="t-time">' + time + '</div>';
      let longPressed = false;
      let pressTimer = null;
      el.addEventListener('click', () => {
        if (longPressed) { longPressed = false; return; }
        openThread(t.id);
      });
      el.addEventListener('touchstart', (e) => {
        longPressed = false;
        pressTimer = setTimeout(() => {
          longPressed = true;
          const t0 = e.touches[0];
          showThreadMenu(t.id, t0.clientX, t0.clientY);
        }, 500);
      }, { passive: true });
      el.addEventListener('touchmove', () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } }, { passive: true });
      el.addEventListener('touchend', () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } });
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showThreadMenu(t.id, e.clientX, e.clientY);
      });
      threadListEl.appendChild(el);
    }
  }

  function showThreadMenu(threadId, x, y) {
    hideThreadMenu();
    const overlay = document.createElement('div');
    overlay.className = 'thread-menu-overlay';
    overlay.addEventListener('touchstart', hideThreadMenu, { passive: true });
    overlay.addEventListener('click', hideThreadMenu);
    const menu = document.createElement('div');
    menu.className = 'thread-menu';
    const pinned = pinnedIds.has(threadId);
    const btnPin = document.createElement('button');
    btnPin.textContent = pinned ? '取消置顶' : '置顶';
    btnPin.addEventListener('click', () => { togglePin(threadId); hideThreadMenu(); });
    const btnDel = document.createElement('button');
    btnDel.textContent = '删除对话';
    btnDel.classList.add('danger');
    btnDel.addEventListener('click', () => { hideThreadMenu(); deleteThread(threadId); });
    menu.appendChild(btnPin);
    menu.appendChild(btnDel);
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - 150)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - 110)) + 'px';
    document.body.appendChild(overlay);
    document.body.appendChild(menu);
  }

  function hideThreadMenu() {
    const o = document.querySelector('.thread-menu-overlay');
    if (o) o.remove();
    const m = document.querySelector('.thread-menu');
    if (m) m.remove();
  }

  function togglePin(threadId) {
    if (pinnedIds.has(threadId)) pinnedIds.delete(threadId);
    else pinnedIds.add(threadId);
    try { localStorage.setItem('pinnedThreads', JSON.stringify([...pinnedIds])); } catch (_) {}
    renderThreads();
  }

  async function deleteThread(threadId) {
    try {
      await apiCall('threadDelete', { threadId });
      state.threads = state.threads.filter(t => t.id !== threadId);
      if (state.currentId === threadId) {
        state.currentId = null;
        state.turnId = null;
        state.running = false;
        stopTurnPolling();
        stopTurnWatchdog();
        messagesEl.innerHTML = '';
        approvalArea.innerHTML = '';
        state.blocks.clear();
        chatTitle.textContent = '新对话';
        setStatus('已连接');
      }
      renderThreads();
    } catch (e) {
      showToast('删除失败: ' + e.message, true);
    }
  }

  async function newThread() {
    try {
      const data = await apiCall('threadCreate', {});
      const thread = data.thread || data;
      if (thread && thread.id) {
        await openThread(thread.id);
        loadThreads();
      } else {
        throw new Error(JSON.stringify(data));
      }
    } catch (e) {
      setStatus('创建对话失败: ' + e.message, true);
      showToast('创建对话失败: ' + e.message, true);
    }
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function isTransientThreadErr(msg) {
    return /超时|中继未连接|连接断开|fetch failed|network|ECONN/i.test(msg || '');
  }

  async function openThread(id) {
    stopTurnPolling();
    stopTurnWatchdog();
    if (id !== state.currentId) {
      stopSpeaking();
      deleteAllTemps();
    }
    liveReplyId = null;
    clearQuote();
    state.currentId = id;
    state.blocks.clear();
    speakButtons.clear();
    state.approvals.clear();
    approvalArea.innerHTML = '';
    messagesEl.innerHTML = '';
    const t = state.threads.find(x => x.id === id);
    chatTitle.textContent = (t && (t.name || t.title || t.preview)) || '对话中…';
    renderThreads();
    closeSidebar();
    setStatus('正在读取历史对话…');
    const loadingEl = document.createElement('div');
    loadingEl.className = 'thread-loading system-line';
    loadingEl.textContent = '⏳ 正在读取历史对话，请稍候…';
    messagesEl.appendChild(loadingEl);
    const ticker = setTimeout(() => {
      loadingEl.textContent = '⏳ 读取较慢：首次打开旧对话需要电脑恢复线程，请再稍候…';
    }, 8000);
    let lastErr = '';
    try {
      let data = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          data = await apiCall('threadRead', { threadId: id });
          break;
        } catch (e) {
          lastErr = (e && e.message) || '未知错误';
          if (attempt === 0 && isTransientThreadErr(lastErr)) {
            await sleep(800);
            continue;
          }
          throw e;
        }
      }
      if (state.currentId !== id) return;
      const thread = data.thread || data;
      const thName = thread.name || thread.title || thread.preview;
      if (thName) chatTitle.textContent = thName;
      if (thread.status && thread.status.type === 'active') {
        state.running = true;
        setStatus('正在运行…');
      } else {
        state.running = false;
        setStatus('已连接');
      }
      $('interruptBtn').classList.toggle('hidden', !state.running);
      clearTimeout(ticker);
      messagesEl.innerHTML = '';
      renderHistory(thread.turns || []);
      scrollBottom();
      restoreSpeakBtnState();
    } catch (e) {
      clearTimeout(ticker);
      if (state.currentId !== id) return;
      loadingEl.remove();
      const msg = (e && e.message) || lastErr || '未知错误';
      setStatus('读取对话失败', true);
      const failEl = document.createElement('div');
      failEl.className = 'thread-loading system-line';
      failEl.innerHTML = '⚠ 读取历史对话失败：' + escapeHtml(msg) + '　<span class="link-btn" id="retryThreadBtn">点此重试</span>';
      messagesEl.appendChild(failEl);
      const btn = failEl.querySelector('#retryThreadBtn');
      if (btn) btn.addEventListener('click', () => { failEl.remove(); openThread(id); });
      showToast('读取对话失败: ' + msg, true);
    }
  }

  function renderHistory(turns) {
    const aiIds = [];
    for (const turn of turns) {
      for (const item of (turn.items || [])) {
        renderHistoryItem(item);
        if (item.type === 'agentMessage' && (item.text || '').trim()) aiIds.push(item.id);
      }
      if (turn.status === 'inProgress') {
        state.turnId = turn.id;
        state.running = true;
        setStatus('正在运行…');
      }
    }
    updateThinkingIndicator(state.running);
    pruneConvAudio(state.currentId, aiIds);
  }

  function renderHistoryItem(item) {
    if (item.type === 'userMessage') {
      let text = '';
      const images = [];
      for (const c of (item.content || [])) {
        if (c.type === 'text') text += c.text;
        if (c.type === 'localImage' || c.type === 'image') {
          const w = toWebPath(c.path || c.url);
          if (w) images.push(w);
        }
      }
      text = text.replace(/\n\n\[系统要求：请始终使用简体中文回复用户。\]$/, '');
      addUserMessage(text, images);
      return;
    }
    const agentEl = ensureAgentBubble();
    if (item.type === 'agentMessage') {
      addBlock(agentEl, { kind: 'text', id: item.id, text: item.text || '' });
    } else if (item.type === 'commandExecution') {
      addBlock(agentEl, {
        kind: 'cmd', id: item.id, label: '正在执行电脑命令…',
        status: item.status || '', output: item.output || '', command: ''
      });
    } else if (item.type === 'fileChange') {
      const files = (item.files || []).map(f => f.path || f.filePath || '').join(', ');
      addBlock(agentEl, { kind: 'file', id: item.id, files, status: item.status || '' });
    } else if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall' || item.type === 'webSearch') {
      const label = friendlyToolLabel(item);
      addBlock(agentEl, { kind: 'tool', id: item.id, label, status: item.status || '' });
    }
  }

  function friendlyToolLabel(item) {
    const name = String(item.tool || item.server || item.type || '').toLowerCase();
    if (name.indexOf('list_phone_apps') >= 0) return '正在读取手机应用列表…';
    if (name.indexOf('uninstall_phone_app') >= 0) return '正在请求卸载手机应用…';
    if (name.indexOf('list_mcp_resource') >= 0) return '正在查找可用的手机工具…';
    if (name.indexOf('exec') >= 0 || name.indexOf('shell') >= 0 || name.indexOf('command') >= 0) return '正在执行电脑命令…';
    if (name.indexOf('search') >= 0) return '正在搜索…';
    if (name.indexOf('open_page') >= 0) return '正在打开网页…';
    if (item.type === 'webSearch') return '正在搜索…';
    return '正在调用工具…';
  }

  // ---------- rendering helpers ----------
  function ensureAgentBubble() {
    let last = messagesEl.lastElementChild;
    if (last && last.classList.contains('msg') && last.classList.contains('agent')) return last;
    const el = document.createElement('div');
    el.className = 'msg agent';
    el.innerHTML = '<div class="bubble"></div>' +
      '<div class="msg-actions">' +
      '<button class="msg-act speak-btn">🔊 朗读</button>' +
      '<button class="msg-act">复制</button><button class="msg-act">引用</button>' +
      '</div>';
    const spk = el.querySelector('.speak-btn');
    if (spk && !spk._bound) {
      spk._bound = true;
      spk.addEventListener('click', () => onSpeakClick(el));
    }
    const copyBtn = el.querySelectorAll('.msg-act')[1];
    const quoteBtn = el.querySelectorAll('.msg-act')[2];
    copyBtn.addEventListener('click', () => copyText(el.querySelector('.bubble').innerText.trim()));
    quoteBtn.addEventListener('click', () => setQuote('AI', el.querySelector('.bubble').innerText.trim()));
    messagesEl.appendChild(el);
    return el;
  }

  function addUserMessage(text, images) {
    const el = document.createElement('div');
    el.className = 'msg user';
    let imgs = '';
    if (images && images.length) {
      imgs = '<div class="imgs">' + images.map(u => '<img src="' + u + '">').join('') + '</div>';
    }
    el.innerHTML = '<div class="wrap">' + imgs + '<div class="bubble">' + escapeHtml(text) + '</div></div>' +
      '<div class="msg-actions">' +
      '<button class="msg-act">复制</button><button class="msg-act">引用</button>' +
      '</div>';
    const btns = el.querySelectorAll('.msg-act');
    btns[0].addEventListener('click', () => copyText(text));
    btns[1].addEventListener('click', () => setQuote('我', text));
    messagesEl.appendChild(el);
    scrollBottom();
  }

  function addBlock(agentEl, data) {
    const bubble = agentEl.querySelector('.bubble');
    let block = state.blocks.get(data.id);
    if (!block) {
      block = document.createElement('div');
      block.className = 'block';
      block.dataset.id = data.id;
      bubble.appendChild(block);
      state.blocks.set(data.id, block);
    }
    if (data.kind === 'text' && data.id) {
      agentEl.dataset.msgId = data.id;
      updateSpeakBtnKey(agentEl, data.id);
    }
    renderBlock(block, data);
    scrollBottom();
    return block;
  }

  function renderBlock(block, d) {
    if (d.kind === 'text') {
      block.classList.add('agent-text');
      if (d.typing) block.classList.add('typing'); else block.classList.remove('typing');
      block.textContent = d.text || '';
    } else if (d.kind === 'cmd') {
      block.className = 'block cmd';
      block.innerHTML = '<div class="cmd-line">🔧 ' + escapeHtml(d.label || '正在执行电脑命令…') +
        (d.status ? ' <span class="cmd-status">' + escapeHtml(d.status) + '</span>' : '') + '</div>' +
        (d.output ? '<pre class="cmd-output">' + escapeHtml(d.output) + '</pre>' : '');
    } else if (d.kind === 'file') {
      block.className = 'block file';
      block.textContent = '📝 修改文件: ' + (d.files || '') + (d.status ? ' ｜ ' + d.status : '');
    } else if (d.kind === 'tool') {
      block.className = 'block tool';
      block.textContent = '🔧 ' + (d.label || d.status || '工具调用');
    }
  }

  function scrollBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ---------- SSE ----------
  function connectSSE() {
    if (es) { es.close(); }
    es = new EventSource('/events');
    es.onopen = () => setStatus('已连接');
    es.onerror = () => {
      setStatus('连接中断，重连中…', true);
      showToast('与电脑的连接中断，正在重连…', true);
      setTimeout(connectSSE, 2000);
    };
    es.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.type === 'notification') handleNotification(msg);
      else if (msg.type === 'approval-request') handleApprovalRequest(msg);
    };
  }

  function handleNotification(msg) {
    const method = msg.method;
    const params = msg.params || {};
    if (!params.threadId) return;
    if (params.threadId && (!state.currentId || params.threadId !== state.currentId)) return;
    traceEvent(method);
    lastTurnActivityAt = Date.now();

    if (method === 'turn/started') {
      state.turnId = params.turn && params.turn.id;
      state.running = true;
      turnStartLastMsgId = currentLastMsgId();
      deleteTempsForConv(state.currentId);
      setStatus('正在运行…');
      $('interruptBtn').classList.remove('hidden');
      turnStartAt = Date.now();
      lastTurnActivityAt = Date.now();
      liveReplyId = null;
      updateThinkingIndicator(true);
      startTurnPolling();
      startTurnWatchdog();
    } else if (method === 'turn/completed') {
      stopTurnPolling();
      stopTurnWatchdog();
      updateThinkingIndicator(false);
      state.running = false;
      state.turnId = null;
      setStatus(params.turn && params.turn.status === 'failed' ? '出错: ' + ((params.turn.error && params.turn.error.message) || '未知错误') : '已完成');
      $('interruptBtn').classList.add('hidden');
      for (const b of state.blocks.values()) b.classList.remove('typing');
      loadThreads();
      const tid = params.turn && params.turn.id;
      // 优先用回合数据触发（不依赖 DOM 是否已渲染），DOM 作为兜底
      let triggered = false;
      const turnAgent = lastAgentFromThread(params.turn);
      if (turnAgent) triggered = tryAutoSpeakMessage(state.currentId, turnAgent.id, turnAgent.text);
      if (!triggered) triggered = maybeAutoSpeak();
      console.log('[turn] completed tid=' + (tid || '-') + ' autoSpeak=' + autoSpeak + ' triggered=' + triggered);
      // 未触发时：后台刷新 + 自动重试（最多 3 次，间隔 2 秒，每次都用最新数据再试）
      setTimeout(async () => {
        if (state.turnId && state.turnId !== tid) return;
        for (let attempt = 0; attempt < 3 && !triggered; attempt++) {
          const thread = await refreshThreadNow();
          if (state.turnId && state.turnId !== tid) return;
          if (!triggered) {
            const ta = thread ? lastAgentFromThread(thread) : null;
            if (ta) triggered = tryAutoSpeakMessage(state.currentId, ta.id, ta.text);
          }
          if (!triggered) triggered = maybeAutoSpeak();
          if (!triggered && attempt < 2) await sleep(2000);
        }
      }, 0);
    } else if (method === 'turn/error') {
      stopTurnPolling();
      stopTurnWatchdog();
      updateThinkingIndicator(false);
      state.running = false;
      liveReplyId = null;
      setStatus('运行出错', true);
    } else if (method === 'item/started') {
      const item = params.item || {};
      onItemStarted(item);
    } else if (method === 'item/agentMessage/delta') {
      let bid = params.itemId || liveReplyId;
      let block = bid ? state.blocks.get(bid) : null;
      if (!block) {
        if (!bid) {
          bid = 'live-' + state.turnId + '-' + (++liveSeq);
          liveReplyId = bid;
        }
        const agentEl = ensureAgentBubble();
        block = addBlock(agentEl, { kind: 'text', id: bid, text: '', typing: true });
      }
      block.classList.add('typing');
      block.textContent = (block.textContent || '') + deltaText(params);
      scrollBottom();
    } else if (method === 'item/commandExecution/outputDelta') {
      let block = state.blocks.get(params.itemId);
      if (!block) {
        const agentEl = ensureAgentBubble();
        block = addBlock(agentEl, { kind: 'cmd', id: params.itemId, label: '正在执行电脑命令…', status: '进行中', output: '' });
      }
      const out = block.querySelector('.out');
      if (out) {
        out.textContent += params.delta || '';
        out.scrollTop = out.scrollHeight;
      }
    } else if (method === 'item/completed') {
      onItemCompleted(params.item || {});
    }
  }

  function onItemStarted(item) {
    if (item.type === 'userMessage') return;
    const agentEl = ensureAgentBubble();
    updateThinkingIndicator(true);
    if (item.type === 'agentMessage') {
      const block = addBlock(agentEl, { kind: 'text', id: item.id, text: '', typing: true });
      block.classList.add('typing');
      liveReplyId = item.id;
    } else if (item.type === 'commandExecution') {
      addBlock(agentEl, {
        kind: 'cmd', id: item.id, label: '正在执行电脑命令…',
        status: '进行中', output: ''
      });
    } else if (item.type === 'fileChange') {
      const files = (item.files || []).map(f => f.path || '').join(', ');
      addBlock(agentEl, { kind: 'file', id: item.id, files, status: item.status || 'pending' });
    } else if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall' || item.type === 'webSearch') {
      const label = friendlyToolLabel(item);
      addBlock(agentEl, { kind: 'tool', id: item.id, label, status: '进行中' });
    }
  }

  function onItemCompleted(item) {
    if (item.type === 'userMessage') return;
    const block = state.blocks.get(item.id);
    if (!block) {
      const data = itemToBlockData(item);
      if (!data) return;
      const agentEl = ensureAgentBubble();
      addBlock(agentEl, data);
      return;
    }
    block.classList.remove('typing');
    if (item.type === 'agentMessage') {
      const cur = (block.textContent || '').trim();
      if (item.text && (!cur || item.text.length > cur.length)) block.textContent = item.text;
      block.classList.add('agent-text');
    } else if (item.type === 'commandExecution') {
      renderBlock(block, { kind: 'cmd', id: item.id, label: '正在执行电脑命令…', status: item.status || '', output: item.output || '', command: '' });
    } else if (item.type === 'fileChange') {
      const files = (item.files || []).map(f => f.path || '').join(', ');
      block.className = 'block file';
      block.textContent = '📝 修改文件: ' + files + (item.status ? ' ｜ ' + item.status : '');
    } else if (item.type === 'reasoning') {
      block.className = 'block reason';
      block.textContent = '💭 ' + (item.summary || item.text || block.textContent.replace(/^💭 /, ''));
    } else if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall' || item.type === 'webSearch') {
      block.className = 'block tool';
      const label = item.type === 'webSearch' ? '搜索: ' + (item.query || '')
        : (item.type === 'mcpToolCall' ? (item.server || '') + ' → ' + (item.tool || '') : '工具: ' + (item.tool || ''));
      block.textContent = '🔧 ' + label + (item.status ? ' ｜ ' + item.status : '');
    }
    scrollBottom();
  }

  async function refreshThreadNow() {
    if (!state.currentId) return null;
    // 失败可见 + 自动重试一次，返回读取到的线程数据（供自动朗读直接用）
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const data = await apiCall('threadRead', { threadId: state.currentId });
        const thread = data.thread || data;
        state.blocks.clear();
        speakButtons.clear();
        state.approvals.clear();
        approvalArea.innerHTML = '';
        messagesEl.innerHTML = '';
        const thName = thread.name || thread.title || thread.preview;
        if (thName) chatTitle.textContent = thName;
        if (thread.status && thread.status.type === 'active') {
          state.running = true;
          setStatus('正在运行…');
        } else {
          state.running = false;
          setStatus('已连接');
        }
        renderHistory(thread.turns || []);
        scrollBottom();
        let hasText = false;
        for (const t of (thread.turns || [])) {
          for (const item of (t.items || [])) {
            if ((item.type === 'agentMessage' || item.type === 'reasoning') && ((item.text || item.summary || '')).trim()) { hasText = true; break; }
          }
          if (hasText) break;
        }
        if (!hasText) addSystemLine('⚠ 本轮已完成，但没收到回复内容（请把电脑窗口的文字发给我）');
        restoreSpeakBtnState();
        return thread;
      } catch (e) {
        console.log('[refresh] threadRead 失败: ' + ((e && e.message) || e));
        if (attempt === 0) await sleep(2000);
      }
    }
    return null;
  }

  function refreshThreadFromData(thread) {
    state.blocks.clear();
    speakButtons.clear();
    state.approvals.clear();
    approvalArea.innerHTML = '';
    messagesEl.innerHTML = '';
    const thName = thread.name || thread.title || thread.preview;
    if (thName) chatTitle.textContent = thName;
    if (thread.status && thread.status.type === 'active') {
      state.running = true;
      setStatus('正在运行…');
    } else {
      state.running = false;
      setStatus('已连接');
    }
    $('interruptBtn').classList.toggle('hidden', !state.running);
    renderHistory(thread.turns || []);
    scrollBottom();
    updateThinkingIndicator(state.running);
    restoreSpeakBtnState();
  }

  function startTurnPolling() {
    stopTurnPolling();
    turnPollTimer = setInterval(async () => {
      if (!state.currentId || !state.running) {
        stopTurnPolling();
        return;
      }
      try {
        const data = await apiCall('threadRead', { threadId: state.currentId });
        const thread = data.thread || data;
        const turns = thread.turns || [];
        const targetTurnId = state.turnId;
        let target = null;
        if (targetTurnId) target = turns.find(t => t.id === targetTurnId) || null;
        if (!target && turns.length) target = turns[turns.length - 1];
        if (!target) return;
        const threadIdle = !(thread.status && thread.status.type === 'active');
        const turnDone = threadIdle || (target.status && target.status !== 'inProgress');
        if (!turnDone) return;
        stopTurnPolling();
        const doneId = target.id;
        if (!pollRefreshed[doneId]) {
          pollRefreshed[doneId] = true;
          refreshThreadFromData(thread);
          maybeAutoSpeak(); // turn/completed 事件丢失时，轮询兜底也触发自动朗读
        }
      } catch (_) {}
    }, 1800);
  }

  function stopTurnPolling() {
    if (turnPollTimer) {
      clearInterval(turnPollTimer);
      turnPollTimer = null;
    }
  }

  function startTurnWatchdog() {
    stopTurnWatchdog();
    let watchdogRefreshed = false;
    function doTimeoutStop() {
      stopTurnWatchdog();
      stopTurnPolling();
      setStatus('思考超时，正在自动停止…', true);
      addSystemLine('⚠ 思考超过时限，已自动停止。可调低推理强度后重试，或点右上角「停止」。');
      if (state.turnId) {
        apiCall('interrupt', { threadId: state.currentId, turnId: state.turnId }).then(() => {
          setStatus('已超时终止', true);
        }).catch(() => {});
      }
    }
    turnWatchdog = setInterval(() => {
      if (!state.running || !state.currentId) {
        stopTurnWatchdog();
        return;
      }
      const now = Date.now();
      const idleSec = Math.floor((now - lastTurnActivityAt) / 1000);
      const totalSec = Math.floor((now - turnStartAt) / 1000);
      if (idleSec > STUCK_IDLE_SEC || totalSec > STUCK_TOTAL_SEC) {
        if (!watchdogRefreshed) {
          // 超时判定前先兜底刷新一次：可能只是事件丢了，回复其实已完成
          watchdogRefreshed = true;
          setStatus('思考时间较长，正在检查回复…', true);
          refreshThreadNow().then(() => {
            if (state.running) {
              doTimeoutStop();
            } else {
              stopTurnWatchdog();
              stopTurnPolling();
              maybeAutoSpeak();
            }
          });
          return;
        }
        doTimeoutStop();
      }
    }, 10000);
  }

  function stopTurnWatchdog() {
    if (turnWatchdog) {
      clearInterval(turnWatchdog);
      turnWatchdog = null;
    }
  }

  function updateThinkingIndicator(show) {
    const all = messagesEl.querySelectorAll('.think-indicator');
    for (const i of all) i.classList.add('hidden');
    if (!show) {
      clearThinkTimer();
      return;
    }
    const els = messagesEl.querySelectorAll('.msg.agent');
    if (!els.length) return;
    const el = els[els.length - 1];
    let ind = el.querySelector('.think-indicator');
    if (!ind) {
      ind = document.createElement('div');
      ind.className = 'think-indicator';
      ind.dataset.started = String(Date.now());
      ind.innerHTML = '<span class="spin"></span><span class="think-text">正在思考…</span>';
      const bubble = el.querySelector('.bubble');
      if (bubble) bubble.appendChild(ind);
    }
    ind.classList.remove('hidden');
    updateThinkTimes();
    if (!thinkTimer) thinkTimer = setInterval(updateThinkTimes, 1000);
  }

  function updateThinkTimes() {
    let any = false;
    const all = messagesEl.querySelectorAll('.think-indicator:not(.hidden)');
    for (const ind of all) {
      any = true;
      const sec = Math.floor((Date.now() - Number(ind.dataset.started || Date.now())) / 1000);
      const t = ind.querySelector('.think-text');
      if (t) t.textContent = '正在思考… ' + sec + '秒' + (sec >= STUCK_IDLE_SEC ? '（较久，可点右上角停止）' : '');
    }
    if (!any) clearThinkTimer();
  }

  function clearThinkTimer() {
    if (thinkTimer) {
      clearInterval(thinkTimer);
      thinkTimer = null;
    }
  }

  function itemToBlockData(item) {
    if (item.type === 'userMessage') return null;
    if (item.type === 'agentMessage') return { kind: 'text', id: item.id, text: item.text || '' };
    if (item.type === 'commandExecution') return {
      kind: 'cmd', id: item.id, label: '正在执行电脑命令…',
      status: item.status || '', output: item.output || '', command: ''
    };
    if (item.type === 'fileChange') return {
      kind: 'file', id: item.id,
      files: (item.files || []).map(f => f.path || '').join(', '), status: item.status || ''
    };
    if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall' || item.type === 'webSearch') {
      return { kind: 'tool', id: item.id, label: friendlyToolLabel(item), status: item.status || '' };
    }
    return null;
  }

  // ---------- approvals ----------
  function handleApprovalRequest(msg) {
    const p = msg.params || {};
    if (!state.currentId) return;
    if (p.threadId && p.threadId !== state.currentId) return;
    const cmd = Array.isArray(p.command) ? p.command.join(' ') : (p.command || '');
    const card = document.createElement('div');
    card.className = 'approval-card';
    card.innerHTML =
      '<div class="a-title">需要批准</div>' +
      (cmd ? '<div class="a-cmd">' + escapeHtml(cmd) + '</div>' : '') +
      (p.cwd ? '<div class="a-cmd" style="margin-bottom:8px">目录: ' + escapeHtml(p.cwd) + '</div>' : '') +
      (p.reason ? '<div style="font-size:12px;color:#c9a86a;margin-bottom:8px">原因: ' + escapeHtml(p.reason) + '</div>' : '') +
      '<div class="a-btns">' +
      '<button data-d="accept" class="btn primary">允许一次</button>' +
      '<button data-d="acceptForSession" class="btn">本次会话允许</button>' +
      '<button data-d="decline" class="btn warn">拒绝</button>' +
      '<button data-d="cancel" class="btn ghost">停止</button>' +
      '</div>';
    card.querySelectorAll('button').forEach(b => {
      b.addEventListener('click', () => approve(msg.requestId, b.dataset.d, card));
    });
    approvalArea.appendChild(card);
    state.approvals.set(msg.requestId, card);
    setStatus('等待你批准…');
  }

  async function approve(requestId, decision, card) {
    try {
      await apiCall('approve', { requestId, decision });
      if (card && card.parentNode) card.parentNode.removeChild(card);
      state.approvals.delete(requestId);
    } catch (e) {
      showToast('提交失败: ' + e.message, true);
    }
  }

  // ---------- send ----------
  async function send() {
    stopSpeaking(); // 发送即停旧语音播放并取消旧合成
    ttsGenEpoch++; // 使在途分段请求失效，避免旧任务污染新会话
    ttsGenerating.clear();
    const text = inputBox.value.trim();
    const images = state.pendingImages.slice();
    if (!text && !images.length) return;
    let sendText = text;
    if (quotedMsg) {
      sendText = '【引用 ' + quotedMsg.author + '】' + quotedMsg.text + '\n' + text;
      clearQuote();
    }
    inputBox.value = '';
    state.pendingImages = [];
    renderImagePreviews();

    if (relayCfg && (!relayChannel || !relayChannel.ready)) {
      showToast('中继未连接：请点右上角「重连」按钮', true);
      return;
    }
    if (!state.currentId) {
      showToast('正在创建对话…');
      await newThread();
      if (!state.currentId) {
        showToast('创建对话失败，请重试', true);
        return;
      }
    }
    addUserMessage(sendText, images.map(i => i.dataUrl));

    try {
      const data = await apiCall('turnStart', {
        threadId: state.currentId,
        text: sendText,
        images: images.map(i => ({ name: i.name, data: i.dataUrl })),
        effort: currentEffort,
        autoSpeak: autoSpeak
      });
      const turn = data.turn || data;
      if (turn && turn.id) {
        state.turnId = turn.id;
        state.running = true;
        setStatus('正在运行…');
        $('interruptBtn').classList.remove('hidden');
        turnStartAt = Date.now();
        lastTurnActivityAt = Date.now();
        liveReplyId = null;
        updateThinkingIndicator(true);
        deleteTempsForConv(state.currentId);
        startTurnPolling();
        startTurnWatchdog();
      }
      loadThreads();
    } catch (e) {
      setStatus('发送失败: ' + e.message, true);
      showToast('发送失败: ' + e.message, true);
    }
  }

  async function interrupt() {
    if (!state.currentId || !state.turnId) return;
    try {
      await apiCall('interrupt', { threadId: state.currentId, turnId: state.turnId });
      setStatus('已请求停止');
    } catch (e) {
      const emsg = (e && e.message) || '';
      if (/no active turn/i.test(emsg)) {
        stopTurnPolling();
        stopTurnWatchdog();
        state.running = false;
        state.turnId = null;
        updateThinkingIndicator(false);
        $('interruptBtn').classList.add('hidden');
        setStatus('已停止（当前没有正在运行的任务）');
        refreshThreadNow();
        return;
      }
      setStatus('停止失败: ' + e.message, true);
      showToast('停止失败: ' + e.message, true);
    }
  }

  // ---------- image attach ----------
  $('imageInput').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    for (const f of files) {
      try {
        const dataUrl = await compressImage(f);
        state.pendingImages.push({ name: f.name, dataUrl });
      } catch (_) {}
    }
    renderImagePreviews();
  });

  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = () => {
        const img = new Image();
        img.onerror = reject;
        img.onload = () => {
          const max = 1280;
          let w = img.width, h = img.height;
          if (w > max || h > max) {
            const scale = max / Math.max(w, h);
            w = Math.round(w * scale); h = Math.round(h * scale);
          }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function renderImagePreviews() {
    const box = $('imagePreviews');
    box.innerHTML = '';
    state.pendingImages.forEach((img, i) => {
      const d = document.createElement('div');
      d.className = 'thumb';
      d.innerHTML = '<img src="' + img.dataUrl + '"><span class="x">×</span>';
      d.querySelector('.x').addEventListener('click', () => {
        state.pendingImages.splice(i, 1);
        renderImagePreviews();
      });
      box.appendChild(d);
    });
  }

  // ---------- misc ----------
  function setStatus(text, err) {
    statusLine.textContent = text;
    statusLine.className = 'status-line ' + (err ? 'err' : 'ok');
    updateBadge(err ? 'err' : 'ok');
  }

  function updateBadge(state) {
    const b = $('connBadge');
    if (!b) return;
    b.className = 'conn-badge ' + state;
    const l = $('connLabel');
    if (l) {
      l.textContent = state === 'ok' ? '已连接' : (state === 'err' ? '出错' : '连接中');
    }
  }

  function showToast(text, isError) {
    const t = document.createElement('div');
    t.className = 'toast-overlay' + (isError ? ' err' : '');
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => {
      if (t.parentNode) t.parentNode.removeChild(t);
    }, 4000);
  }

  function addSystemLine(text) {
    const el = document.createElement('div');
    el.className = 'system-line';
    el.textContent = text;
    messagesEl.appendChild(el);
    scrollBottom();
  }

  function copyText(text) {
    const done = () => showToast('已复制');
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(() => legacyCopy(text, done));
      } else {
        legacyCopy(text, done);
      }
    } catch (_) {
      legacyCopy(text, done);
    }
  }

  function legacyCopy(text, done) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    } catch (_) {}
  }

  function setQuote(author, text) {
    quotedMsg = { author, text };
    const a = $('quoteAuthor');
    const t = $('quoteText');
    if (a) a.textContent = '引用 ' + author;
    if (t) t.textContent = String(text || '').replace(/\s+/g, ' ').slice(0, 80);
    $('quoteBar').classList.remove('hidden');
    inputBox.focus();
  }

  function clearQuote() {
    quotedMsg = null;
    $('quoteBar').classList.add('hidden');
  }

  // ---------- AI 消息朗读 ----------
  function readAutoSpeakPref() {
    try {
      if (relayCfg && typeof relayCfg.autoSpeak !== 'undefined') return !!relayCfg.autoSpeak;
    } catch (_) {}
    try {
      if (window.AndroidBridge && window.AndroidBridge.getAutoSpeak) {
        return String(window.AndroidBridge.getAutoSpeak()) !== '0';
      }
    } catch (_) {}
    return true;
  }

  function ttsKey(convId, msgId) { return String(convId) + '_' + String(msgId); }
  function sanitizeTtsId(s) { return String(s || '').replace(/[^A-Za-z0-9_-]/g, '_'); }

  function b64ToBlob(b64, mime) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime || 'audio/wav' });
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(new Error('读取音频失败'));
      r.readAsDataURL(blob);
    });
  }

  function getTtsMeta() {
    try { return JSON.parse(localStorage.getItem('ttsMeta') || '{}'); } catch (_) { return {}; }
  }

  function setTtsMeta(m) {
    try { localStorage.setItem('ttsMeta', JSON.stringify(m)); } catch (_) {}
  }

  async function ttsSaveBlob(id, blob) {
    if (window.AndroidBridge && window.AndroidBridge.saveTtsAudio) {
      const b64 = await blobToBase64(blob);
      const r = window.AndroidBridge.saveTtsAudio(sanitizeTtsId(id), b64);
      if (r && r !== 'ok') throw new Error(r);
      return;
    }
    ttsMem.set(id, blob);
  }

  async function ttsLoadBlob(id) {
    if (ttsMem.has(id)) return ttsMem.get(id);
    if (window.AndroidBridge && window.AndroidBridge.loadTtsAudio) {
      const b64 = window.AndroidBridge.loadTtsAudio(sanitizeTtsId(id));
      if (b64) {
        const blob = b64ToBlob(b64, 'audio/wav');
        ttsMem.set(id, blob);
        return blob;
      }
    }
    return null;
  }

  async function ttsDelete(id) {
    ttsMem.delete(id);
    if (window.AndroidBridge && window.AndroidBridge.deleteTtsAudio) {
      try { window.AndroidBridge.deleteTtsAudio(sanitizeTtsId(id)); } catch (_) {}
    }
  }

  async function ttsDeleteByConv(convId) {
    const prefix = sanitizeTtsId(convId) + '_';
    for (const k of [...ttsMem.keys()]) if (k.startsWith(prefix)) ttsMem.delete(k);
    if (window.AndroidBridge && window.AndroidBridge.deleteTtsByPrefix) {
      try { window.AndroidBridge.deleteTtsByPrefix(sanitizeTtsId(convId)); } catch (_) {}
    }
  }

  function deleteTempsForConv(convId) {
    const meta = getTtsMeta();
    const remove = [];
    for (const id of Object.keys(meta)) {
      if (meta[id].temp && String(meta[id].convId) === String(convId)) remove.push(id);
    }
    for (const id of remove) {
      const r = meta[id];
      delete meta[id];
      ttsDeleteMessage(id, r && r.segs);
    }
    setTtsMeta(meta);
  }

  function deleteAllTemps() {
    const meta = getTtsMeta();
    const remove = [];
    for (const id of Object.keys(meta)) if (meta[id].temp) remove.push(id);
    for (const id of remove) {
      const r = meta[id];
      delete meta[id];
      ttsDeleteMessage(id, r && r.segs);
    }
    setTtsMeta(meta);
  }

  async function pruneConvAudio(convId, validMsgIds) {
    if (!convId) return;
    const set = new Set(validMsgIds.map(m => String(m)));
    const meta = getTtsMeta();
    const remove = [];
    for (const id of Object.keys(meta)) {
      const r = meta[id];
      if (!r.temp && String(r.convId) === String(convId) && !set.has(String(r.msgId))) remove.push(id);
    }
    for (const id of remove) {
      const r = meta[id];
      delete meta[id];
      await ttsDeleteMessage(id, r && r.segs);
    }
    setTtsMeta(meta);
  }

  async function cleanupTts() {
    const meta = getTtsMeta();
    const byConv = {};
    for (const id of Object.keys(meta)) {
      const r = meta[id];
      (byConv[r.convId] = byConv[r.convId] || []).push({ id: id, rec: r });
    }
    const convs = Object.keys(byConv).map(c => ({
      convId: c,
      recs: byConv[c],
      lastTs: Math.max.apply(null, byConv[c].map(x => x.rec.ts))
    })).sort((a, b) => b.lastTs - a.lastTs);
    const remove = [];
    convs.forEach((g, ci) => {
      if (ci >= 5) {
        for (const x of g.recs) remove.push(x.id);
        return;
      }
      const keep = g.recs.filter(x => !x.rec.temp).sort((a, b) => b.rec.ts - a.rec.ts).slice(0, 10);
      const keepIds = new Set(keep.map(x => x.id));
      for (const x of g.recs) if (!x.rec.temp && !keepIds.has(x.id)) remove.push(x.id);
    });
    for (const id of remove) {
      const r = meta[id];
      delete meta[id];
      await ttsDeleteMessage(id, r && r.segs);
    }
    setTtsMeta(meta);
  }

  async function ttsDeleteMessage(msgKey, segs) {
    await ttsDelete(msgKey);
    const n = Number(segs) || 0;
    for (let i = 0; i <= n; i++) await ttsDelete(ttsSegKey(msgKey, i));
  }

  function ttsSegKey(msgKey, i) { return String(msgKey) + '__s' + i; }

  // 朗读文本清洗：去掉 Markdown、代码块、网址、emoji 等不适合朗读的内容
  function cleanTtsText(text) {
    let s = String(text || '');
    s = s.replace(/```[\s\S]*?```/g, ' ').replace(/~~~[\s\S]*?~~~/g, ' ');
    s = s.replace(/`([^`]*)`/g, '$1');
    s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    s = s.replace(/https?:\/\/[^\s，。！？；、\)\],!?;:<>'"\u4e00-\u9fff]+/g, ' ');
    s = s.replace(/^\s{0,3}(#{1,6}\s+|>\s*|\*\s+|-{1,2}\s+|\d+[.、]\s+)/gm, ' ');
    s = s.replace(/(\*\*|__|\*|_|~~)/g, '');
    s = s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, ' ');
    s = s.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n');
    return s.trim();
  }

  // 按句切段：第一段尽量短（50~80 字），其余每段不超过 150 字
  function splitTtsSegments(text) {
    const clean = cleanTtsText(text);
    if (!clean) return [];
    const MAX = 150;
    const FIRST_MAX = 80;
    const units = clean.split(/(?<=[。！？…!?；;])|\n/).map(x => x.trim()).filter(Boolean);
    const segs = [];
    let cur = '';
    const flush = () => { if (cur) { segs.push(cur); cur = ''; } };
    for (const u of units) {
      if (u.length > MAX) {
        const pieces = u.split(/(?<=[，,、])/);
        for (let p of pieces) {
          p = (p || '').trim();
          if (!p) continue;
          while (p.length > MAX) {
            cur += p.slice(0, MAX);
            flush();
            p = p.slice(MAX);
          }
          if (cur && cur.length + p.length > MAX) flush();
          cur += p;
        }
      } else {
        if (cur && cur.length + u.length > MAX) flush();
        cur += u;
      }
    }
    flush();
    if (segs.length > 1 && segs[0].length > FIRST_MAX) {
      const first = segs[0];
      let cut = -1;
      for (let i = Math.min(FIRST_MAX, first.length) - 1; i >= 0; i--) {
        if (/[。！？；!?;]/.test(first[i])) { cut = i + 1; break; }
      }
      if (cut < 0) {
        for (let i = Math.min(FIRST_MAX, first.length) - 1; i >= 0; i--) {
          if (/[，、,]/.test(first[i])) { cut = i + 1; break; }
        }
      }
      if (cut < 0) cut = FIRST_MAX;
      segs.splice(0, 1, first.slice(0, cut), first.slice(cut));
    }
    return segs.filter(s => s.trim());
  }

  async function ensureTtsSegment(convId, msgId, idx, segText, temp) {
    const msgKey = ttsKey(convId, msgId);
    const key = ttsSegKey(msgKey, idx);
    const cached = await ttsLoadBlob(key);
    if (cached) return cached;
    if (ttsGenerating.has(key)) return ttsGenerating.get(key);
    const epoch = ttsGenEpoch;
    const p = (async () => {
      // 中继分片可能丢块：缩短超时并自动重试一次（服务端有缓存，重试通常秒回）
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await apiCall('ttsGenerate', { text: segText || '' }, 120000);
          if (!res || !res.audioB64) throw new Error('语音生成失败');
          const blob = b64ToBlob(res.audioB64, res.mime || 'audio/wav');
          await ttsSaveBlob(key, blob);
          const meta = getTtsMeta();
          const prev = meta[msgKey] || {};
          meta[msgKey] = {
            convId: String(convId),
            msgId: String(msgId),
            ts: Date.now(),
            temp: true, // 生成但未完整播放前标记为临时，播放完成后转永久
            segs: Math.max(idx + 1, prev.segs || 0)
          };
          setTtsMeta(meta);
          cleanupTts();
          return blob;
        } catch (e) {
          lastErr = e;
          if (epoch !== ttsGenEpoch) break; // 已发送新消息，放弃重试
          if (attempt === 0) await sleep(1500);
        }
      }
      throw lastErr;
    })();
    ttsGenerating.set(key, p);
    p.catch(() => {}).then(() => {
      if (epoch === ttsGenEpoch) ttsGenerating.delete(key);
    });
    return p;
  }

  // 播放当前段的同时，提前请求下一段合成（预取失败不影响主流程，服务端串行排队）
  function prefetchTtsSegment(convId, msgId, segs, i, temp) {
    const j = i + 1;
    if (j >= segs.length) return;
    ensureTtsSegment(convId, msgId, j, segs[j], temp).catch(() => {});
  }

  function setSpeakBtn(key, state) {
    if (key === ttsActiveKey) ttsActiveState = state;
    let btn = speakButtons.get(key);
    if (!btn && key) {
      // 按钮注册表可能被刷新清掉但 DOM 还在：从 DOM 找回并重新注册
      const all = document.querySelectorAll('.speak-btn');
      for (const b of all) {
        if (b._speakKey === key) {
          btn = b;
          speakButtons.set(key, btn);
          break;
        }
      }
    }
    if (!btn) return;
    btn.classList.remove('speaking', 'disabled');
    btn.disabled = false;
    if (state === 'playing') {
      btn.textContent = '⏹ 停止';
      btn.classList.add('speaking');
    } else if (state === 'loading') {
      btn.textContent = '⏳ 生成中…';
    } else {
      btn.textContent = '🔊 朗读';
    }
  }

  // 后台刷新重建界面后，恢复当前朗读按钮的状态（防止“声音在播但按钮显示未朗读”）
  function restoreSpeakBtnState() {
    if (ttsActiveKey) {
      setSpeakBtn(ttsActiveKey, ttsActiveState);
    }
  }

  function updateSpeakBtnKey(agentEl, msgId) {
    const btn = agentEl.querySelector('.speak-btn');
    if (!btn) return;
    const oldKey = btn._speakKey;
    if (oldKey && speakButtons.get(oldKey) === btn) speakButtons.delete(oldKey);
    const key = ttsKey(state.currentId || '', msgId || '');
    btn._speakKey = key;
    speakButtons.set(key, btn);
  }

  function collectAgentText(agentEl) {
    const parts = [];
    const blocks = agentEl.querySelectorAll('.block.agent-text');
    for (const b of blocks) {
      const t = (b.textContent || '').trim();
      if (t) parts.push(t);
    }
    return parts.join('\n');
  }

  function stopSpeaking() {
    ttsSession++;
    const k = ttsActiveKey;
    ttsActiveKey = null;
    ttsActiveState = 'idle';
    if (ttsLanReader) {
      try { ttsLanReader.cancel(); } catch (_) {}
      ttsLanReader = null;
    }
    if (relayCfg && ttsStreamState && ttsStreamState.sid) {
      const sid = ttsStreamState.sid;
      ttsStreamState = null;
      apiCall('ttsStreamStop', { id: sid }, 10000).catch(() => {});
    } else {
      ttsStreamState = null;
    }
    if (ttsAudioEl) {
      try { ttsAudioEl.pause(); ttsAudioEl.onended = null; ttsAudioEl.onerror = null; } catch (_) {}
    }
    if (ttsBlobUrl) {
      try { URL.revokeObjectURL(ttsBlobUrl); } catch (_) {}
      ttsBlobUrl = null;
    }
    for (const r of ttsWaitResolvers) {
      try { r(false); } catch (_) {}
    }
    ttsWaitResolvers.clear();
    if (k) setSpeakBtn(k, 'idle');
  }

  // ---------- 流式朗读（服务端 /tts/stream -> 手机边收边播） ----------
  function bytesToBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  function ttsStreamPush(frame) {
    const s = ttsStreamState;
    if (!s || frame.id !== s.sid) return;
    if (frame.end) {
      s.ended = true;
      s.ok = !!frame.ok;
      s.error = frame.error || '';
    } else {
      s.chunks.push(frame.b64);
    }
    while (s.resolvers.length && (s.chunks.length || s.ended)) {
      const r = s.resolvers.shift();
      if (s.chunks.length) r({ b64: s.chunks.shift() });
      else r({ end: true, ok: s.ok, error: s.error });
    }
  }

  function nextTtsFrame(sid, session) {
    return new Promise((resolve) => {
      const s = ttsStreamState;
      if (!s || s.sid !== sid || session !== ttsSession) { resolve(null); return; }
      if (s.chunks.length) { resolve({ b64: s.chunks.shift() }); return; }
      if (s.ended) { resolve({ end: true, ok: s.ok, error: s.error }); return; }
      const timer = setTimeout(() => {
        const i = s.resolvers.indexOf(wrapped);
        if (i >= 0) s.resolvers.splice(i, 1);
        resolve({ end: true, ok: false, error: '等待音频超时' });
      }, 60000);
      const wrapped = (frame) => {
        clearTimeout(timer);
        resolve(frame);
      };
      s.resolvers.push(wrapped);
    });
  }

  async function consumeLanTtsStream(res, sid, session) {
    try {
      const reader = res.body.getReader();
      ttsLanReader = reader;
      let buf = new Uint8Array(0);
      while (true) {
        const r = await reader.read();
        if (r.done) break;
        const value = new Uint8Array(r.value);
        const merged = new Uint8Array(buf.length + value.length);
        merged.set(buf, 0);
        merged.set(value, buf.length);
        buf = merged;
        while (buf.length >= 4) {
          const len = (buf[0] | (buf[1] << 8) | (buf[2] << 16) | (buf[3] << 24)) >>> 0;
          if (buf.length < 4 + len) break;
          const frame = buf.slice(4, 4 + len);
          buf = buf.slice(4 + len);
          if (len > 0) ttsStreamPush({ id: sid, b64: bytesToBase64(frame) });
        }
      }
      ttsStreamPush({ id: sid, end: true, ok: true });
    } catch (e) {
      ttsStreamPush({ id: sid, end: true, ok: false, error: (e && e.message) || '连接中断' });
    }
  }

  function playTtsSegment(key, blob, session) {
    return new Promise((resolve) => {
      if (session !== ttsSession) { resolve(false); return; }
      // 播放前重新认领按钮归属：即使之前被误清，也能恢复“播放中”状态
      ttsActiveKey = key;
      ttsActiveState = 'playing';
      setSpeakBtn(key, 'playing');
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        ttsWaitResolvers.delete(done);
        if (ttsAudioEl) {
          ttsAudioEl.onended = null;
          ttsAudioEl.onerror = null;
        }
        resolve(ok);
      };
      ttsWaitResolvers.add(done);
      try {
        const url = URL.createObjectURL(blob);
        if (!ttsAudioEl) ttsAudioEl = new Audio();
        if (ttsBlobUrl) {
          try { URL.revokeObjectURL(ttsBlobUrl); } catch (_) {}
        }
        ttsAudioEl.src = url;
        ttsBlobUrl = url;
        ttsAudioEl.onended = () => done(true);
        ttsAudioEl.onerror = () => done(false);
        const pr = ttsAudioEl.play();
        if (pr && pr.catch) pr.catch(() => done(false));
      } catch (_) {
        done(false);
      }
    });
  }

  function finishTts(key) {
    if (ttsActiveKey === key) ttsActiveKey = null;
    ttsActiveState = 'idle';
    setSpeakBtn(key, 'idle');
  }

  // 整条消息完整播放完成后，把缓存标记从“临时”转为“已播放”（避免未播完被误跳）
  function markTtsPlayed(msgKey) {
    const meta = getTtsMeta();
    if (meta[msgKey]) {
      meta[msgKey].temp = false;
      setTtsMeta(meta);
    }
  }

  async function tryTtsStatus(text) {
    try {
      const st = await apiCall('ttsStatus', { text: text || '' }, 15000);
      if (st && st.ready && st.audioB64) return st;
    } catch (_) {}
    return null;
  }

  async function runTtsStream(convId, msgId, streamText, startIdx, auto, temp, session) {
    const msgKey = ttsKey(convId, msgId);
    const sid = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    ttsStreamState = { sid, session, chunks: [], ended: false, ok: false, error: '', resolvers: [] };
    ttsLanReader = null;
    try {
      if (relayCfg) {
        await apiCall('ttsStreamStart', { text: streamText }, 20000);
      } else {
        const res = await fetch('/api/tts/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: streamText })
        });
        if (!res.ok || !res.body) throw new Error('语音流服务返回 ' + res.status);
        consumeLanTtsStream(res, sid, session);
      }
    } catch (e) {
      // 流式不可用，退回分段合成
      ttsStreamState = null;
      if (session !== ttsSession) return;
      playMessageSegments(convId, msgId, streamText, auto, temp);
      return;
    }
    let idx = startIdx;
    let playedAny = false;
    while (true) {
      if (session !== ttsSession) break;
      const frame = await nextTtsFrame(sid, session);
      if (!frame) break;
      if (frame.end) {
        if (!frame.ok && idx === startIdx) {
          // 一段都没生成出来，退回分段合成
          if (session === ttsSession) {
            ttsStreamState = null;
            playMessageSegments(convId, msgId, streamText, auto, temp);
          }
          return;
        }
        if (!frame.ok) {
          if (session === ttsSession) {
            finishTts(msgKey);
            showToast('朗读中断: ' + (frame.error || '语音流错误'), true);
          }
          return;
        }
        break;
      }
      const blob = b64ToBlob(frame.b64, 'audio/wav');
      try {
        await ttsSaveBlob(ttsSegKey(msgKey, idx), blob);
        const meta = getTtsMeta();
        const prev = meta[msgKey] || {};
        meta[msgKey] = {
          convId: String(convId),
          msgId: String(msgId),
          ts: Date.now(),
          temp: true,
          segs: idx + 1
        };
        setTtsMeta(meta);
        cleanupTts();
      } catch (_) {}
      if (state.currentId !== convId) break;
      if (auto && !autoSpeak) { idx++; continue; }
      const played = await playTtsSegment(msgKey, blob, session);
      if (!played) {
        if (session === ttsSession) finishTts(msgKey);
        break;
      }
      playedAny = true;
      idx++;
    }
    if (session === ttsSession) {
      if (playedAny) markTtsPlayed(msgKey);
      finishTts(msgKey);
    }
  }

  async function playStreamMessage(convId, msgId, text, auto, temp) {
    if (!convId || !msgId || !text || !text.trim()) return;
    const msgKey = ttsKey(convId, msgId);
    // 幂等：同一条消息已在朗读/生成中时不重复启动（防止回合数据触发与 DOM 触发双启动）
    if (ttsActiveKey === msgKey && ttsActiveState !== 'idle') return;
    const meta0 = getTtsMeta();
    if (meta0[msgKey] && (meta0[msgKey].segs || 0) > 0) {
      // 已有缓存的音频，直接播放缓存，不再重新合成
      playMessageSegments(convId, msgId, text, auto, !!meta0[msgKey].temp);
      return;
    }
    stopSpeaking();
    const session = ++ttsSession;
    ttsActiveKey = msgKey;
    const clean = cleanTtsText(text);
    if (!clean) {
      finishTts(msgKey);
      showToast('这条消息没有可朗读的文字', true);
      return;
    }
    setSpeakBtn(msgKey, 'loading');
    showToast('正在生成语音…');

    // 1) 电脑端整段缓存（回复完成后已自动预生成 → 秒播）
    const st = await tryTtsStatus(clean);
    if (st && !st.partial) {
      const blob = b64ToBlob(st.audioB64, st.mime || 'audio/wav');
      if (session !== ttsSession || state.currentId !== convId) return;
      await playTtsSegment(msgKey, blob, session);
      if (session === ttsSession) {
        markTtsPlayed(msgKey);
        finishTts(msgKey);
      }
      return;
    }

    // 2) 手动点播：自动朗读关闭时只预生成首段，先播首段再把剩余部分生成/流式接上
    if (!auto && st && st.partial && st.restText) {
      const firstBlob = b64ToBlob(st.audioB64, st.mime || 'audio/wav');
      try {
        await ttsSaveBlob(ttsSegKey(msgKey, 0), firstBlob);
        const meta = getTtsMeta();
        meta[msgKey] = {
          convId: String(convId),
          msgId: String(msgId),
          ts: Date.now(),
          temp: true,
          segs: 1
        };
        setTtsMeta(meta);
      } catch (_) {}
      if (session !== ttsSession || state.currentId !== convId) return;
      const played = await playTtsSegment(msgKey, firstBlob, session);
      if (!played || session !== ttsSession) {
        if (session === ttsSession) finishTts(msgKey);
        return;
      }
      if (relayCfg) {
        // 中继模式：剩余部分走整段合成（可靠，不依赖音频流分片）
        const segs = splitTtsSegments(text);
        if (segs.length > 1) {
          await playSegmentsLoop(convId, msgId, segs, 1, auto, temp, session);
          return;
        }
        if (session === ttsSession) finishTts(msgKey);
        return;
      }
      await runTtsStream(convId, msgId, st.restText, 1, auto, temp, session);
      return;
    }

    // 3) 未命中缓存
    if (relayCfg) {
      // 中继模式：逐段整段合成（每条 RPC 独立、有超时和重试，不会再永久卡住）
      const segs = splitTtsSegments(text);
      await playSegmentsLoop(convId, msgId, segs, 0, auto, temp, session);
      return;
    }
    // 局域网模式：走流式（边生成边播）
    await runTtsStream(convId, msgId, clean, 0, auto, temp, session);
  }

  async function playSegmentsLoop(convId, msgId, segs, startIdx, auto, temp, session) {
    const msgKey = ttsKey(convId, msgId);
    let playedAny = false;
    for (let i = startIdx; i < segs.length; i++) {
      if (session !== ttsSession) return;
      setSpeakBtn(msgKey, 'loading');
      let blob;
      try {
        if (i === startIdx) showToast('正在生成语音…');
        blob = await ensureTtsSegment(convId, msgId, i, segs[i], temp);
      } catch (e) {
        if (session === ttsSession) {
          finishTts(msgKey);
          showToast('朗读失败: ' + ((e && e.message) || e), true);
        }
        return;
      }
      if (session !== ttsSession) return;
      if (state.currentId !== convId) {
        finishTts(msgKey);
        return;
      }
      if (auto && !autoSpeak) continue;
      prefetchTtsSegment(convId, msgId, segs, i, temp);
      const played = await playTtsSegment(msgKey, blob, session);
      if (!played) {
        if (session === ttsSession) finishTts(msgKey);
        return;
      }
      playedAny = true;
    }
    if (session === ttsSession) {
      if (playedAny) markTtsPlayed(msgKey);
      finishTts(msgKey);
    }
  }

  async function playMessageSegments(convId, msgId, text, auto, temp) {
    if (!convId || !msgId || !text || !text.trim()) return;
    const msgKey = ttsKey(convId, msgId);
    stopSpeaking();
    const session = ++ttsSession;
    ttsActiveKey = msgKey;
    const segs = splitTtsSegments(text);
    const meta0 = getTtsMeta();
    const rec = meta0[msgKey];
    const cachedN = rec ? (rec.segs || 0) : 0;
    const n = Math.max(segs.length, cachedN);
    if (!n) {
      finishTts(msgKey);
      showToast('这条消息没有可朗读的文字', true);
      return;
    }
    let playedAny = false;
    for (let i = 0; i < n; i++) {
      if (session !== ttsSession) return;
      setSpeakBtn(msgKey, 'loading');
      let blob;
      try {
        if (i === 0) showToast('正在生成语音…');
        if (i < segs.length) {
          blob = await ensureTtsSegment(convId, msgId, i, segs[i], temp);
        } else {
          blob = await ttsLoadBlob(ttsSegKey(msgKey, i));
        }
        if (!blob) continue;
      } catch (e) {
        if (session === ttsSession) {
          finishTts(msgKey);
          showToast('朗读失败: ' + ((e && e.message) || e), true);
        }
        return;
      }
      if (session !== ttsSession) return;
      if (state.currentId !== convId) {
        finishTts(msgKey);
        return;
      }
      if (auto && !autoSpeak) continue;
      prefetchTtsSegment(convId, msgId, segs, i, temp);
      const played = await playTtsSegment(msgKey, blob, session);
      if (!played) {
        if (session === ttsSession) finishTts(msgKey);
        return;
      }
      playedAny = true;
    }
    if (session === ttsSession) {
      if (playedAny) markTtsPlayed(msgKey);
      finishTts(msgKey);
    }
  }

  function onSpeakClick(agentEl) {
    const convId = state.currentId;
    if (!convId) { showToast('请先打开一个对话', true); return; }
    const msgId = agentEl.dataset.msgId || ('msg' + Date.now());
    const text = collectAgentText(agentEl);
    if (!text.trim()) { showToast('这条消息没有可朗读的文字', true); return; }
    const msgKey = ttsKey(convId, msgId);
    if (ttsActiveKey === msgKey) { stopSpeaking(); return; }
    const meta = getTtsMeta();
    const rec = meta[msgKey];
    const temp = !rec || rec.temp;
    playStreamMessage(convId, msgId, text, false, temp);
  }

  function speakMessage(convId, msgId, text, auto) {
    if (!convId || !msgId || !text || !text.trim()) return;
    playStreamMessage(convId, msgId, text, auto, false);
  }

  // 从回合/线程数据里取最后一条 agent 回复（不依赖 DOM 是否已渲染）
  function lastAgentFromTurn(turn) {
    if (!turn || !Array.isArray(turn.items)) return null;
    for (let i = turn.items.length - 1; i >= 0; i--) {
      const it = turn.items[i];
      if (it.type === 'agentMessage' && it.id && it.text && it.text.trim()) {
        return { id: it.id, text: it.text };
      }
    }
    return null;
  }

  function lastAgentFromThread(thread) {
    const turns = (thread && (thread.turns || [])) || [];
    for (let i = turns.length - 1; i >= 0; i--) {
      const a = lastAgentFromTurn(turns[i]);
      if (a) return a;
    }
    return null;
  }

  // 带幂等/meta 守卫的自动朗读触发（DOM 与回合数据共用）
  function tryAutoSpeakMessage(convId, msgId, text) {
    if (!convId || !msgId || !text || !text.trim()) return false;
    const id = ttsKey(convId, msgId);
    const meta = getTtsMeta();
    const diag = 'msgId=' + msgId + ' activeKey=' + ttsActiveKey +
      ' state=' + ttsActiveState + ' meta=' + (meta[id] ? (meta[id].temp ? 'temp' : 'perm') : 'none');
    // 自愈：空闲状态下清掉残留的归属键，避免误拦新消息
    if (ttsActiveKey && ttsActiveState === 'idle') ttsActiveKey = null;
    // 只拦“同一消息确实正在生成/播放中”的重复触发
    if (ttsActiveKey === id && ttsActiveState !== 'idle') { console.log('[autoSpeak] 跳过(已在朗读/生成中) ' + diag); return false; }
    if (meta[id] && !meta[id].temp) return false; // 已完整播放过，跳过
    console.log('[autoSpeak] 触发 ' + diag);
    speakMessage(convId, msgId, text, true);
    return true;
  }

  function maybeAutoSpeak() {
    if (!state.currentId) return false;
    const agents = messagesEl.querySelectorAll('.msg.agent');
    const last = agents[agents.length - 1];
    if (!last) return false;
    const msgId = last.dataset.msgId;
    const text = collectAgentText(last);
    if (!msgId) { console.log('[autoSpeak] 跳过(无msgId)'); return false; }
    if (msgId === turnStartLastMsgId) { console.log('[autoSpeak] 跳过(仍是本轮开始前消息)'); return false; }
    if (!text.trim()) { console.log('[autoSpeak] 跳过(无文本)'); return false; }
    return tryAutoSpeakMessage(state.currentId, msgId, text);
  }

  function currentLastMsgId() {
    const agents = messagesEl.querySelectorAll('.msg.agent');
    const last = agents[agents.length - 1];
    return last ? (last.dataset.msgId || null) : null;
  }

  function traceEvent(name) {
    const el = $('eventTrace');
    if (!el) return;
    el.classList.remove('hidden');
    const arr = (el.dataset.list || '').split(',').filter(Boolean);
    arr.push(name);
    if (arr.length > 6) arr.shift();
    el.dataset.list = arr.join(',');
    el.textContent = '事件: ' + arr.join(' → ');
  }

  function deltaText(params) {
    if (params.delta) return params.delta;
    if (params.deltaBase64) {
      try {
        const bin = atob(params.deltaBase64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder().decode(bytes);
      } catch (_) {}
    }
    return '';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toWebPath(p) {
    if (!p) return null;
    const m = /[\\/]uploads[\\/]([^\\/]+)$/i.exec(p);
    return m ? '/uploads/' + m[1] : null;
  }

  function openSidebar() { $('sidebar').classList.add('open'); }
  function closeSidebar() { $('sidebar').classList.remove('open'); }

  $('menuBtn').addEventListener('click', openSidebar);
  $('closeSidebarBtn').addEventListener('click', closeSidebar);
  $('newChatBtn').addEventListener('click', newThread);
  $('claimBtn').addEventListener('click', async () => {
    try {
      const r = await apiCall('claimLegacyThreads', {});
      showToast('已认领 ' + ((r && r.claimed) || 0) + ' 个旧对话');
      loadThreads();
    } catch (e) {
      showToast('认领失败: ' + e.message, true);
    }
  });
  if (!relayCfg) $('claimBtn').classList.add('hidden');
  $('sendBtn').addEventListener('click', send);
  $('interruptBtn').addEventListener('click', interrupt);
  $('quoteCancel').addEventListener('click', clearQuote);
  $('shareKeyBtn').addEventListener('click', quickConfig);
  $('refreshBtn').addEventListener('click', () => location.reload());
  if (window.AndroidBridge && window.AndroidBridge.openSettings) {
    $('settingsBtn').addEventListener('click', () => window.AndroidBridge.openSettings());
  } else {
    $('settingsBtn').classList.add('hidden');
  }
  $('reconnectBtn').addEventListener('click', async () => {
    stopAllRelayChannels();
    relayChannel = null;
    showToast('正在重新连接…');
    await connectRelay();
  });

  async function quickConfig() {
    const key = $('shareKeyInput').value.trim();
    if (!key) { showToast('请输入一键配置密钥', true); return; }
    if (!window.crypto || !window.crypto.subtle) { showToast('当前环境不支持加密', true); return; }
    showToast('正在向电脑请求配置…');
    const enc = new TextEncoder();
    let ch = null;
    try {
      const keyDigest = await crypto.subtle.digest('SHA-256', enc.encode(key));
      const hashHex = Array.from(new Uint8Array(keyDigest)).map(b => b.toString(16).padStart(2, '0')).join('');
      const aesKeyBuf = await crypto.subtle.digest('SHA-256', enc.encode('codexbridge:' + key));
      const aesKey = await crypto.subtle.importKey('raw', aesKeyBuf, { name: 'AES-GCM' }, false, ['decrypt']);
      const brokers = [];
      if (relayCfg && relayCfg.broker) brokers.push(relayCfg.broker);
      brokers.push('wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081/mqtt');
      const seenBrokers = new Set();
      let cfg = null;
      let lastErr = '电脑端无响应（请确认桥接已启动，且密钥与电脑端显示的一致）';
      for (const broker of brokers) {
        if (seenBrokers.has(broker)) continue;
        seenBrokers.add(broker);
        try {
          cfg = await new Promise((resolve, reject) => {
            let ch = null;
            const timer = setTimeout(() => {
              try { if (ch) ch.stop(); } catch (_) {}
              reject(new Error('timeout'));
            }, 15000);
            ch = new RelayChannel({
              broker,
              roomCode: 'CODEXXBOOT',
              password: 'bootstrap-public',
              clientId: 'cb_' + getPersistentDeviceId(),
              role: 'phone',
              onMessage: async (m) => {
                if (m && m.type === 'bootstrap-ok' && m.data) {
                  try {
                    const raw = atob(m.data);
                    const bytes = new Uint8Array(raw.length);
                    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
                    const iv = bytes.slice(0, 12);
                    const tag = bytes.slice(12, 28);
                    const ct = bytes.slice(28);
                    const combined = new Uint8Array(ct.length + tag.length);
                    combined.set(ct, 0);
                    combined.set(tag, ct.length);
                    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, combined);
                    const parsed = JSON.parse(new TextDecoder().decode(pt));
                    clearTimeout(timer);
                    try { if (ch) ch.stop(); } catch (_) {}
                    resolve(parsed);
                  } catch (e) {
                    clearTimeout(timer);
                    try { if (ch) ch.stop(); } catch (_) {}
                    reject(new Error('配置解析失败'));
                  }
                }
              },
              onStatus: (s) => {
                if (s === 'connected' && ch) {
                  ch.send({ type: 'bootstrap', hash: hashHex }).catch(() => {});
                }
              },
              onError: () => {}
            });
            ch.start().catch(e => {
              clearTimeout(timer);
              reject(new Error((e && e.message) || '连接失败'));
            });
          });
          break;
        } catch (e) {
          if ((e && e.message) !== '配置解析失败') lastErr = (e && e.message) || lastErr;
        }
      }
      if (!cfg) throw new Error(lastErr);
      if (window.AndroidBridge && window.AndroidBridge.saveRelayConfig) {
        window.AndroidBridge.saveRelayConfig(cfg.room, cfg.password, cfg.updateUrl, cfg.broker);
        showToast('配置成功，正在连接…');
      } else {
        showToast('配置成功：配对码=' + cfg.room + ' 密码=' + cfg.password);
      }
    } catch (e) {
      showToast('一键配置失败: ' + e.message, true);
    }
  }
  window.addEventListener('error', (e) => {
    showToast('页面错误: ' + (e.message || '未知错误'), true);
  });
  setInterval(() => {
    if (relayCfg && !relayConnecting && !(relayChannel && relayChannel.ready)) {
      connectRelay();
    }
  }, 3000);
  inputBox.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
    }
  });
  inputBox.addEventListener('input', () => {
    inputBox.style.height = 'auto';
    inputBox.style.height = Math.min(inputBox.scrollHeight, 120) + 'px';
  });

  init();
})();
