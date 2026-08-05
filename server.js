'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const ROOT = (typeof __dirname !== 'undefined' && __dirname) || process.cwd();
const CONFIG_PATH = path.join(ROOT, 'config.json');
const PATHS_PATH = path.join(ROOT, 'paths.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const PHONE_THREADS_PATH = path.join(ROOT, 'phone-threads.json');

let phoneThreads = {};
try {
  const raw = JSON.parse(fs.readFileSync(PHONE_THREADS_PATH, 'utf8')) || {};
  if (Array.isArray(raw)) {
    phoneThreads = {};
    for (const id of raw) phoneThreads[id] = null;
  } else {
    phoneThreads = raw;
  }
} catch (_) {}

function savePhoneThreads() {
  try {
    fs.writeFileSync(PHONE_THREADS_PATH, JSON.stringify(phoneThreads, null, 2), 'utf8');
  } catch (_) {}
}

function registerPhoneThread(id, clientId) {
  if (!id) return;
  if (!(id in phoneThreads) || phoneThreads[id] === null) {
    phoneThreads[id] = clientId || null;
    savePhoneThreads();
  }
}

function ownerOfThread(id) {
  return (id in phoneThreads) ? phoneThreads[id] : null;
}

function seedPhoneThreads(arr) {
  if (Object.keys(phoneThreads).length || !Array.isArray(arr)) return;
  const ws = path.normalize(config.workspace || '');
  for (const t of arr) {
    if (t && t.cwd && path.normalize(t.cwd) === ws) registerPhoneThread(t.id, null);
  }
}

// ---------- config ----------
function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (_) {}
  const docs = process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, 'Documents', 'Codex')
    : ROOT;
  return Object.assign({
    port: 8787,
    password: '123456',
    workspace: docs,
    model: '',
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    transport: 'spawn',
    codexPath: '',
    nodePath: '',
    codexHome: path.join(os.homedir(), '.codex'),
    relayEnabled: true,
    relayBroker: 'wss://broker.emqx.io:8084/mqtt',
    relayRoomCode: '',
    shareKey: ''
  }, cfg);
}

const config = loadConfig();
const VERSION = '5.5';
const BRIDGE_ID_PATH = path.join(os.homedir(), '.codex', 'phone-bridge-id.json');
function loadBridgeId() {
  try { return JSON.parse(fs.readFileSync(BRIDGE_ID_PATH, 'utf8')) || {}; } catch (_) { return {}; }
}
function saveBridgeId(obj) {
  try {
    fs.mkdirSync(path.dirname(BRIDGE_ID_PATH), { recursive: true });
    fs.writeFileSync(BRIDGE_ID_PATH, JSON.stringify(obj, null, 2), 'utf8');
  } catch (_) {}
}
const bridgeId = loadBridgeId();
if (!bridgeId.shareKey) {
  bridgeId.shareKey = config.shareKey || crypto.randomBytes(16).toString('hex');
  saveBridgeId(bridgeId);
}
if (config.shareKey !== bridgeId.shareKey) {
  config.shareKey = bridgeId.shareKey;
  saveConfig();
}
if (!config.updateUrl) {
  config.updateUrl = 'https://raw.githubusercontent.com/oen1day/codex-phone-bridge/main/version.json';
  saveConfig();
}
if (config.relayEnabled) {
  const room = (config.relayRoomCode || '').trim().toUpperCase();
  if (!room) {
    config.relayRoomCode = 'K8X5CY';
    saveConfig();
    console.error('[config] 警告：未找到配对码，已恢复为默认 K8X5CY（请保持手机端一致）');
  } else {
    config.relayRoomCode = room;
  }
}
console.log('[config] 一键配置密钥: ' + config.shareKey);

function loadPaths() {
  try { return JSON.parse(fs.readFileSync(PATHS_PATH, 'utf8')); } catch (_) { return {}; }
}

function findCodex() {
  const paths = loadPaths();
  const candidates = [];
  if (config.codexPath) candidates.push(config.codexPath);
  if (paths.codexPath) candidates.push(paths.codexPath);
  const localAppData = process.env.LOCALAPPDATA || '';
  const binRoot = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  try {
    for (const d of fs.readdirSync(binRoot)) {
      const exe = path.join(binRoot, d, 'codex.exe');
      if (fs.existsSync(exe)) candidates.push(exe);
    }
  } catch (_) {}
  return candidates.find(p => fs.existsSync(p)) || 'codex';
}

const CODEX = findCodex();

function loadRelayModule() {
  const vm = require('vm');
  const file = path.join(ROOT, 'public', 'relay.js');
  const code = fs.readFileSync(file, 'utf8');
  const mod = { exports: {} };
  const wrapper = vm.runInThisContext(
    '(function (module, exports, require, __dirname, __filename) {' + code + '\n})',
    { filename: file }
  );
  wrapper(mod, mod.exports, require, path.dirname(file), file);
  return mod.exports;
}

const RelayChannel = loadRelayModule();

// ---------- JSON-RPC client for `codex app-server` ----------
class RpcClient extends EventEmitter {
  constructor(command, args) {
    super();
    this.command = command;
    this.args = args;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.ready = false;
    this.proc = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      const env = Object.assign({}, process.env, {
        CODEX_HOME: config.codexHome,
        FORCE_COLOR: '0',
        NO_COLOR: '1'
      });
      let proc;
      try {
        proc = spawn(this.command, this.args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
          windowsHide: true
        });
      } catch (e) {
        reject(e);
        return;
      }
      this.proc = proc;
      proc.once('error', reject);
      proc.once('spawn', resolve);
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', d => this._onData(d));
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', d => {
        const s = String(d).trim();
        if (s) console.error('[codex] ' + s);
      });
      proc.on('exit', (code, signal) => {
        this.ready = false;
        this.proc = null;
        this.emit('closed', code, signal);
        for (const p of this.pending.values()) p.reject(new Error('Codex 进程已退出'));
        this.pending.clear();
      });
    });
  }

  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      this._onMessage(msg);
    }
  }

  _onMessage(msg) {
    if (msg && msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) {
        const err = new Error((msg.error.message || JSON.stringify(msg.error)) + (msg.error.data ? ' ' + JSON.stringify(msg.error.data) : ''));
        err.code = msg.error.code;
        p.reject(err);
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (msg && msg.method) this.emit('message', msg);
  }

  call(method, params, timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this._write({ method, id, params });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('请求超时: ' + method));
        }
      }, timeoutMs || 120000);
    });
  }

  notify(method, params) {
    this._write({ method, params });
  }

  respond(id, result) {
    this._write({ id, result });
  }

  _write(obj) {
    if (!this.proc || !this.proc.stdin.writable) {
      const e = new Error('Codex 连接未就绪');
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
      return;
    }
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }
}

let client = null;
let clientStart = null;
let clientClosedAt = 0;

async function getClient() {
  if (client && client.ready && client.proc) return client;
  if (clientStart) return clientStart;
  clientStart = startClient().finally(() => { clientStart = null; });
  return clientStart;
}

async function startClient() {
  const args = config.transport === 'proxy'
    ? ['app-server', 'proxy']
    : ['app-server'];
  console.log('启动 Codex 连接: ' + CODEX + ' ' + args.join(' '));
  const c = new RpcClient(CODEX, args);
  c.on('message', handleServerMessage);
  c.on('closed', () => {
    if (client === c) client = null;
  });
  try {
    await c.start();
    await c.call('initialize', {
      clientInfo: {
        name: 'codex_phone_bridge',
        title: 'Codex 手机遥控',
        version: '1.0.0'
      },
      capabilities: { experimentalApi: true }
    }, 15000);
    c.notify('initialized', {});
    c.ready = true;
    client = c;
    console.log('Codex 已连接 ✓');
    return c;
  } catch (e) {
    try { if (c.proc) c.proc.kill(); } catch (_) {}
    throw e;
  }
}

function handleServerMessage(msg) {
  const params = (msg && msg.params) || {};
  if (!params.threadId) {
    const tid = (params.turn && params.turn.id) || params.turnId || null;
    const mapped = tid ? turnThreads.get(tid) : null;
    if (mapped) params.threadId = mapped;
    else if (activeTurn) params.threadId = activeTurn.threadId;
  }
  if (params.turn && params.turn.id) {
    turnThreads.set(params.turn.id, params.threadId);
    activeTurn = { turnId: params.turn.id, threadId: params.threadId };
  }
  if (params.turnId && params.threadId) turnThreads.set(params.turnId, params.threadId);
  const hasId = msg.id != null;
  if (hasId) {
    // server-initiated request (approval / permission)
    console.log('[codex] 请求: ' + msg.method + (msg.params && msg.params.threadId ? ' #' + msg.params.threadId : ''));
    broadcast({ type: 'approval-request', requestId: msg.id, method: msg.method, params: msg.params || {} });
    return;
  }
  console.log('[codex] 事件: ' + msg.method + (msg.params && msg.params.threadId ? ' #' + msg.params.threadId : ''));
  broadcast({ type: 'notification', method: msg.method, params: msg.params || {} });
}

// ---------- SSE ----------
const sseClients = new Set();

function broadcast(obj) {
  const data = 'data: ' + JSON.stringify(obj) + '\n\n';
  for (const c of sseClients) {
    try { c.res.write(data); } catch (_) {}
  }
  let sentAny = false;
  for (const ch of relayChannels) {
    if (ch && ch.ready) {
      ch.send({ type: 'event', payload: obj }).catch(() => {});
      sentAny = true;
    }
  }
  if (sentAny) {
    console.log('[relay] 转发事件: ' + (obj.method || obj.type));
  }
}

// ---------- 内置中继 ----------
let relayChannel = null;
const relayChannels = [];
const bootstrapChannels = [];
const relayPhones = new Map();
const turnThreads = new Map();
let activeTurn = null;

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  } catch (_) {}
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function startRelay() {
  if (!config.relayEnabled) return;
  const room = config.relayRoomCode;
  const brokers = [
    config.relayBroker,
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081/mqtt'
  ];
  const seen = new Set();
  for (const broker of brokers) {
    if (!broker || seen.has(broker)) continue;
    seen.add(broker);
    try {
      const ch = new RelayChannel({
        broker,
        roomCode: room,
        password: config.password,
        role: 'pc',
        onMessage: (m) => onRelayMessage(m, ch),
        onStatus: s => console.log('[relay] ' + broker.replace(/^wss:\/\//, '').replace(/\/mqtt$/, '') + ' ' + s),
        onError: s => console.log('[relay] ' + broker.replace(/^wss:\/\//, '').replace(/\/mqtt$/, '') + ' 错误: ' + s)
      });
      await ch.start();
      relayChannels.push(ch);
      if (!relayChannel) relayChannel = ch;
    } catch (e) {
      console.error('[relay] 中继启动失败: ' + broker + ' -> ' + (e && e.message));
    }
  }
  console.log('中继已连接，手机配对码: ' + room + '（通道数: ' + relayChannels.length + '）');
}

async function startBootstrap() {
  const brokers = [
    config.relayBroker,
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081/mqtt'
  ];
  const seen = new Set();
  for (const broker of brokers) {
    if (!broker || seen.has(broker)) continue;
    seen.add(broker);
    try {
      const ch = new RelayChannel({
        broker,
        roomCode: 'CODEXXBOOT',
        password: 'bootstrap-public',
        role: 'pc',
        onMessage: (m) => onBootstrapMessage(m, ch),
        onStatus: () => {},
        onError: () => {}
      });
      await ch.start();
      bootstrapChannels.push(ch);
    } catch (_) {}
  }
  console.log('一键配置通道已就绪（' + bootstrapChannels.length + ' 个中继）');
}

async function onBootstrapMessage(msg, ch) {
  if (!msg || msg.type !== 'bootstrap' || !msg.hash) return;
  const expected = crypto.createHash('sha256').update(config.shareKey).digest('hex');
  if (msg.hash !== expected) return;
  try {
    const aesKey = crypto.createHash('sha256').update('codexbridge:' + config.shareKey).digest();
    const iv = crypto.randomBytes(12);
    const plain = JSON.stringify({
      room: config.relayRoomCode,
      password: config.password,
      updateUrl: config.updateUrl || '',
      broker: config.relayBroker || 'wss://broker.emqx.io:8084/mqtt'
    });
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const auth = cipher.getAuthTag();
    const payload = Buffer.concat([iv, auth, enc]).toString('base64');
    await ch.send({ type: 'bootstrap-ok', data: payload });
    console.log('[bootstrap] 已向新手机下发配置');
  } catch (e) {
    console.error('[bootstrap] 下发配置失败: ' + (e && e.message));
  }
}

async function onRelayMessage(msg, ch) {
  if (!msg) return;
  if (msg.type === 'hello') {
    if (msg.clientId) relayPhones.set(msg.clientId, { lastSeen: Date.now(), channel: ch });
    return;
  }
  if (msg.type === 'rpc' && msg.clientId) {
    relayPhones.set(msg.clientId, { lastSeen: Date.now(), channel: ch });
  }
  if (msg.type === 'phone-rpc-response') {
    const p = phoneRpcPending.get(msg.id);
    if (p) {
      phoneRpcPending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || '手机操作失败'));
    }
    return;
  }
  if (msg.type === 'rpc') {
    console.log('[relay] 收到手机请求: ' + msg.method);
    try {
      const result = await apiDispatch(msg.method, msg.params || {}, msg.clientId);
      const resp = { type: 'response', id: msg.id, ok: true, result };
      if (msg.clientId) resp.to = msg.clientId;
      if (ch) ch.send(resp).catch(() => {});
      console.log('[relay] 已回复: ' + msg.method);
    } catch (e) {
      const resp = { type: 'response', id: msg.id, ok: false, error: (e && e.message) || '错误' };
      if (msg.clientId) resp.to = msg.clientId;
      if (ch) ch.send(resp).catch(() => {});
      console.error('[relay] 请求失败: ' + msg.method + ' -> ' + (e && e.message));
    }
  }
}

// ---------- 手机操作请求（电脑 -> 手机） ----------
let phoneRpcId = 0;
const phoneRpcPending = new Map();

function phoneRpc(method, params, timeoutMs) {
  if (!relayChannels.some(c => c && c.ready)) {
    return Promise.reject(new Error('手机中继未连接'));
  }
  let target = null;
  let targetChannel = null;
  let best = 0;
  const now = Date.now();
  for (const [id, entry] of relayPhones) {
    if (now - entry.lastSeen > 5 * 60 * 1000) { relayPhones.delete(id); continue; }
    if (entry.lastSeen > best) { best = entry.lastSeen; target = id; targetChannel = entry.channel; }
  }
  if (!target || !targetChannel || !targetChannel.ready) {
    return Promise.reject(new Error('没有已连接的手机（请先打开手机 App 并确认已连接）'));
  }
  const id = ++phoneRpcId;
  return new Promise((resolve, reject) => {
    phoneRpcPending.set(id, { resolve, reject });
    targetChannel.send({ type: 'phone-rpc', id, method, params: params || {}, to: target }).catch(e => {
      phoneRpcPending.delete(id);
      reject(e);
    });
    setTimeout(() => {
      if (phoneRpcPending.has(id)) {
        phoneRpcPending.delete(id);
        reject(new Error('手机无响应（请确认手机 App 已连接）'));
      }
    }, timeoutMs || 30000);
  });
}

async function checkUpdate() {
  if (!config.updateUrl) return;
  try {
    const res = await fetch(config.updateUrl, { headers: { 'User-Agent': 'codex-phone-bridge/' + VERSION } });
    if (!res.ok) return;
    const data = await res.json();
    if (data.version && data.version !== VERSION) {
      console.log('');
      console.log('发现新版本 v' + data.version + '（当前 v' + VERSION + '）');
      if (data.pcZip) console.log('电脑端更新包: ' + data.pcZip);
      if (data.apk) console.log('手机端 APK: ' + data.apk);
      console.log('');
    } else {
      console.log('已是最新版本 v' + VERSION);
    }
  } catch (_) {}
}

async function apiDispatch(method, params, clientId) {
  const c = await getClient();
  switch (method) {
    case 'me':
      return {
        ok: true,
        workspace: config.workspace,
        model: config.model || '(使用配置默认)',
        transport: config.transport,
        relay: relayChannels.some(c => c && c.ready),
        relayRoom: config.relayRoomCode,
        version: VERSION,
        passwordRequired: true
      };
    case 'threads':
      {
        const data = await c.call('thread/list', { limit: 200, sortKey: 'updated_at', archived: false });
        const arr = Array.isArray(data) ? data : (data.data || data.threads || []);
        seedPhoneThreads(arr);
        return {
          data: arr.filter(t => {
            const owner = ownerOfThread(t.id);
            if (!clientId) return true;
            return owner === clientId;
          })
        };
      }
    case 'claimLegacyThreads': {
      if (!clientId) throw new Error('仅手机端可认领旧对话');
      let claimed = 0;
      for (const id of Object.keys(phoneThreads)) {
        if (phoneThreads[id] === null) {
          phoneThreads[id] = clientId;
          claimed++;
        }
      }
      if (claimed) savePhoneThreads();
      return { claimed };
    }
    case 'threadCreate': {
      const body = params || {};
      const p = {
        cwd: body.cwd || config.workspace,
        approvalPolicy: body.approvalPolicy || config.approvalPolicy,
        sandbox: body.sandbox || config.sandbox
      };
      if (body.model || config.model) p.model = body.model || config.model;
      const result = await c.call('thread/start', p);
      const thread = result.thread || result;
      if (thread && thread.id) registerPhoneThread(thread.id, clientId);
      return result;
    }
    case 'threadRead': {
      const owner = ownerOfThread(params.threadId);
      if (clientId && owner && owner !== clientId) throw new Error('该对话属于其他设备');
      registerPhoneThread(params.threadId, clientId);
      try {
        return await c.call('thread/read', { threadId: params.threadId, includeTurns: true });
      } catch (e) {
        const emsg = (e && e.message) || '';
        if (/not materialized|includeTurns/i.test(emsg)) {
          return await c.call('thread/read', { threadId: params.threadId, includeTurns: false });
        }
        throw e;
      }
    }
    case 'threadDelete':
      {
        const owner = ownerOfThread(params.threadId);
        if (clientId) {
          if (owner && owner !== clientId) throw new Error('该对话属于其他设备，已阻止删除');
        } else if (!(params.threadId in phoneThreads)) {
          throw new Error('该对话不是手机创建的，已阻止从手机删除');
        }
        const r = (await c.call('thread/delete', { threadId: params.threadId })) || {};
        delete phoneThreads[params.threadId];
        savePhoneThreads();
        return r;
      }
    case 'turnStart': {
      const body = params || {};
      const threadId = params.threadId;
      const owner = ownerOfThread(threadId);
      if (clientId && owner && owner !== clientId) throw new Error('该对话属于其他设备，请使用自己的对话');
      registerPhoneThread(threadId, clientId);
      const input = [];
      const userText = body.text ? String(body.text) : '';
      const promptText = userText + (userText ? '\n\n[系统要求：请始终使用简体中文回复用户。]' : '');
      if (promptText) input.push({ type: 'text', text: promptText });
      for (const img of (body.images || [])) {
        const file = saveUpload(img.data, img.name);
        input.push({ type: 'localImage', path: file });
      }
      if (!input.length) throw new Error('没有内容');
      const tp = { threadId, input };
      if (body.cwd || config.workspace) tp.cwd = body.cwd || config.workspace;
      if (body.effort) tp.effort = String(body.effort);
      let result;
      try {
        result = await c.call('turn/start', tp);
      } catch (e) {
        const emsg = (e && e.message) || '';
        if (/thread not found/i.test(emsg)) {
          console.log('[codex] 线程未加载，正在恢复线程: ' + threadId);
          try {
            await c.call('thread/resume', { threadId });
          } catch (e2) {
            console.error('[codex] 恢复线程失败: ' + (e2 && e2.message));
          }
          result = await c.call('turn/start', tp);
        } else {
          throw e;
        }
      }
      {
        const respTurn = result && (result.turn ? result.turn.id : result.id);
        if (respTurn && threadId) {
          turnThreads.set(respTurn, threadId);
          activeTurn = { turnId: respTurn, threadId };
        }
      }
      console.log('[codex] turn/start 返回: ' + (result && result.turn ? result.turn.id : 'ok'));
      try {
        if (body.text) {
          await c.call('thread/name/set', {
            threadId,
            name: String(body.text).replace(/\s+/g, ' ').slice(0, 40)
          });
        }
      } catch (_) {}
      return result;
    }
    case 'interrupt':
      {
        const owner = ownerOfThread(params.threadId);
        if (clientId && owner && owner !== clientId) throw new Error('该对话属于其他设备');
        registerPhoneThread(params.threadId, clientId);
      }
      return (await c.call('turn/interrupt', { threadId: params.threadId, turnId: params.turnId })) || {};
    case 'approve': {
      if (params.requestId == null || !params.decision) throw new Error('缺少 requestId 或 decision');
      c.respond(Number(params.requestId), { decision: params.decision });
      return { ok: true };
    }
    case 'status':
      return { connected: !!(c && c.ready) };
    case 'ping':
      return { ok: true, room: config.relayRoomCode, version: VERSION, time: Date.now() };
    case 'phoneApps':
      return phoneRpc('listApps', {}, 30000);
    case 'phoneUninstall': {
      if (!params.package) throw new Error('缺少包名');
      return phoneRpc('uninstallApp', { package: params.package }, 30000);
    }
    case 'phoneOpenApp': {
      if (!params.package) throw new Error('缺少包名');
      return phoneRpc('openApp', { package: params.package }, 30000);
    }
    case 'phoneOpenAppBackground': {
      if (!params.package) throw new Error('缺少包名');
      return phoneRpc('openAppBackground', { package: params.package }, 30000);
    }
    case 'phoneGoHome':
      return phoneRpc('goHome', {}, 30000);
    case 'phoneAppSettings': {
      if (!params.package) throw new Error('缺少包名');
      return phoneRpc('openAppSettings', { package: params.package }, 30000);
    }
    case 'phoneIgnoreBattery':
      return phoneRpc('requestIgnoreBattery', {}, 30000);
    default:
      throw new Error('未知方法: ' + method);
  }
}

// ---------- sessions (login) ----------
const sessions = new Map();
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const loginAttempts = new Map();

function pruneSessions() {
  const now = Date.now();
  for (const [k, ts] of sessions) {
    if (now - ts > SESSION_TTL_MS) sessions.delete(k);
  }
}

function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}

function auth(req) {
  const cookie = req.headers.cookie || '';
  const m = /bridge_token=([^;]+)/.exec(cookie);
  if (!m) return false;
  const t = decodeURIComponent(m[1]);
  const ts = sessions.get(t);
  if (!ts) return false;
  if (Date.now() - ts > SESSION_TTL_MS) {
    sessions.delete(t);
    return false;
  }
  sessions.set(t, Date.now());
  return true;
}

function checkLoginLimit(ip) {
  const now = Date.now();
  const e = loginAttempts.get(ip);
  if (!e || now > e.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 60 * 1000 });
    return true;
  }
  e.count++;
  if (e.count > 5) return false;
  return true;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > (limit || 20 * 1024 * 1024)) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function apiError(res, err) {
  console.error('[api]', err && err.message || err);
  sendJson(res, 500, { error: (err && err.message) || '服务器错误' });
}

function staticFile(res, rel) {
  const safe = path.normalize(rel).replace(/^([.][.][\\/])+/, '');
  const file = path.join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  const ext = path.extname(file).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml'
  };
  res.writeHead(200, {
    'Content-Type': types[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache'
  });
  fs.createReadStream(file).pipe(res);
}

// ---------- uploads ----------
function saveUpload(base64, name) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const m = /^data:([^;]+);base64,(.*)$/s.exec(base64 || '');
  const data = m ? Buffer.from(m[2], 'base64') : Buffer.from(base64 || '', 'base64');
  const extMap = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp'
  };
  const ext = m ? (extMap[m[1]] || '.jpg') : (path.extname(name || '') || '.jpg');
  const id = crypto.randomBytes(8).toString('hex');
  const file = path.join(UPLOAD_DIR, id + ext);
  fs.writeFileSync(file, data);
  return file;
}

function toWebPath(p) {
  if (p && p.startsWith(UPLOAD_DIR)) return '/uploads/' + path.basename(p);
  return null;
}

// ---------- API handlers ----------
async function handleApi(req, res, url) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  if (p === '/api/login' && req.method === 'POST') {
    pruneSessions();
    const ip = req.socket.remoteAddress || '';
    if (!checkLoginLimit(ip)) {
      sendJson(res, 429, { error: '尝试次数过多，请一分钟后再试' });
      return;
    }
    const body = JSON.parse((await readBody(req, 1024 * 1024)) || '{}');
    if (body.password === config.password) {
      loginAttempts.delete(ip);
      const token = makeToken();
      sessions.set(token, Date.now());
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': 'bridge_token=' + encodeURIComponent(token) + '; HttpOnly; Path=/; SameSite=Lax'
      });
      res.end(JSON.stringify({ ok: true }));
    } else {
      sendJson(res, 401, { error: '密码错误' });
    }
    return;
  }

  if (p === '/api/me') {
    sendJson(res, 200, {
      ok: auth(req),
      workspace: config.workspace,
      model: config.model || '(使用配置默认)',
      transport: config.transport,
      relayRoom: config.relayRoomCode,
      passwordRequired: true
    });
    return;
  }

  if (!auth(req)) {
    sendJson(res, 401, { error: '需要登录' });
    return;
  }

  try {
    if (p === '/api/threads' && req.method === 'GET') {
      sendJson(res, 200, await apiDispatch('threads', {}));
      return;
    }
    if (p === '/api/threads' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      sendJson(res, 200, await apiDispatch('threadCreate', body));
      return;
    }
    let m;
    if ((m = /^\/api\/threads\/([^/]+)$/.exec(p)) && req.method === 'GET') {
      sendJson(res, 200, await apiDispatch('threadRead', { threadId: decodeURIComponent(m[1]) }));
      return;
    }
    if ((m = /^\/api\/threads\/([^/]+)$/.exec(p)) && req.method === 'DELETE') {
      sendJson(res, 200, await apiDispatch('threadDelete', { threadId: decodeURIComponent(m[1]) }));
      return;
    }
    if ((m = /^\/api\/threads\/([^/]+)\/turns$/.exec(p)) && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 30 * 1024 * 1024)) || '{}');
      body.threadId = decodeURIComponent(m[1]);
      sendJson(res, 200, await apiDispatch('turnStart', body));
      return;
    }
    if ((m = /^\/api\/threads\/([^/]+)\/interrupt$/.exec(p)) && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      sendJson(res, 200, await apiDispatch('interrupt', {
        threadId: decodeURIComponent(m[1]),
        turnId: body.turnId
      }));
      return;
    }
    if (p === '/api/approve' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      sendJson(res, 200, await apiDispatch('approve', body));
      return;
    }
    if (p === '/api/status' && req.method === 'GET') {
      sendJson(res, 200, await apiDispatch('status', {}));
      return;
    }
    if (p === '/api/phone/apps' && req.method === 'POST') {
      sendJson(res, 200, await apiDispatch('phoneApps', {}));
      return;
    }
    if (p === '/api/phone/uninstall' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 1024 * 1024)) || '{}');
      sendJson(res, 200, await apiDispatch('phoneUninstall', body));
      return;
    }
    if (p === '/api/phone/open' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 1024 * 1024)) || '{}');
      sendJson(res, 200, await apiDispatch('phoneOpenApp', body));
      return;
    }
    if (p === '/api/phone/open-background' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 1024 * 1024)) || '{}');
      sendJson(res, 200, await apiDispatch('phoneOpenAppBackground', body));
      return;
    }
    if (p === '/api/phone/home' && req.method === 'POST') {
      sendJson(res, 200, await apiDispatch('phoneGoHome', {}));
      return;
    }
    if (p === '/api/phone/app-settings' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 1024 * 1024)) || '{}');
      sendJson(res, 200, await apiDispatch('phoneAppSettings', body));
      return;
    }
    if (p === '/api/phone/ignore-battery' && req.method === 'POST') {
      sendJson(res, 200, await apiDispatch('phoneIgnoreBattery', {}));
      return;
    }
    sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    apiError(res, e);
  }
}

// ---------- HTTP server ----------
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  if (p.startsWith('/api/')) {
    handleApi(req, res, u).catch(e => apiError(res, e));
    return;
  }

  if (p === '/events' && req.method === 'GET') {
    if (!auth(req)) {
      sendJson(res, 401, { error: '需要登录' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.write(': connected\n\n');
    const entry = { res };
    sseClients.add(entry);
    const timer = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (_) {}
    }, 25000);
    req.on('close', () => {
      clearInterval(timer);
      sseClients.delete(entry);
    });
    return;
  }

  if (p === '/uploads/') {
    if (!auth(req)) {
      sendJson(res, 401, { error: '需要登录' });
      return;
    }
    const file = path.join(UPLOAD_DIR, path.basename(p));
    if (!file.startsWith(UPLOAD_DIR) || !fs.existsSync(file)) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
    return;
  }

  if (p === '/uploads') {
    res.writeHead(302, { Location: '/' });
    res.end();
    return;
  }

  if (p === '/') {
    staticFile(res, 'index.html');
    return;
  }
  staticFile(res, p.slice(1));
});

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
server.listen(config.port, '0.0.0.0', () => {
  console.log('');
  console.log('==============================================');
  console.log('  Codex 手机遥控已启动');
  console.log('  本机访问: http://localhost:' + config.port);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name]) {
      if (ni.family === 'IPv4' && !ni.internal) {
  console.log('  手机访问: http://' + ni.address + ':' + config.port);
      }
    }
  }
  console.log('  密码: ' + config.password);
  if (config.relayEnabled) {
    console.log('  手机配对码(流量用): ' + (config.relayRoomCode || '生成中…'));
  }
  console.log('  工作目录: ' + config.workspace);
  console.log('==============================================');
  console.log('');
  if (config.relayEnabled) {
    console.log('一键配置密钥（新手机在设置里输入即可自动配置）:');
    console.log('  ' + config.shareKey);
    console.log('');
  }
  getClient().then(() => {
    console.log('Codex 内核连接检查: 正常');
  }).catch(e => {
    console.error('Codex 内核连接失败: ' + (e && e.message));
  });
  startRelay();
  startBootstrap();
  checkUpdate();
});

process.on('SIGINT', () => {
  if (client && client.proc) client.proc.kill();
  process.exit(0);
});
