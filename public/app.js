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

  const APP_VERSION = '10.44';
  const MAX_FILE_BYTES = 2 * 1024 * 1024;
  const RELAY_MAX_FILE_BYTES = 512 * 1024;
  const TEXT_FILE_EXTS = ['.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.log', '.xml', '.yaml', '.yml', '.ini', '.conf', '.cfg', '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.html', '.htm', '.css', '.scss', '.sql', '.sh', '.bat', '.cmd', '.ps1', '.toml', '.properties'];
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
  let relayFailStreak = 0;

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
    pendingImages: [],
    pendingFiles: [],
    pageTurns: [],       // 当前会话已加载的历史轮次（旧 → 新）
    threadPage: { hasMore: false, nextCursor: 0, loading: false }
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
  let turnGenCount = 0; // 本回合 generate_image 调用计数（防误触堆积卡片）
  let genConfirmApproved = false; // 用户确认过多次生图后本回合不再重复询问
  let turnStartLastMsgId = null;
  let quotedMsg = null;
  let autoSpeak = true;
  autoSpeak = readAutoSpeakPref();
  const speakButtons = new Map();
  const ttsMem = new Map();
  const ttsGenerating = new Map();
  let ttsActiveKey = null;
  let ttsActiveState = 'idle';
  let autoSpokenMsgKey = null;
  let autoSpeakRetryTimer = null;
  let ttsSession = 0;
  const ttsWaitResolvers = new Set();
  let ttsAudioEl = null;
  let ttsBlobUrl = null;
  let ttsStreamState = null;
  let ttsLanReader = null;
  const replySeen = {};

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
      case 'threadReadPage':
        url = '/api/threads/' + encodeURIComponent(params.threadId) + '/page?limit=' + ((params && params.limit) || 10) +
          ((params && params.before !== undefined) ? '&before=' + params.before : '');
        init = { method: 'GET' };
        break;
      case 'threadDelete':
        url = '/api/threads/' + encodeURIComponent(params.threadId); init = { method: 'DELETE' };
        break;
      case 'turnStart':
        url = '/api/threads/' + encodeURIComponent(params.threadId) + '/turns';
        init = { method: 'POST', headers: json(), body: JSON.stringify({ text: params.text, images: params.images || [], files: params.files || [] }) };
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
      case 'reportCapabilities':
        url = '/api/report-capabilities';
        init = { method: 'POST', headers: json(), body: JSON.stringify({ caps: (params && params.caps) || {} }) };
        break;
      case 'comfyImage':
        url = '/api/comfy-image';
        init = { method: 'POST', headers: json(), body: JSON.stringify({ path: (params && params.path) || '' }) };
        break;
      case 'deleteComfyImage':
        url = '/api/images/delete';
        init = { method: 'POST', headers: json(), body: JSON.stringify({ path: (params && params.path) || '' }) };
        break;
      default:
        throw new Error('未知方法: ' + method);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 15000);
    let r;
    try {
      r = await fetch(url, Object.assign({}, init, { signal: controller.signal }));
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') throw new Error('请求超时');
      throw e;
    }
    clearTimeout(timer);
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
      } else if (msg.method === 'getDeviceStatus') {
        if (!window.AndroidBridge || !window.AndroidBridge.getDeviceStatus) throw new Error('当前页面不支持此操作');
        let r = {};
        try { r = JSON.parse(window.AndroidBridge.getDeviceStatus() || '{}') || {}; } catch (_) {}
        if (r.ok === false) {
          const e = new Error(r.error || '设备状态查询未开启');
          e.business = true;
          throw e;
        }
        addSystemLine('📱 电脑正在读取手机设备状态…');
        relayChannel.send({ type: 'phone-rpc-response', id, ok: true, result: r.data || r }).catch(() => {});
      } else if (msg.method === 'getCapabilities') {
        if (!window.AndroidBridge || !window.AndroidBridge.getCapabilities) throw new Error('当前页面不支持此操作');
        let caps = {};
        try { caps = JSON.parse(window.AndroidBridge.getCapabilities() || '{}') || {}; } catch (_) {}
        relayChannel.send({ type: 'phone-rpc-response', id, ok: true, result: caps }).catch(() => {});
      } else {
        throw new Error('未知手机操作: ' + msg.method);
      }
    } catch (e) {
      relayChannel.send({ type: 'phone-rpc-response', id, ok: false, error: (e && e.message) || '操作失败', business: !!(e && e.business) }).catch(() => {});
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
            relayFailStreak = 0;
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
              resumeTurnIfActive();
              reportCapabilities();
            }
          } else {
            relayFailStreak++;
            if (state.running) {
              state.running = false;
              state.turnId = null;
              updateThinkingIndicator(false);
              stopTurnPolling();
              stopTurnWatchdog();
              $('interruptBtn').classList.add('hidden');
            }
            rejectPendingRelay('中继连接断开，正在重连…');
            if (relayFailStreak >= 3) {
              setStatus('电脑端未运行，请检查电脑上的 start.bat 窗口', true);
              addSystemLine('⚠️ 电脑端连接已断开：请确认电脑上的桥接窗口（start.bat）还在运行。');
              showToast('电脑端未运行，请检查 start.bat 窗口', true);
            } else {
              setStatus(s, true);
              if (s.indexOf('失败') >= 0) showToast(s, true);
            }
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
      reportCapabilities();
      return;
    }
    try {
      const r = await fetch('/api/me');
      const data = await r.json();
      if (data.ok) {
        showMain(data);
        reportCapabilities();
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
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const data = await apiCall('threads', {}, 10000);
        state.threads = Array.isArray(data) ? data : (data.threads || data.data || []);
        renderThreads();
        if (!state.running) setStatus('已连接');
        return;
      } catch (e) {
        if (attempt === 0 && /超时|fetch failed|network|ECONN/i.test((e && e.message) || '')) {
          await sleep(500);
          continue;
        }
        setStatus('无法读取会话列表', true);
        showToast('读取会话列表失败: ' + ((e && e.message) || e), true);
        return;
      }
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
        state.pageTurns = [];
        state.threadPage = { hasMore: false, nextCursor: 0, loading: false };
        stopTurnPolling();
        stopTurnWatchdog();
        clearMessagesPreserveComfyStack();
        approvalArea.innerHTML = '';
        state.blocks.clear();
        chatTitle.textContent = '新对话';
        setStatus('已连接');
      }
      renderThreads();
      clearConvLocalData(threadId);
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
    clearMessagesPreserveComfyStack();
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
          data = await apiCall('threadReadPage', { threadId: id, limit: 10 }, 8000);
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
      const thread = data.thread || {};
      state.pageTurns = data.turns || [];
      state.threadPage = { hasMore: !!data.hasMore, nextCursor: data.nextCursor || 0, loading: false };
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
      clearMessagesPreserveComfyStack();
      renderHistory(state.pageTurns);
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
      failEl.innerHTML = '⚠ 读取历史对话失败：' + escapeHtml(msg) + '　<span class="link-btn" id="retryThreadBtn">点此重试</span>　<span class="link-btn" id="reconnectThreadBtn">重连</span>';
      messagesEl.appendChild(failEl);
      const btn = failEl.querySelector('#retryThreadBtn');
      if (btn) btn.addEventListener('click', () => { failEl.remove(); openThread(id); });
      const rcBtn = failEl.querySelector('#reconnectThreadBtn');
      if (rcBtn) rcBtn.addEventListener('click', () => { failEl.remove(); reconnectAll(); });
      showToast('读取对话失败: ' + msg, true);
      handleUnresponsive(e); // 超时/断连时探活，真无响应则提示自动重启
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
    for (const el of messagesEl.querySelectorAll('.msg.agent')) updateSpeakBtnVisibility(el);
    // 分页未加载完整历史时跳过音频清理，避免误删未加载消息的缓存
    if (!state.threadPage.hasMore) pruneConvAudio(state.currentId, aiIds);
    // 历史渲染完成后兜底重挂生成中的进度堆叠（切换对话不清卡）
    restoreComfyStackIfNeeded();
  }

  async function loadMoreThread() {
    if (!state.currentId || !state.threadPage.hasMore || state.threadPage.loading) return;
    state.threadPage.loading = true;
    const prevScrollHeight = messagesEl.scrollHeight;
    const prevScrollTop = messagesEl.scrollTop;
    try {
      const data = await apiCall('threadReadPage', { threadId: state.currentId, limit: 10, before: state.threadPage.nextCursor });
      const older = data.turns || [];
      const known = new Set(state.pageTurns.map(t => t.id || t.turnId));
      const merged = older.filter(t => !known.has(t.id || t.turnId)).concat(state.pageTurns);
      state.pageTurns = merged;
      state.threadPage = { hasMore: !!data.hasMore, nextCursor: data.nextCursor || 0, loading: false };
      state.blocks.clear();
      speakButtons.clear();
      clearMessagesPreserveComfyStack();
      renderHistory(merged);
      // 保持视口位置：新加载的旧消息追加在顶部
      messagesEl.scrollTop = messagesEl.scrollHeight - prevScrollHeight + prevScrollTop;
      restoreSpeakBtnState();
    } catch (e) {
      state.threadPage.loading = false;
      showToast('加载更多历史失败: ' + ((e && e.message) || e), true);
      handleUnresponsive(e);
    }
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
      text = text.replace(/\s*\[系统要求：[\s\S]*\]\s*$/, ''); // 兜底：历史里混入的系统要求不再显示
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

  function addUserMessage(text, images, files) {
    text = String(text || '').replace(/\s*\[系统要求：[\s\S]*\]\s*$/, ''); // 兜底：不把系统要求显示在用户气泡里
    const el = document.createElement('div');
    el.className = 'msg user';
    let imgs = '';
    if (images && images.length) {
      imgs = '<div class="imgs">' + images.map(u => '<span class="agent-img"><img src="' + escapeHtml(u) + '" data-save="' + escapeHtml(u) + '"><button class="img-save-btn">保存到相册</button></span>').join('') + '</div>';
    }
    let atts = '';
    if (files && files.length) {
      atts = '<div class="imgs file-att-list">' + files.map(f => '<span class="file-chip-msg">📄 ' + escapeHtml(f.name) + ' · ' + formatBytes(f.size) + '</span>').join('') + '</div>';
    }
    el.innerHTML = '<div class="wrap">' + imgs + atts + '<div class="bubble">' + escapeHtml(text) + '</div></div>' +
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
      block.innerHTML = renderAgentTextWithImages(d.text || '');
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

  // 把 AI 回复里的 ![说明](图片地址) 渲染成图片 + 保存按钮（其余内容保持转义）
  function renderAgentTextWithImages(text) {
    // 兼容 AI 回复里 [文件名](.../uploads/xxx.png) 形式的本地链接：也当图片渲染
    const normalized = String(text || '').replace(/\[([^\]]*)\]\(([^)]*\/uploads\/[^)]+)\)/g, '![$1]($2)');
    const parts = normalized.split(/!\[([^\]]*)\]\(([^)]+)\)/);
    let html = '';
    for (let i = 0; i < parts.length; i += 3) {
      html += escapeHtml((parts[i] || '').replace(/^!/, '').replace(/📄\s*$/, '')); // 清掉解析残留的孤立感叹号和文件图标
      if (parts[i + 1] !== undefined) {
        const src = parts[i + 2] || '';
        const alt = (parts[i + 1] || '').trim() || '图片';
        if (/\.(png|jpe?g|gif|webp)(\?|#|$)/i.test(src)) {
          const comfy = String(src).indexOf('/uploads/comfy-') === 0 ? ' data-comfy="1"' : '';
          html += '<span class="agent-img"><img src="' + escapeHtml(src) + '" alt="' + escapeHtml(alt) + '" loading="lazy" data-save="' + escapeHtml(src) + '"' + comfy + '>' +
            '<span class="agent-img-tag">' + escapeHtml(alt) + '</span>' +
            '<button class="img-save-btn">保存到相册</button></span>';
        } else {
          const fname = (alt === '图片' ? (src.split('/').pop() || '文件') : alt);
          const opened = isFileDownloaded(src);
          html += '<span class="agent-file"><span class="agent-file-ico">📄</span><span class="agent-file-name">' + escapeHtml(fname) + '</span>' +
            '<button class="agent-file-btn' + (opened ? ' open' : '') + '" data-url="' + escapeHtml(src) + '" data-name="' + escapeHtml(fname) + '">' + (opened ? '打开' : '下载') + '</button></span>';
        }
      }
    }
    return html;
  }

  // 仅用户点击“保存到相册”时写入系统相册（不再自动保存）
  function saveImageToDevice(src) {
    let url = src;
    if (url && url.indexOf('/') === 0 && url.indexOf('//') !== 0 && !/^data:/.test(url)) {
      try { url = location.origin + url; } catch (_) {}
    }
    try {
      if (window.AndroidBridge && window.AndroidBridge.saveImageToGallery) {
        const r = window.AndroidBridge.saveImageToGallery(url);
        if (r === 'ok') {
          showToast('已保存到相册');
          return true;
        }
        const msg = r || '未知错误';
        showToast(String(msg).indexOf('保存失败:') === 0 ? msg : '保存失败: ' + msg, true);
        return false;
      }
      const a = document.createElement('a');
      a.href = url;
      a.download = 'image.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      showToast('已开始下载');
      return true;
    } catch (e) {
      showToast('保存失败: ' + (e && e.message), true);
      return false;
    }
  }

  // 下载 AI 生成/修改的文件：手机走原生保存到 App 下载目录，电脑网页走 <a download>
  function downloadAgentFile(url, name) {
    if (!url) return;
    if (relayCfg) {
      relayDownloadFile(url, name);
      return;
    }
    let abs = url;
    if (abs.indexOf('/') === 0 && abs.indexOf('//') !== 0 && !/^data:/.test(abs)) {
      try { abs = location.origin + abs; } catch (_) {}
    }
    try {
      if (window.AndroidBridge && window.AndroidBridge.saveFileToPhone) {
        const r = window.AndroidBridge.saveFileToPhone(abs, name || 'file');
        if (r === 'ok') {
          markFileDownloaded(url);
          setFileBtnOpen(url);
          return;
        }
        const msg = r || '未知错误';
        showToast(String(msg).indexOf('下载失败:') === 0 ? msg : '下载失败: ' + msg, true);
        return;
      }
      const a = document.createElement('a');
      a.href = abs;
      a.download = name || 'file';
      document.body.appendChild(a);
      a.click();
      a.remove();
      showToast('已开始下载');
    } catch (e) {
      showToast('下载失败: ' + (e && e.message), true);
    }
  }

  // 已下载状态（localStorage 持久化，key = 文件 url），刷新/重进对话后按钮仍显示“打开”
  function getDownloadedFiles() {
    try { return new Set(JSON.parse(localStorage.getItem('downloadedFiles') || '[]')); } catch (_) { return new Set(); }
  }
  function isFileDownloaded(url) {
    return url ? getDownloadedFiles().has(url) : false;
  }
  function markFileDownloaded(url) {
    if (!url) return;
    const s = getDownloadedFiles();
    s.add(url);
    const arr = Array.from(s);
    while (arr.length > 100) arr.shift(); // 已下载标记最多 100 条，防止无限增长
    try { localStorage.setItem('downloadedFiles', JSON.stringify(arr)); } catch (_) {}
  }
  function setFileBtnOpen(url) {
    document.querySelectorAll('.agent-file-btn').forEach(b => {
      if (b.getAttribute('data-url') === url) {
        b.classList.add('open');
        b.textContent = '打开';
      }
    });
  }

  // 打开已下载的 AI 文件：手机走原生 openFile（本地缺失会先下载），电脑网页新标签打开
  function openAgentFile(url, name) {
    if (!url) return;
    let abs = url;
    if (abs.indexOf('/') === 0 && abs.indexOf('//') !== 0 && !/^data:/.test(abs)) {
      try { abs = location.origin + abs; } catch (_) {}
    }
    try {
      if (window.AndroidBridge && window.AndroidBridge.openFile) {
        const r = window.AndroidBridge.openFile(abs, name || 'file');
        if (r !== 'ok') showToast('打开失败: ' + (r || '未知错误'), true);
        return;
      }
      window.open(abs, '_blank');
    } catch (e) {
      showToast('打开失败: ' + (e && e.message), true);
    }
  }

  // 中继模式：文件经中继分片回传 → dataURL → 交原生保存（公共 MQTT 单包约 1MB，必须分片）
  async function relayDownloadFile(url, name) {
    try {
      const meta = await apiCall('fileData', { path: url, meta: true }, 30000);
      if (!meta || !meta.ok || !meta.chunks) throw new Error('无法获取文件信息');
      if (meta.size > 20 * 1024 * 1024) throw new Error('文件过大：中继下载上限 20MB');
      const mime = meta.mime || 'application/octet-stream';
      const fname = name || meta.name || 'file';
      showToast('正在传输文件到手机…');
      const parts = new Array(meta.chunks);
      const queue = [];
      for (let i = 0; i < meta.chunks; i++) queue.push(i);
      const workers = Math.min(4, meta.chunks);
      async function worker() {
        while (queue.length) {
          const idx = queue.shift();
          const r = await apiCall('fileData', { path: url, index: idx }, 60000);
          if (!r || !r.ok || r.data == null) throw new Error('分片 ' + (idx + 1) + ' 获取失败');
          parts[idx] = r.data; // 每片 300KB（3 的倍数），无内部 padding，直接拼接即完整 base64
        }
      }
      await Promise.all(Array.from({ length: workers }, worker));
      const dataUrl = 'data:' + mime + ';base64,' + parts.join('');
      if (window.AndroidBridge && window.AndroidBridge.saveFileToPhone) {
        const r = window.AndroidBridge.saveFileToPhone(dataUrl, fname);
        if (r === 'ok') {
          markFileDownloaded(url);
          setFileBtnOpen(url);
          return;
        }
        throw new Error(r || '保存失败');
      }
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      a.remove();
      showToast('已开始下载');
    } catch (e) {
      const msg = ((e && e.message) || '未知错误');
      showToast(String(msg).indexOf('下载失败:') === 0 ? msg : '下载失败: ' + msg, true);
    }
  }

  // 中继模式取不到 /uploads 图片，走中继通道换 dataURL
  function fetchComfyDataUrl(path) {
    return apiCall('comfyImage', { path }).then(r => (r && r.dataUrl) || null).catch(() => null);
  }

  // App 内缓存映射：uploads/comfy-xxx.png -> 手机私有缓存文件（重载对话时恢复显示）
  function loadComfyImgCache() {
    try { return JSON.parse(localStorage.getItem('comfyImgCache') || '{}') || {}; } catch (_) { return {}; }
  }
  function saveComfyImgCache(map) {
    try {
      const entries = Object.entries(map || {});
      while (entries.length > 100) entries.shift(); // 图片映射最多 100 条，删最旧
      localStorage.setItem('comfyImgCache', JSON.stringify(Object.fromEntries(entries)));
    } catch (_) {}
  }

  // 生成图渲染成功后下载到 App 私有缓存（最多 10 张），并通知电脑删除 uploads 副本
  function cacheGeneratedImage(img) {
    if (!window.AndroidBridge || !window.AndroidBridge.cacheImageToApp) return;
    if (!img || !img.dataset || img.dataset.comfy !== '1' || img.dataset.cached) return;
    img.dataset.cached = '1';
    const orig = img.dataset.save || '';
    const m = /\/uploads\/(comfy-[^/?#]+)$/.exec(orig);
    const src = img.src || orig || '';
    if (String(src).indexOf('file://') === 0) {
      // 已从本地缓存恢复：只删电脑副本
      if (m) apiCall('deleteComfyImage', { path: '/uploads/' + m[1] }).catch(() => {});
      return;
    }
    let url = src;
    if (url.indexOf('/') === 0 && url.indexOf('//') !== 0 && !/^data:/.test(url)) {
      try { url = location.origin + url; } catch (_) {}
    }
    try {
      const p = window.AndroidBridge.cacheImageToApp(url);
      if (p && p.length > 4) {
        if (m) {
          const map = loadComfyImgCache();
          map[m[1]] = p;
          saveComfyImgCache(map);
          apiCall('deleteComfyImage', { path: '/uploads/' + m[1] }).catch(() => {});
        }
      }
    } catch (_) {}
  }

  // 图片渲染失败时恢复：先查 App 缓存（file://），再走中继通道取 dataURL
  function resolveComfyImg(img) {
    const orig = img.dataset && img.dataset.save;
    if (String(orig).indexOf('/uploads/comfy-') !== 0) return;
    const m = /\/uploads\/(comfy-[^/?#]+)$/.exec(orig);
    if (!m) return;
    const map = loadComfyImgCache();
    if (map[m[1]]) {
      img.src = 'file://' + String(map[m[1]]).replace(/\\/g, '/');
      return;
    }
    fetchComfyDataUrl(orig).then((dataUrl) => {
      if (dataUrl && img.src !== dataUrl) img.src = dataUrl;
    });
  }

  // 内置全屏图片查看器：双指缩放、拖动、单击关闭（不跳系统查看器）
  let viewerOverlay = null;
  let viewerScale = 1, viewerTx = 0, viewerTy = 0, viewerMoved = false;
  let viewerTouches = new Map();
  let viewerPrev = new Map();
  let viewerLastPinch = 0;

  function applyViewerTransform() {
    if (!viewerOverlay) return;
    const img = viewerOverlay.querySelector('.viewer-img');
    img.style.transform = 'scale(' + viewerScale + ') translate(' + viewerTx + 'px,' + viewerTy + 'px)';
  }

  function resetViewerTransform() {
    viewerScale = 1; viewerTx = 0; viewerTy = 0;
    applyViewerTransform();
  }

  function openImageViewerOverlay(src) {
    if (!viewerOverlay) {
      viewerOverlay = document.createElement('div');
      viewerOverlay.className = 'viewer-overlay hidden';
      viewerOverlay.innerHTML = '<img class="viewer-img" alt="">';
      document.body.appendChild(viewerOverlay);
      viewerOverlay.addEventListener('touchstart', (e) => {
        e.preventDefault();
        viewerMoved = false;
        viewerTouches = new Map();
        viewerPrev = new Map();
        viewerLastPinch = 0;
        for (const t of e.changedTouches) {
          viewerTouches.set(t.identifier, { x: t.clientX, y: t.clientY });
          viewerPrev.set(t.identifier, { x: t.clientX, y: t.clientY });
        }
        if (viewerTouches.size === 2) {
          const [a, b] = [...viewerTouches.values()];
          viewerLastPinch = Math.hypot(a.x - b.x, a.y - b.y);
        }
      }, { passive: false });
      viewerOverlay.addEventListener('touchmove', (e) => {
        e.preventDefault();
        const cur = new Map();
        for (const t of e.changedTouches) cur.set(t.identifier, { x: t.clientX, y: t.clientY });
        for (const [id, p] of cur) viewerTouches.set(id, p);
        if (viewerTouches.size >= 2) {
          viewerMoved = true;
          const [a, b] = [...viewerTouches.values()];
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          if (viewerLastPinch > 0) {
            viewerScale = Math.max(1, Math.min(6, viewerScale * (dist / viewerLastPinch)));
          }
          viewerLastPinch = dist;
          const ids = [...viewerTouches.keys()];
          const pa = viewerPrev.get(ids[0]);
          const pb = viewerPrev.get(ids[1]);
          if (pa && pb) {
            viewerTx += ((a.x + b.x) - (pa.x + pb.x)) / 2;
            viewerTy += ((a.y + b.y) - (pa.y + pb.y)) / 2;
          }
        } else if (viewerTouches.size === 1) {
          const id = [...viewerTouches.keys()][0];
          const p = viewerTouches.get(id);
          const prev = viewerPrev.get(id);
          if (prev) {
            viewerTx += p.x - prev.x;
            viewerTy += p.y - prev.y;
            if (Math.abs(p.x - prev.x) + Math.abs(p.y - prev.y) > 2) viewerMoved = true;
          }
        }
        viewerPrev = new Map(cur);
        applyViewerTransform();
      }, { passive: false });
      const endViewer = (e) => {
        if (e.touches.length === 0) {
          if (!viewerMoved) closeViewerOverlay();
          viewerTouches = new Map();
          viewerLastPinch = 0;
        } else {
          viewerTouches = new Map();
          for (const t of e.touches) viewerTouches.set(t.identifier, { x: t.clientX, y: t.clientY });
          viewerPrev = new Map(viewerTouches);
          if (viewerTouches.size < 2) viewerLastPinch = 0;
        }
      };
      viewerOverlay.addEventListener('touchend', endViewer, { passive: false });
      viewerOverlay.addEventListener('touchcancel', endViewer, { passive: false });
    }
    const img = viewerOverlay.querySelector('.viewer-img');
    img.src = src;
    viewerOverlay.classList.remove('hidden');
    resetViewerTransform();
    try { history.pushState({ viewer: true }, ''); } catch (_) {}
  }

  function closeViewerOverlay() {
    if (viewerOverlay) viewerOverlay.classList.add('hidden');
  }
  // 手机返回键：查看器打开时优先关查看器（WebView goBack 触发 popstate）
  window.addEventListener('popstate', () => {
    if (viewerOverlay && !viewerOverlay.classList.contains('hidden')) closeViewerOverlay();
  });

  // 图片区事件：保存按钮 / 生成图缓存到 App / 中继取图失败换 dataURL 或本地缓存
  messagesEl.addEventListener('click', (e) => {
    const fbtn = e.target && e.target.closest ? e.target.closest('.agent-file-btn') : null;
    if (fbtn) {
      const url = fbtn.getAttribute('data-url') || '';
      const name = fbtn.getAttribute('data-name') || '文件';
      if (fbtn.classList.contains('open')) openAgentFile(url, name);
      else downloadAgentFile(url, name);
      return;
    }
    const btn = e.target && e.target.closest ? e.target.closest('.img-save-btn') : null;
    if (btn) {
      const img = btn.parentNode && btn.parentNode.querySelector('img');
      if (img && img.src) saveImageToDevice(img.src);
      return;
    }
    // 点击图片本身 → 全屏预览（手机走系统图片查看器，电脑网页新标签打开）
    const imgEl = e.target && e.target.tagName === 'IMG' ? e.target : null;
    if (imgEl && imgEl.src) {
      let url = imgEl.src;
      if (url.indexOf('/') === 0 && url.indexOf('//') !== 0 && !/^data:/.test(url)) {
        try { url = location.origin + url; } catch (_) {}
      }
      try {
        if (window.AndroidBridge && ('ontouchstart' in window)) {
          // 手机端：内置全屏查看器（双指缩放），不再跳系统
          openImageViewerOverlay(url);
        } else if (window.AndroidBridge && window.AndroidBridge.openImageViewer) {
          window.AndroidBridge.openImageViewer(url); // 后备
        } else {
          window.open(url, '_blank');
        }
      } catch (_) {}
    }
  });
  messagesEl.addEventListener('load', (e) => {
    const img = e.target;
    if (img && img.tagName === 'IMG') cacheGeneratedImage(img);
  }, true);
  messagesEl.addEventListener('error', (e) => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG') return;
    if (img.dataset && img.dataset.save && String(img.dataset.save).indexOf('/uploads/comfy-') === 0) {
      resolveComfyImg(img); // 中继/本地缓存兜底
      return;
    }
    if (img.dataset && img.dataset.failed) return; // 已兜底过
    img.dataset.failed = '1';
    const wrap = img.parentNode;
    if (!wrap) return;
    img.classList.add('img-broken');
    const note = document.createElement('div');
    note.className = 'img-fail-note';
    note.innerHTML = '图片加载失败 <button class="img-retry-btn">重试</button>';
    note.querySelector('.img-retry-btn').addEventListener('click', () => {
      img.classList.remove('img-broken');
      img.dataset.failed = '';
      img.src = img.dataset.save || img.src;
      note.remove();
    });
    wrap.appendChild(note);
  }, true);

  // 回合超时兜底：生成完成但长时间未收到 turn/completed 时提示可刷新恢复
  let turnFallbackTimer = null;
  function scheduleTurnFallback(sec) {
    clearTimeout(turnFallbackTimer);
    turnFallbackTimer = setTimeout(() => {
      if (!state.running) return;
      const el = document.createElement('div');
      el.className = 'system-line';
      el.innerHTML = '⚠ 回复似乎卡住了，<span class="link-btn" id="turnFallbackReload">点此刷新</span>';
      messagesEl.appendChild(el);
      const b = el.querySelector('#turnFallbackReload');
      if (b) b.addEventListener('click', async () => {
        if (relayCfg) { location.reload(); return; }
        try {
          const h = await fetch('/api/health', { cache: 'no-store' });
          if (h.ok) { location.reload(); return; }
        } catch (_) {}
        startAutoRecovery();
      });
      scrollBottom();
    }, (sec || 60) * 1000);
  }
  function cancelTurnFallback() {
    if (turnFallbackTimer) { clearTimeout(turnFallbackTimer); turnFallbackTimer = null; }
  }

  // 电脑端假死自动恢复：显示“正在自动重启”，每 5 秒探活，恢复后重连并重载历史
  let autoRecoveryTimer = null;
  function startAutoRecovery() {
    if (autoRecoveryTimer) return;
    setStatus('电脑端无响应，正在自动重启（约 30 秒）…', true);
    showToast('电脑端无响应，正在自动重启（约 30 秒）…', true);
    autoRecoveryTimer = setInterval(async () => {
      let ok = false;
      try {
        if (relayCfg) {
          stopAllRelayChannels();
          relayChannel = null;
          await connectRelay();
          ok = true;
        } else {
          const ctl = new AbortController();
          const to = setTimeout(() => ctl.abort(), 4000);
          const h = await fetch('/api/health', { cache: 'no-store', signal: ctl.signal });
          clearTimeout(to);
          ok = h.ok;
        }
      } catch (_) { ok = false; }
      if (!ok) return;
      clearInterval(autoRecoveryTimer);
      autoRecoveryTimer = null;
      setStatus('电脑端已恢复，正在重连…');
      reconnectAll();
    }, 5000);
  }

  // 请求超时/断连后先探活：电脑端还活着（只是慢）不打扰；真无响应才进入自动恢复
  async function handleUnresponsive(e) {
    if (relayCfg) return false; // 中继模式走既有重连逻辑
    if (!isTransientThreadErr((e && e.message) || '')) return false;
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 4000);
      const h = await fetch('/api/health', { cache: 'no-store', signal: ctl.signal });
      clearTimeout(to);
      if (!h.ok) throw new Error('health');
      return false;
    } catch (_) {
      startAutoRecovery();
      return true;
    }
  }

  // 电脑端探活 + 全链路重连：SSE / 中继 / 会话列表 / 当前对话
  async function reconnectAll() {
    showToast('正在重连…');
    try {
      if (!relayCfg) {
        const h = await fetch('/api/health', { cache: 'no-store' });
        if (!h.ok) throw new Error('health');
      }
      if (relayCfg) {
        stopAllRelayChannels();
        relayChannel = null;
        await connectRelay();
        reportCapabilities();
      }
      if (es) { try { es.close(); } catch (_) {} connectSSE(); }
      await loadThreads();
      if (state.currentId) await openThread(state.currentId);
      showToast('已重连');
      setStatus('已连接');
    } catch (e) {
      showToast('电脑端无响应，请重启电脑端 start.bat', true);
      setStatus('电脑端无响应，请重启 start.bat', true);
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
    if (/^comfy/.test(method)) console.log('[event] ' + method + ' ' + JSON.stringify(params).slice(0, 200));
    if (!params.threadId && !/^comfy/.test(method)) return;
    if (params.threadId && (!state.currentId || params.threadId !== state.currentId)) return;
    traceEvent(method);
    lastTurnActivityAt = Date.now();

    if (method === 'turn/started') {
      turnGenCount = 0; // 新回合重置生图计数
      genConfirmApproved = false;
      state.turnId = params.turn && params.turn.id;
      state.running = true;
      turnStartLastMsgId = currentLastMsgId();
      deleteTempsForConv(state.currentId);
      replySeen[state.turnId] = false;
      setStatus('正在运行…');
      $('interruptBtn').classList.remove('hidden');
      turnStartAt = Date.now();
      lastTurnActivityAt = Date.now();
      liveReplyId = null;
      updateThinkingIndicator(true);
      startTurnPolling();
      startTurnWatchdog();
    } else if (method === 'comfyStarted') {
      startComfyProgress(params.promptId);
    } else if (method === 'comfyProgress') {
      updateComfyProgress(params.promptId, params.value, params.max);
    } else if (method === 'comfyDone') {
      finishComfyProgress(params.promptId);
      scheduleTurnFallback(60); // 图已生成，若回合迟迟不结束则提示刷新恢复
    } else if (method === 'comfyError') {
      finishComfyProgress(params.promptId);
      addSystemLine('⚠️ 图像生成失败: ' + ((params.error) || '未知错误'));
    } else if (method === 'turn/completed') {
      cancelTurnFallback();
      stopTurnPolling();
      stopTurnWatchdog();
      updateThinkingIndicator(false);
      state.running = false;
      state.turnId = null;
      setStatus(params.turn && params.turn.status === 'failed' ? '出错: ' + ((params.turn.error && params.turn.error.message) || '未知错误') : '已完成');
      $('interruptBtn').classList.add('hidden');
      clearComfyCards(); // 回合结束，清掉未随 comfyDone 移除的残留/未绑定卡
      for (const b of state.blocks.values()) b.classList.remove('typing');
      loadThreads();
      const tid = params.turn && params.turn.id;
      // 立即试一次自动朗读（DOM 已有真实消息 id 时直接触发）
      triggerAutoSpeak();
      setTimeout(async () => {
        if (state.turnId && state.turnId !== tid) return;
        await refreshThreadNow();
        triggerAutoSpeak();
      }, 400);
    } else if (method === 'turn/error') {
      cancelTurnFallback();
      stopTurnPolling();
      stopTurnWatchdog();
      updateThinkingIndicator(false);
      state.running = false;
      liveReplyId = null;
      setStatus('运行出错', true);
      clearComfyCards();
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
      const agentEl = block.closest ? block.closest('.msg.agent') : null;
      if (agentEl) updateSpeakBtnVisibility(agentEl);
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
      // 卡片双保险：没有等待绑定的预创建卡时，检测到 generate_image 就兜底建卡
      if (/generate_image/i.test(String(item.tool || item.name || ''))) {
        turnGenCount++;
        const hasUnbound = [...comfyCards.values()].some(r => !r.bound);
        if (turnGenCount > 6) {
          if (!hasUnbound && !genConfirmApproved) {
            showConfirmDialog('检测到多次生图请求（第 ' + turnGenCount + ' 次），是否确认继续生成？').then(ok => {
              if (ok) {
                genConfirmApproved = true;
                startComfyProgress('tool-' + item.id);
              } else {
                showToast('已停止后续生图', true);
                interrupt();
              }
            });
          }
        } else if (!hasUnbound) {
          startComfyProgress('tool-' + item.id);
        }
      }
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
      if ((item.text || '').trim()) replySeen[state.turnId] = true;
      block.classList.add('agent-text');
      const agentEl = block.closest ? block.closest('.msg.agent') : null;
      if (agentEl) updateSpeakBtnVisibility(agentEl);
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
      if (/generate_image/i.test(String(item.tool || item.name || ''))) finishComfyProgress('tool-' + item.id);
    }
    scrollBottom();
  }

  async function refreshThreadNow() {
    if (!state.currentId) return;
    try {
      const data = await apiCall('threadReadPage', { threadId: state.currentId, limit: 10 });
      const thread = data.thread || {};
      state.pageTurns = data.turns || [];
      state.threadPage = { hasMore: !!data.hasMore, nextCursor: data.nextCursor || 0, loading: false };
      state.blocks.clear();
      speakButtons.clear();
      state.approvals.clear();
      approvalArea.innerHTML = '';
      clearMessagesPreserveComfyStack();
      const thName = thread.name || thread.title || thread.preview;
      if (thName) chatTitle.textContent = thName;
      if (thread.status && thread.status.type === 'active') {
        state.running = true;
        setStatus('正在运行…');
      } else {
        state.running = false;
        setStatus('已连接');
      }
      renderHistory(state.pageTurns);
      scrollBottom();
      restoreSpeakBtnState();
      let hasText = false;
      for (const t of state.pageTurns) {
        for (const item of (t.items || [])) {
          if ((item.type === 'agentMessage' || item.type === 'reasoning') && ((item.text || item.summary || '')).trim()) { hasText = true; break; }
        }
        if (hasText) break;
      }
      if (!hasText) addSystemLine('⚠ 本轮已完成，但没收到回复内容（请把电脑窗口的文字发给我）');
    } catch (_) {}
  }

  function refreshThreadFromData(thread) {
    state.blocks.clear();
    speakButtons.clear();
    state.approvals.clear();
    approvalArea.innerHTML = '';
    clearMessagesPreserveComfyStack();
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
    renderHistory(state.pageTurns);
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
      const convAtRead = state.currentId;
      try {
        const data = await apiCall('threadReadPage', { threadId: state.currentId, limit: 10 });
        const thread = data.thread || {};
        const turns = data.turns || [];
        state.pageTurns = turns;
        state.threadPage = { hasMore: !!data.hasMore, nextCursor: data.nextCursor || 0, loading: false };
        const targetTurnId = state.turnId;
        let target = null;
        if (targetTurnId) target = turns.find(t => t.id === targetTurnId) || null;
        if (!target && turns.length) target = turns[turns.length - 1];
        if (!target) return;
        const threadIdle = !(thread.status && thread.status.type === 'active');
        const turnDone = threadIdle || (target.status && target.status !== 'inProgress');
        if (!turnDone) return;
        stopTurnPolling();
        if (state.currentId !== convAtRead) return;
        const doneId = target.id;
        if (!replySeen[doneId]) {
          replySeen[doneId] = true;
          refreshThreadFromData(thread);
          // 事件丢失时由轮询兜底：刷新完成同样触发自动朗读
          triggerAutoSpeak();
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

  // 断线重连后，如果电脑端回合其实还在跑，恢复轮询与看门狗
  function resumeTurnIfActive() {
    if (!state.currentId) return;
    apiCall('threadReadPage', { threadId: state.currentId, limit: 10 }).then((data) => {
      const thread = data.thread || {};
      if (thread.status && thread.status.type === 'active') {
        state.running = true;
        const turns = data.turns || [];
        state.turnId = (turns.length && turns[turns.length - 1].id) || null;
        turnStartAt = Date.now();
        lastTurnActivityAt = Date.now();
        updateThinkingIndicator(true);
        startTurnPolling();
        startTurnWatchdog();
      }
    }).catch(() => {});
  }

  function startTurnWatchdog() {
    stopTurnWatchdog();
    turnWatchdog = setInterval(() => {
      if (!state.running || !state.currentId) {
        stopTurnWatchdog();
        return;
      }
      const now = Date.now();
      const idleSec = Math.floor((now - lastTurnActivityAt) / 1000);
      const totalSec = Math.floor((now - turnStartAt) / 1000);
      if (idleSec > STUCK_IDLE_SEC || totalSec > STUCK_TOTAL_SEC) {
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
      '<div class="a-body">' +
      (cmd ? '<div class="a-cmd">' + escapeHtml(cmd) + '</div>' : '') +
      (p.cwd ? '<div class="a-cmd">目录: ' + escapeHtml(p.cwd) + '</div>' : '') +
      (p.reason ? '<div class="a-reason">原因: ' + escapeHtml(p.reason) + '</div>' : '') +
      '</div>' +
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
    if (relayCfg && !(relayChannel && relayChannel.ready)) {
      setStatus('电脑端未运行，请检查电脑上的 start.bat 窗口', true);
      showToast('电脑端未运行，请检查电脑上的 start.bat 窗口', true);
      return;
    }
    stopSpeaking(); // 发送即停旧语音播放并取消旧合成
    const text = inputBox.value.trim();
    const images = state.pendingImages.slice();
    const files = state.pendingFiles.slice();
    if (!text && !images.length && !files.length) return;
    let sendText = text;
    if (quotedMsg) {
      sendText = '【引用 ' + quotedMsg.author + '】' + quotedMsg.text + '\n' + text;
      clearQuote();
    }
    inputBox.value = '';
    state.pendingImages = [];
    state.pendingFiles = [];
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
    addUserMessage(sendText, images.map(i => i.dataUrl), files);
    // 预创建：消息里命中“两张/三张/N张…图”时，立即创建整叠卡片，不等 comfyStarted
    const preCount = parseImageCount(sendText);
    if (preCount >= 2) precreateComfyStack(preCount);

    try {
      const data = await apiCall('turnStart', {
        threadId: state.currentId,
        text: sendText,
        images: images.map(i => ({ name: i.name, data: i.dataUrl })),
        files: files.map(f => ({ name: f.name, data: f.data })),
        effort: currentEffort,
        autoSpeak: autoSpeak
      });
      const turn = data.turn || data;
      if (turn && turn.id) {
        state.turnId = turn.id;
        state.running = true;
        turnGenCount = 0;
        genConfirmApproved = false;
        turnStartLastMsgId = currentLastMsgId(); // 回合前基线：新回复 id 与其不同才会自动朗读
        replySeen[turn.id] = false;
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
      clearComfyCards();
      handleUnresponsive(e);
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

  // ---------- attach menu ----------
  const attachBtn = $('attachBtn');
  const attachMenu = $('attachMenu');
  function closeAttachMenu() { attachMenu.classList.add('hidden'); }
  attachBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    attachMenu.classList.toggle('hidden');
  });
  attachMenu.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-pick]');
    if (!btn) return;
    closeAttachMenu();
    if (btn.dataset.pick === 'image') $('imageInput').click();
    else $('fileInput').click();
  });
  if (document.addEventListener) document.addEventListener('click', closeAttachMenu);

  // ---------- file attach ----------
  $('fileInput').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    const limit = relayCfg ? RELAY_MAX_FILE_BYTES : MAX_FILE_BYTES;
    for (const f of files) {
      const ext = (f.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
      if (!TEXT_FILE_EXTS.includes(ext)) {
        showToast('不支持的文件类型：' + f.name + '（仅支持文本类文件：txt/md/json/csv/代码等）', true);
        continue;
      }
      if (f.size > limit) {
        showToast((relayCfg ? '中继模式' : '') + '单文件上限 ' + formatBytes(limit) + '：' + f.name, true);
        continue;
      }
      try {
        const dataUrl = await readFileDataUrl(f);
        state.pendingFiles.push({ name: f.name, size: f.size, data: dataUrl });
      } catch (_) {
        showToast('读取文件失败：' + f.name, true);
      }
    }
    renderImagePreviews();
  });

  function readFileDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(file);
    });
  }

  function formatBytes(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

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
    state.pendingFiles.forEach((f, i) => {
      const d = document.createElement('div');
      d.className = 'file-chip';
      const nameEl = document.createElement('span');
      nameEl.className = 'file-name';
      nameEl.textContent = '📄 ' + f.name;
      const sizeEl = document.createElement('span');
      sizeEl.className = 'file-size';
      sizeEl.textContent = formatBytes(f.size);
      const x = document.createElement('span');
      x.className = 'x';
      x.textContent = '×';
      x.addEventListener('click', () => {
        state.pendingFiles.splice(i, 1);
        renderImagePreviews();
      });
      d.appendChild(nameEl);
      d.appendChild(sizeEl);
      d.appendChild(x);
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

  // 通用确认弹窗（Promise：确认 true / 取消 false）
  function showConfirmDialog(message) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'confirm-dialog';
      overlay.innerHTML = '<div class="confirm-box"><div class="confirm-msg"></div>' +
        '<div class="confirm-btns"><button class="btn primary small" id="confirmOk">确认</button>' +
        '<button class="btn ghost small" id="confirmCancel">取消</button></div></div>';
      overlay.querySelector('.confirm-msg').textContent = message;
      const close = val => { overlay.remove(); resolve(val); };
      overlay.querySelector('#confirmOk').addEventListener('click', () => close(true));
      overlay.querySelector('#confirmCancel').addEventListener('click', () => close(false));
      document.body.appendChild(overlay);
    });
  }

  function addSystemLine(text) {
    const el = document.createElement('div');
    el.className = 'system-line';
    el.textContent = text;
    messagesEl.appendChild(el);
    scrollBottom();
  }

  const COMFY_PLACEHOLDER_SVG =
    '<svg width="320" height="200" viewBox="0 0 320 200" xmlns="http://www.w3.org/2000/svg">' +
    '<defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0e1a24"/><stop offset="1" stop-color="#14332d"/></linearGradient></defs>' +
    '<rect width="320" height="200" fill="url(#cg)"/>' +
    '<circle cx="58" cy="42" r="2.2" fill="#9fd9c8"/><circle cx="132" cy="24" r="1.6" fill="#9fd9c8"/><circle cx="232" cy="48" r="2" fill="#9fd9c8"/><circle cx="282" cy="30" r="1.5" fill="#9fd9c8"/><circle cx="182" cy="18" r="1.8" fill="#9fd9c8"/>' +
    '<path d="M34 158 Q84 128 148 156 T286 142 V200 H34 Z" fill="#0b1713"/>' +
    '<path d="M96 158 Q104 136 102 114 Q110 126 116 118 Q122 130 126 158 Z" fill="#7fd4bd"/>' +
    '<path d="M200 164 Q208 146 206 128 Q212 138 218 130 Q224 142 228 164 Z" fill="#7fd4bd" opacity="0.8"/>' +
    '</svg>';

  // 卡片状态：queued（排队中）→ generating（顶层计时）→ done（完成/失败，半透明留在堆里，回合结束统一清理）
  const comfyCards = new Map(); // 插入序 key -> { id, promptId, card, badge, timer, startTs, pct, state, seq, fading, rising, bound }
  let comfySeq = 0;
  let comfyStackEl = null;

  // 堆叠容器嵌在消息流内（#messages 末尾），随消息滚动；
  // 切换对话不清卡：清空消息区时先摘走容器，清完再挂回，卡片与计时不丢。
  function ensureComfyStack() {
    if (!comfyStackEl || !comfyStackEl.parentNode) {
      comfyStackEl = document.createElement('div');
      comfyStackEl.className = 'comfy-stack';
      (messagesEl || document.body).appendChild(comfyStackEl);
    }
    // 兜底重挂：容器/卡片 DOM 意外丢失但仍有生成任务时，按 Map 恢复每张卡
    for (const rec of comfyCards.values()) {
      if (rec.card && rec.card.parentNode) continue;
      const made = makeComfyCard();
      rec.card = made.card;
      rec.badge = made.badge;
      comfyStackEl.appendChild(rec.card);
      updateComfyBadge(rec);
    }
    reflowComfyStack();
    return comfyStackEl;
  }

  function restoreComfyStackIfNeeded() {
    if (comfyCards.size === 0) return;
    ensureComfyStack();
    // 确保堆叠在消息流末尾（渲染历史可能把消息追加到它后面）
    if (comfyStackEl && comfyStackEl.parentNode && comfyStackEl.parentNode.lastChild !== comfyStackEl) {
      comfyStackEl.parentNode.appendChild(comfyStackEl);
    }
    scrollBottom();
  }

  // 清空消息区但保留生成中的堆叠：先摘走容器，清空后立即挂回末尾
  function clearMessagesPreserveComfyStack() {
    if (comfyStackEl && comfyStackEl.parentNode === messagesEl) {
      comfyStackEl.parentNode.removeChild(comfyStackEl);
    }
    messagesEl.innerHTML = '';
    if (comfyStackEl && comfyCards.size > 0) messagesEl.appendChild(comfyStackEl);
  }

  function removeComfyStackIfEmpty() {
    if (comfyCards.size === 0 && comfyStackEl && comfyStackEl.parentNode) {
      comfyStackEl.parentNode.removeChild(comfyStackEl);
      comfyStackEl = null;
    }
  }

  function comfyFind(id) {
    if (!id) return null;
    if (comfyCards.has(id)) return comfyCards.get(id);
    for (const rec of comfyCards.values()) if (rec.promptId === id) return rec;
    return null;
  }

  // 纸张堆叠布局：生成中的卡在最上层（slot 0、zIndex 最高、不透明），
  // 其余（排队/完成）依次向右下偏移 8px、半透明只露边角、徽标隐藏；
  // 动画中的卡（rising/fading）保持原位；全部完成无顶层时从 slot 0 起排。
  function reflowComfyStack() {
    if (!comfyStackEl) return;
    const recs = [...comfyCards.values()];
    let top = null;
    for (const c of recs) {
      if (c.state === 'generating' && !c.fading) { top = c; break; }
    }
    let nonTopSlot = top ? 1 : 0;
    for (const rec of recs) {
      if (rec.rising || rec.fading) continue;
      const isTop = rec === top;
      const slot = isTop ? 0 : nonTopSlot++;
      rec.card.style.left = (slot * 8) + 'px';
      rec.card.style.top = (slot * 8) + 'px';
      rec.card.style.zIndex = isTop ? String(recs.length + 1) : String(slot + 1);
      // 下层不透明：层级感靠边框/阴影表达，边框逐层变暗、阴影逐层加重
      rec.card.style.opacity = '1';
      rec.card.style.borderColor = 'rgba(0,210,160,' + Math.max(0.25, 0.6 - slot * 0.09).toFixed(2) + ')';
      rec.card.style.boxShadow = isTop
        ? '0 0 18px rgba(0,210,160,0.12)'
        : '0 ' + (slot * 2) + 'px ' + (4 + slot * 2) + 'px rgba(0,0,0,0.45)';
      if (rec.badge) rec.badge.style.display = isTop ? '' : 'none';
    }
    comfyStackEl.style.height = (recs.length > 0 ? ((recs.length - 1) * 8 + 180) : 0) + 'px';
  }

  function updateComfyBadge(rec) {
    if (!rec || !rec.badge) return;
    if (rec.state === 'generating' && rec.bound) {
      const sec = Math.floor((Date.now() - rec.startTs) / 1000);
      rec.badge.textContent = '生成中 ' + sec + 's' + (rec.pct != null ? ' · ' + rec.pct + '%' : '');
    } else if (rec.state === 'generating') {
      rec.badge.textContent = '准备中';
    } else if (rec.state === 'queued') {
      rec.badge.textContent = '排队中';
    } else if (rec.state === 'done') {
      rec.badge.textContent = '已完成';
    }
  }

  function startCardTimer(rec) {
    if (rec.timer) return;
    if (!rec.startTs) rec.startTs = Date.now();
    rec.state = 'generating';
    rec.pct = null;
    updateComfyBadge(rec);
    rec.timer = setInterval(() => updateComfyBadge(rec), 1000);
  }

  function findNextQueued() {
    let next = null;
    for (const rec of comfyCards.values()) {
      if (rec.state === 'queued' && (!next || rec.seq < next.seq)) next = rec;
    }
    return next;
  }

  function parseChineseNum(w) {
    const numMap = { 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15, 十六: 16, 十七: 17, 十八: 18, 十九: 19, 二十: 20 };
    if (numMap[w] != null) return numMap[w];
    const n = parseInt(w, 10);
    return isNaN(n) ? 0 : n;
  }

  // 解析图片数量：1) 显式数量词（两张/三个/2版…）+ 图/版本/对比/一起语境；
  // 2) 对比/放一起/分别 句式按列出的对象数推断；3) 多图暗示词兜底 2 张。
  // 命中且 >=2 才预创建；无法确定时返回 0 走原逻辑。
  function parseImageCount(text) {
    const s = String(text || '');
    // 1) 显式数量
    const m = s.match(/(\d+|两|二|三|四|五|六|七|八|九|十|十一|十二|十三|十四|十五|十六|十七|十八|十九|二十)\s*(张|个|种|版|套)/);
    if (m && /图|图片|版本|对比|一起|放一起|壁纸|插画|封面|照片|分镜|效果/.test(s)) {
      const n = parseChineseNum(m[1]);
      if (n >= 2) return Math.min(n, 9);
    }
    // 2) 对比/放一起/分别：按列出的对象数推断（“默认和分镜版”=2，“默认、分镜、电影感”=3）
    if (/对比|放一起|放在一起|一起出|一起看|分别/.test(s)) {
      // “分别”后跟列出的对象；对比类取关键词前不含逗号的最后一个片段
      const listPart = /分别/.test(s)
        ? s.split(/分别/).pop()
        : ((s.match(/([^，。！？\n]{1,40}?)(?:对比|放一起|放在一起|一起出|一起看)/) || [])[1] || '');
      const tokens = listPart.split(/和|与|、|,|，|\s*\/\s*/).map(t => t.trim()).filter(Boolean);
      if (tokens.length >= 2) return Math.min(tokens.length, 9);
    }
    // 3) 明确单张不预创建；多图暗示词兜底 2 张
    if (/一\s*(张|个|种|版)|1\s*(张|个|种|版)/.test(s)) return 0;
    if (/多张|多个|几种|几版|几个版本|分别生成|多版本|对比|一起|放一起/.test(s)) return 2;
    return 0;
  }

  function makeComfyCard() {
    const card = document.createElement('div');
    card.className = 'comfy-generating';
    card.innerHTML = '<div class="comfy-placeholder">' + COMFY_PLACEHOLDER_SVG + '</div><div class="comfy-badge"></div>';
    // 内联样式兜底：绕过 CSS 缓存/flex 挤压，保证卡片高度不被压成 0
    card.style.cssText = 'display:block; flex:0 0 auto; min-height:180px;';
    const ph = card.querySelector('.comfy-placeholder');
    if (ph) ph.style.cssText = 'width:100%; height:180px; display:block;';
    const bd = card.querySelector('.comfy-badge');
    if (bd) bd.style.cssText = 'position:absolute; top:8px; left:8px;';
    return { card, badge: bd };
  }

  // 消息一发出、命中数量词时立即预创建整叠卡片（第1张“准备中”，其余“排队中”）
  function precreateComfyStack(count) {
    if (!(count >= 2) || comfyCards.size > 0) return;
    const stack = ensureComfyStack();
    for (let i = 0; i < count; i++) {
      const made = makeComfyCard();
      stack.appendChild(made.card);
      const rec = {
        id: 'pre-' + (++comfySeq), promptId: null, card: made.card, badge: made.badge,
        timer: null, startTs: 0, pct: null,
        state: i === 0 ? 'generating' : 'queued',
        seq: ++comfySeq, fading: false, rising: false, bound: false
      };
      updateComfyBadge(rec);
      comfyCards.set(rec.id, rec);
    }
    reflowComfyStack();
    scrollBottom();
  }

  // 把真实 promptId / 兜底 tool id 绑定到最早的未绑定卡；已在顶层的卡立即开始计时
  function bindComfyCard(rec, realId) {
    rec.promptId = realId;
    rec.bound = true;
    if (rec.state === 'generating') {
      startCardTimer(rec);
    } else {
      rec.startTs = Date.now(); // 已开始生成，上浮后按此时间计时
    }
  }

  function startComfyProgress(id) {
    if (!id) id = 'seq' + (++comfySeq);
    if (comfyFind(id)) return;
    // 预创建池优先：绑定最早的未绑定卡
    let pre = null;
    for (const rec of comfyCards.values()) if (!rec.bound && (!pre || rec.seq < pre.seq)) pre = rec;
    if (pre) {
      bindComfyCard(pre, id);
      reflowComfyStack();
      scrollBottom();
      return;
    }
    // 真实 promptId 到达时，优先改绑兜底建的 tool 卡，避免同一张生成出现两张卡
    if (!String(id).startsWith('tool-')) {
      let toolRec = null;
      for (const rec of comfyCards.values()) {
        if (rec.bound && String(rec.promptId || '').indexOf('tool-') === 0) { toolRec = rec; break; }
      }
      if (toolRec) {
        toolRec.promptId = id;
        reflowComfyStack();
        return;
      }
    }
    // 无预创建（单图/数量未命中/超出预创建上限）：按原逻辑新建一张
    let generating = null;
    for (const c of comfyCards.values()) if (c.state === 'generating') { generating = c; break; }
    const stack = ensureComfyStack();
    const made = makeComfyCard();
    stack.appendChild(made.card);
    const rec = {
      id, promptId: id, card: made.card, badge: made.badge,
      timer: null, startTs: 0, pct: null,
      state: 'queued', seq: ++comfySeq, fading: false, rising: false, bound: true
    };
    comfyCards.set(id, rec);
    if (generating) {
      if (made.badge) made.badge.textContent = '排队中';
    } else {
      rec.state = 'generating';
      startCardTimer(rec);
    }
    reflowComfyStack();
    scrollBottom();
  }

  function updateComfyProgress(id, value, max) {
    const rec = comfyFind(id);
    if (!rec) return;
    rec.pct = max > 0 ? Math.min(100, Math.round(Number(value) * 100 / Number(max))) : 0;
    updateComfyBadge(rec);
  }

  function clearComfyCards() {
    for (const rec of [...comfyCards.values()]) {
      if (rec.timer) { clearInterval(rec.timer); rec.timer = null; }
      if (rec.card && rec.card.parentNode) rec.card.parentNode.removeChild(rec.card);
    }
    comfyCards.clear();
    removeComfyStackIfEmpty();
  }

  function finishComfyProgress(id) {
    if (id == null) {
      clearComfyCards();
      return;
    }
    const rec = comfyFind(id);
    if (!rec) return;
    completeComfyCard(rec);
  }

  // 完成/失败：不抽走移除，改为“下沉留在堆里”（done，半透明），下一张上浮；
  // 整叠卡片等回合结束统一清理，保证串行多图时堆叠视觉不中断。
  function completeComfyCard(rec) {
    if (rec.timer) { clearInterval(rec.timer); rec.timer = null; }
    const finishState = () => {
      rec.state = 'done';
      rec.fading = false;
      promoteNextComfyCard();
      reflowComfyStack();
    };
    // 排队中的卡（从未在顶层）直接标记完成
    if (rec.state !== 'generating') {
      rec.state = 'done';
      reflowComfyStack();
      return;
    }
    const hasQueued = [...comfyCards.values()].some(c => c.state === 'queued');
    const startSink = () => {
      if (!rec.card || !rec.card.parentNode) { finishState(); return; }
      rec.fading = true;
      rec.card.style.transition = 'opacity .5s ease, left .5s ease, top .5s ease, border-color .5s ease';
      rec.card.style.opacity = '1';
      rec.card.style.borderColor = 'rgba(0,210,160,0.5)';
      // 下一张同时从背后上浮到顶层（位置/不透明度/缩放连续过渡）
      const next = findNextQueued();
      if (next) {
        // 完成的卡下沉一层（右下 8px），下一张上浮到 slot 0
        rec.card.style.left = '8px';
        rec.card.style.top = '8px';
        rec.card.style.zIndex = '1';
        next.rising = true;
        next.card.style.transition = 'none';
        next.card.style.transform = 'translate(0, 6px) scale(0.97)';
        void next.card.offsetWidth; // 强制重排后开始过渡
        next.card.style.transition = 'opacity .55s ease, transform .55s ease, left .55s ease, top .55s ease';
        next.card.style.left = '0px';
        next.card.style.top = '0px';
        next.card.style.zIndex = '999';
        next.card.style.opacity = '1';
        next.card.style.transform = 'none';
        if (next.badge) next.badge.style.display = '';
        if (next.bound) {
          startCardTimer(next);
        } else if (next.badge) {
          next.badge.textContent = '排队中';
        }
      }
      setTimeout(finishState, 520);
    };
    // 生成中卡最短可见约 1.5 秒（无排队时）；有排队则立即下沉，下一张跟上
    const wait = (!hasQueued) ? Math.max(0, 1500 - (Date.now() - rec.startTs)) : 0;
    if (wait > 0) { setTimeout(startSink, wait); } else { startSink(); }
  }

  function promoteNextComfyCard() {
    const next = findNextQueued();
    if (!next) return;
    next.fading = false;
    next.rising = false;
    next.card.style.transition = 'none';
    if (next.bound) {
      startCardTimer(next);
    } else {
      next.state = 'generating';
      updateComfyBadge(next); // “排队中”，等 comfyStarted 到达后转计时
    }
    reflowComfyStack();
  }

  // 把手机端能力开关状态告诉电脑（图像生成等能力在电脑侧执行前需要校验）
  function reportCapabilities() {
    if (!window.AndroidBridge || !window.AndroidBridge.getCapabilities) return;
    let caps = {};
    try { caps = JSON.parse(window.AndroidBridge.getCapabilities() || '{}') || {}; } catch (_) {}
    apiCall('reportCapabilities', { caps }).catch(() => {});
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

  // 删除对话后清理本地残留：该会话的语音记录（下载标记/图片映射按 URL 全局共用，无法按会话归属，不清理）
  function clearConvLocalData(convId) {
    const meta = getTtsMeta();
    const remove = [];
    for (const id of Object.keys(meta)) {
      if (String(meta[id].convId) === String(convId)) remove.push(id);
    }
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
            temp: !!temp,
            segs: Math.max(idx + 1, prev.segs || 0)
          };
          setTtsMeta(meta);
          cleanupTts();
          return blob;
        } catch (e) {
          lastErr = e;
          if (attempt === 0) await sleep(1500);
        }
      }
      throw lastErr;
    })();
    ttsGenerating.set(key, p);
    p.catch(() => {}).then(() => ttsGenerating.delete(key));
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
      // 注册表可能被刷新清掉但 DOM 还在：从 DOM 找回并重新注册
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
    btn.classList.remove('speaking', 'disabled', 'loading');
    btn.disabled = false;
    if (state === 'playing') {
      btn.textContent = '⏹ 停止';
      btn.classList.add('speaking');
    } else if (state === 'loading') {
      btn.textContent = '⏳ 生成中…';
      btn.classList.add('loading');
    } else {
      btn.textContent = '🔊 朗读';
    }
  }

  // 后台刷新重建界面后，恢复当前朗读按钮的状态
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
      const clone = b.cloneNode(true);
      clone.querySelectorAll('.agent-img').forEach(n => n.remove()); // 纯图片不参与朗读
      clone.querySelectorAll('.agent-file').forEach(n => n.remove()); // 文件不参与朗读
      const t = (clone.textContent || '').trim();
      if (t) parts.push(t);
    }
    return parts.join('\n');
  }

  // 纯图片消息隐藏“朗读”按钮（混合消息有文字则显示）
  function updateSpeakBtnVisibility(agentEl) {
    if (!agentEl) return;
    const spk = agentEl.querySelector('.speak-btn');
    if (!spk) return;
    const hasText = collectAgentText(agentEl).length > 0;
    spk.classList.toggle('hidden', !hasText);
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
    // 兼容刷新后按钮归属变化：始终复位当前活跃会话的按钮
    const k = ttsActiveKey || key;
    ttsActiveKey = null;
    ttsActiveState = 'idle';
    setSpeakBtn(k, 'idle');
  }

  async function tryTtsStatus(text) {
    try {
      const st = await apiCall('ttsStatus', { text: text || '' }, 15000);
      if (st && st.ready && st.audioB64) return st;
    } catch (_) {}
    return null;
  }

  // 自动朗读：等预生成缓存就绪（每 0.5s 轮询，最长 maxMs），避免与语音服务实时锁互抢
  function waitTtsStatus(text, maxMs) {
    return new Promise(resolve => {
      const t0 = Date.now();
      const tick = async () => {
        const st = await tryTtsStatus(text);
        if (st && !st.partial) { resolve(st); return; }
        if (Date.now() - t0 >= maxMs) { resolve(null); return; }
        setTimeout(tick, 500);
      };
      tick();
    });
  }

  // 朗读超时按文本长度自适应：每字预留 1.5s + 15s 余量，最短 30s，最长 120s
  function ttsTimeoutFor(text, minMs) {
    const n = String(text || '').length;
    return Math.min(120000, Math.max(minMs || 30000, n * 1500 + 15000));
  }

  async function runTtsStream(convId, msgId, streamText, startIdx, auto, temp, session) {
    const msgKey = ttsKey(convId, msgId);
    const sid = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    ttsStreamState = { sid, session, chunks: [], ended: false, ok: false, error: '', resolvers: [] };
    ttsLanReader = null;
    try {
      if (relayCfg) {
        await apiCall('ttsStreamStart', { text: streamText }, ttsTimeoutFor(streamText, 30000));
      } else {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), ttsTimeoutFor(streamText, 30000)); // 超时按长度放宽（每字1.5s+15s）
        let res;
        try {
          res = await fetch('/api/tts/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: streamText }),
            signal: ctl.signal
          });
        } finally {
          clearTimeout(timer);
        }
        if (!res.ok || !res.body) throw new Error('语音流服务返回 ' + res.status);
        consumeLanTtsStream(res, sid, session);
      }
    } catch (e) {
      // 流式不可用/超时：自动朗读先等预生成缓存，仍不行再退回分段合成
      ttsStreamState = null;
      if (session !== ttsSession) return;
      if (auto) {
        const st2 = await waitTtsStatus(streamText, Math.min(ttsTimeoutFor(streamText, 30000), 60000));
        if (session !== ttsSession) return;
        if (st2 && !st2.partial) {
          const blob = b64ToBlob(st2.audioB64, st2.mime || 'audio/wav');
          await playTtsSegment(msgKey, blob, session);
          if (session === ttsSession) finishTts(msgKey);
          return;
        }
      }
      playMessageSegments(convId, msgId, streamText, auto, temp);
      return;
    }
    let idx = startIdx;
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
          temp: !!temp,
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
      idx++;
    }
    if (session === ttsSession) finishTts(msgKey);
  }

  async function playStreamMessage(convId, msgId, text, auto, temp) {
    if (!convId || !msgId || !text || !text.trim()) return;
    const msgKey = ttsKey(convId, msgId);
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

    // 1) 电脑端整段缓存（自动朗读等预生成完成，秒播；等待时间按文本长度放宽）
    const st = auto ? await waitTtsStatus(clean, ttsTimeoutFor(clean, 30000)) : await tryTtsStatus(clean);
    if (st && !st.partial) {
      const blob = b64ToBlob(st.audioB64, st.mime || 'audio/wav');
      if (session !== ttsSession || state.currentId !== convId) return;
      await playTtsSegment(msgKey, blob, session);
      if (session === ttsSession) finishTts(msgKey);
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
          temp: !!temp,
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
    // 长文本（>30 字）走分段合成，边生成边播，避免单次流式等太久
    if (clean.length > 30) {
      await playMessageSegments(convId, msgId, text, auto, temp);
      return;
    }
    // 局域网模式：走流式（边生成边播）
    await runTtsStream(convId, msgId, clean, 0, auto, temp, session);
  }

  async function playSegmentsLoop(convId, msgId, segs, startIdx, auto, temp, session) {
    const msgKey = ttsKey(convId, msgId);
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
    }
    if (session === ttsSession) finishTts(msgKey);
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
    }
    if (session === ttsSession) finishTts(msgKey);
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

  // 自动朗读（自动点击）：只在“当前回合确实有新的 agent 回复”时触发一次。
  // 事件路径和轮询兜底都会调用，靠 autoSpokenMsgKey 去重，避免双触发/漏触发。
  function maybeAutoSpeak() {
    if (!state.currentId) {
      console.log('[autoSpeak] 跳过: 无当前对话');
      return false;
    }
    if (!autoSpeak) {
      console.log('[autoSpeak] 自动朗读开关已关闭，跳过自动播放');
      return false;
    }
    const agents = messagesEl.querySelectorAll('.msg.agent');
    const last = agents[agents.length - 1];
    if (!last) {
      console.log('[autoSpeak] 跳过: 没有 AI 消息');
      return false;
    }
    const msgId = last.dataset.msgId;
    if (!msgId) {
      console.log('[autoSpeak] 跳过: 消息没有 id');
      return false;
    }
    if (String(msgId).indexOf('live-') === 0) {
      console.log('[autoSpeak] 跳过: 流式临时 id，等刷新后的真实 id');
      return false; // 流式临时 id，等刷新后的真实 id
    }
    if (msgId === turnStartLastMsgId) {
      console.log('[autoSpeak] 跳过: 本轮没有新回复（msgId 等于回合前基线）');
      return false; // 本轮没有新回复，不重读旧消息
    }
    const text = collectAgentText(last);
    if (!text.trim()) {
      console.log('[autoSpeak] 跳过: 无可朗读文字');
      return false;
    }
    const id = ttsKey(state.currentId, msgId);
    if (id === autoSpokenMsgKey) {
      console.log('[autoSpeak] 跳过: 这条已自动朗读过');
      return false; // 这条已自动朗读过，避免重复触发
    }
    // 自愈：空闲状态下清掉残留的归属键，避免误拦新消息
    if (ttsActiveKey && ttsActiveState === 'idle') ttsActiveKey = null;
    // 只拦“同一消息确实正在生成/播放中”的重复触发
    if (ttsActiveKey === id && ttsActiveState !== 'idle') {
      console.log('[autoSpeak] 跳过: 同消息正在生成/播放中');
      return false;
    }
    const meta = getTtsMeta();
    if (meta[id] && !meta[id].temp) {
      console.log('[autoSpeak] 跳过: 已完整播完过');
      return false; // 已完整播完过，手动重听即可
    }
    autoSpokenMsgKey = id;
    speakMessage(state.currentId, msgId, text, true);
    return true;
  }

  // 自动朗读入口：立即试一次；若 DOM 还没有真实消息 id，定时补试几次，
  // 期间若用户切换对话则放弃，避免误读别的对话。
  function triggerAutoSpeak() {
    const convId = state.currentId;
    if (!convId) return;
    if (maybeAutoSpeak()) return;
    clearTimeout(autoSpeakRetryTimer);
    let n = 0;
    const retry = () => {
      n++;
      if (n > 3) return;
      autoSpeakRetryTimer = setTimeout(async () => {
        if (!state.currentId || state.currentId !== convId) return;
        if (maybeAutoSpeak()) return;
        if (n >= 2) await refreshThreadNow(); // 刷新补真实 id
        if (maybeAutoSpeak()) return;
        retry();
      }, 600 * n);
    };
    retry();
  }

  function currentLastMsgId() {
    const agents = messagesEl.querySelectorAll('.msg.agent');
    const last = agents[agents.length - 1];
    return last ? (last.dataset.msgId || null) : null;
  }

  function traceEvent(name) {
    const el = $('eventTrace');
    if (!el) return;
    if (String(name || '').indexOf('comfy') !== 0) return; // 正式版只显示 comfy 相关调试事件
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

  // 上滑到顶时加载更早的 10 条历史
  messagesEl.addEventListener('scroll', () => {
    if (messagesEl.scrollTop <= 2) loadMoreThread();
  });
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
