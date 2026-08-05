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
const TTS_DIR = path.join(UPLOAD_DIR, 'tts');
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
  const merged = Object.assign({
    port: 8787,
    password: '',
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
    shareKey: '',
    ttsUrl: 'http://127.0.0.1:8866',
    ttsEmotion: '平静日常',
    ttsSegmentChars: 150,
    ttsTimeoutMs: 90000
  }, cfg);
  if (!merged.workspace) merged.workspace = docs;
  if (!merged.codexHome) merged.codexHome = path.join(os.homedir(), '.codex');
  if (!merged.relayBroker) merged.relayBroker = 'wss://broker.emqx.io:8084/mqtt';
  return merged;
}

const config = loadConfig();
const VERSION = '8.8';
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
  bridgeId.shareKey = config.shareKey || crypto.randomBytes(32).toString('hex');
  saveBridgeId(bridgeId);
}
if (config.shareKey !== bridgeId.shareKey) {
  config.shareKey = bridgeId.shareKey;
  saveConfig();
}
if (!config.password) {
  config.password = generatePassword();
  saveConfig();
  console.log('[config] 已生成新的访问密码（新手机一键配置/手动填写用）');
}
if (!config.updateUrl) {
  config.updateUrl = 'https://raw.githubusercontent.com/oen1day/codex-phone-bridge/main/version.json';
  saveConfig();
}
if (config.relayEnabled) {
  const room = (config.relayRoomCode || '').trim().toUpperCase();
  if (!room) {
    config.relayRoomCode = generateRoomCode();
    saveConfig();
    console.log('[config] 已生成新的配对码: ' + config.relayRoomCode);
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
  // 回复完成 → 自动预生成朗读音频
  if (msg.method === 'item/completed') {
    const item = params.item || {};
    if (item.type === 'agentMessage' && item.id && item.text) {
      const tid = (params.turn && params.turn.id) || activeTurn.turnId;
      if (tid) {
        const acc = ((preGenTexts.get(tid) || '') + '\n' + String(item.text)).trim();
        preGenTexts.set(tid, acc);
        // 提前预生成第一段：回复还在输出时首段音频就开始合成
        const seg0 = splitTtsSegments(acc)[0];
        if (seg0) {
          const auto = turnAutoSpeak.get(tid) !== false;
          queuePreGen(seg0, auto);
        }
      }
    }
  } else if (msg.method === 'turn/started') {
    const tid = params.turn && params.turn.id;
    if (tid) preGenTexts.set(tid, '');
  } else if (msg.method === 'turn/completed') {
    const tid = (params.turn && params.turn.id) || activeTurn.turnId;
    if (tid) {
      const text = preGenTexts.get(tid) || '';
      preGenTexts.delete(tid);
      const auto = turnAutoSpeak.get(tid) !== false;
      turnAutoSpeak.delete(tid);
      if (text) queuePreGen(text, auto);
    }
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

function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 16; i++) s += chars[Math.floor(Math.random() * chars.length)];
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

// ---------- 离线语音朗读（IndexTTS-2 本机服务） ----------
let ttsChain = Promise.resolve();
const ttsInflight = new Map();

function ttsCacheKey(text) {
  return crypto.createHash('sha256').update((config.ttsEmotion || '平静日常') + '|' + String(text || '')).digest('hex');
}

function wavDataOffset(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return -1;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') return off + 8;
    off += 8 + size + (size % 2);
  }
  return -1;
}

function concatWavs(parts) {
  if (parts.length <= 1) return parts[0];
  const offsets = parts.map(wavDataOffset);
  if (offsets.some(o => o < 0)) return Buffer.concat(parts);
  const head = parts[0].subarray(0, offsets[0]);
  let pcmLen = 0;
  for (let i = 0; i < parts.length; i++) pcmLen += parts[i].length - offsets[i];
  const out = Buffer.alloc(head.length + pcmLen);
  head.copy(out, 0);
  let off = head.length;
  for (let i = 0; i < parts.length; i++) {
    parts[i].copy(out, off, offsets[i]);
    off += parts[i].length - offsets[i];
  }
  out.writeUInt32LE(pcmLen, offsets[0] - 4);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}

function splitTtsText(text, maxChars) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const limit = Math.max(20, Number(maxChars) || 150);
  const segs = [];
  let cur = '';
  for (const ch of clean) {
    cur += ch;
    if (cur.length >= limit) {
      segs.push(cur);
      cur = '';
    }
  }
  if (cur) segs.push(cur);
  return segs;
}

// 与手机端 public/app.js 完全一致的清洗逻辑（保证缓存 key 一致）
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

// 与手机端 public/app.js 完全一致的分段逻辑
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

async function ttsSynthesizeOne(seg) {
  const base = String(config.ttsUrl || 'http://127.0.0.1:8866').replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(config.ttsTimeoutMs) || 90000);
  try {
    const r = await fetch(base + '/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: seg,
        emotion: config.ttsEmotion || '平静日常',
        emo_alpha: 1.0,
        use_random: false
      }),
      signal: ctrl.signal
    });
    if (!r.ok) throw new Error('语音服务返回 ' + r.status);
    const data = await r.json();
    if (!data || !data.url) throw new Error('语音服务响应异常');
    const audioPath = String(data.url).replace(/^\/+/, '');
    const ar = await fetch(base + '/' + encodeURI(audioPath), { signal: ctrl.signal });
    if (!ar.ok) throw new Error('获取音频失败 ' + ar.status);
    const buf = Buffer.from(await ar.arrayBuffer());
    if (buf.length < 100) throw new Error('音频内容为空');
    return buf;
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('语音生成超时');
    if (e && /fetch failed|ECONNREFUSED|ENOTFOUND/i.test((e.message || '') + ((e.cause && e.cause.message) || ''))) {
      throw new Error('无法连接语音服务，请先在电脑上启动小云语音服务');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function findTtsPython() {
  if (config.ttsPythonPath && fs.existsSync(config.ttsPythonPath)) return config.ttsPythonPath;
  const cands = [
    path.join(ROOT, '..', 'work', 'index-tts', '.venv', 'Scripts', 'python.exe'),
    'E:\\Codex\\work\\index-tts\\.venv\\Scripts\\python.exe'
  ];
  return cands.find(p => fs.existsSync(p)) || '';
}

const TTS_PYTHON = findTtsPython();
const WAV2MP3 = path.join(ROOT, 'wav2mp3.py');

function wavToMp3(wavBuf) {
  return new Promise((resolve, reject) => {
    if (!TTS_PYTHON || !fs.existsSync(WAV2MP3)) {
      resolve(null);
      return;
    }
    const p = spawn(TTS_PYTHON, [WAV2MP3], { stdio: ['pipe', 'pipe', 'ignore'] });
    const out = [];
    p.stdout.on('data', d => out.push(d));
    p.on('error', () => resolve(null));
    p.on('close', (code) => {
      if (code === 0 && out.length) resolve(Buffer.concat(out));
      else resolve(null);
    });
    p.stdin.write(wavBuf);
    p.stdin.end();
  });
}

const ttsRealTimeJobs = new Map(); // jobId -> {ctrl, done}，用于新消息时统一取消实时合成

async function doTtsGenerate(clean, jobInfo) {
  fs.mkdirSync(TTS_DIR, { recursive: true });
  const key = ttsCacheKey(clean);
  const wavFile = path.join(TTS_DIR, key + '.wav');
  const mp3File = path.join(TTS_DIR, key + '.mp3');
  if (fs.existsSync(mp3File)) return { buf: fs.readFileSync(mp3File), mime: 'audio/mpeg' };
  let wav;
  if (fs.existsSync(wavFile)) {
    wav = fs.readFileSync(wavFile);
  } else {
    // 走流式接口（带 job_id，可被取消），收完帧拼成 WAV 缓存
    const frames = [];
    const r = readTtsStreamFrames(clean, jobInfo.jobId, (frame) => frames.push(frame), () => {});
    jobInfo.ctrl = r.ctrl;
    const watchdog = setTimeout(() => {
      try { r.ctrl.abort(); } catch (_) {}
    }, 8 * 60 * 1000);
    try {
      await r.task;
    } finally {
      clearTimeout(watchdog);
      jobInfo.done = true;
    }
    if (!frames.length) throw new Error('语音生成失败');
    wav = concatWavs(frames);
    fs.writeFileSync(wavFile, wav);
    pruneTtsCache();
  }
  if (TTS_PYTHON) {
    try {
      const mp3 = await wavToMp3(wav);
      if (mp3 && mp3.length > 100) {
        fs.writeFileSync(mp3File, mp3);
        return { buf: mp3, mime: 'audio/mpeg' };
      }
    } catch (_) {}
  }
  return { buf: wav, mime: 'audio/wav' };
}

function ttsGenerate(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return Promise.reject(new Error('没有可朗读的文字'));
  const key = ttsCacheKey(clean);
  if (ttsInflight.has(key)) return ttsInflight.get(key);
  const jobId = 'rt' + Date.now().toString(36) + '-' + (++ttsStreamSeq);
  const jobInfo = { jobId, ctrl: null, done: false };
  ttsRealTimeJobs.set(jobId, jobInfo);
  const run = ttsChain.then(() => doTtsGenerate(clean, jobInfo));
  ttsInflight.set(key, run);
  const cleanup = () => {
    if (ttsRealTimeJobs.get(jobId) === jobInfo) ttsRealTimeJobs.delete(jobId);
  };
  const settled = run.then(
    v => { ttsInflight.delete(key); cleanup(); return v; },
    e => { ttsInflight.delete(key); cleanup(); throw e; }
  );
  ttsChain = settled.catch(() => {});
  return settled;
}

function cancelRealTimeTts() {
  for (const [jobId, info] of ttsRealTimeJobs) {
    if (!info.done) {
      cancelTtsJob(jobId);
      if (info.ctrl) {
        try { info.ctrl.abort(); } catch (_) {}
      }
    }
  }
  ttsRealTimeJobs.clear();
}

function pruneTtsCache() {
  try {
    fs.mkdirSync(TTS_DIR, { recursive: true });
    const keys = new Map();
    for (const f of fs.readdirSync(TTS_DIR)) {
      if (!/\.(wav|mp3)$/i.test(f)) continue;
      const base = f.replace(/\.(wav|mp3)$/i, '');
      const t = fs.statSync(path.join(TTS_DIR, f)).mtimeMs;
      if (!keys.has(base) || keys.get(base) < t) keys.set(base, t);
    }
    const sorted = [...keys.entries()].sort((a, b) => b[1] - a[1]);
    for (const it of sorted.slice(200)) {
      for (const ext of ['.wav', '.mp3']) {
        try { fs.unlinkSync(path.join(TTS_DIR, it[0] + ext)); } catch (_) {}
      }
    }
  } catch (_) {}
}

// ---------- 语音流式转发（/tts/stream -> 手机） ----------
const ttsStreams = new Map();
let ttsStreamSeq = 0;

function broadcastTts(obj) {
  for (const ch of relayChannels) {
    if (ch && ch.ready) ch.send(obj).catch(() => {});
  }
}

function cancelTtsJob(jobId) {
  const base = String(config.ttsUrl || 'http://127.0.0.1:8866').replace(/\/+$/, '');
  fetch(base + '/tts/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id: jobId || '' })
  }).catch(() => {});
}

// ---------- 回复完成后的声音预生成 ----------
const preGenQueue = [];
const preGenTexts = new Map();   // turnId -> 累积的 AI 回复文本
const turnAutoSpeak = new Map(); // turnId -> 是否开启自动朗读
let preGenRunning = false;
let preGenCtrl = null;
let preGenJobId = '';
let ttsRealTimeBusy = false;

function ttsCacheReady(clean) {
  if (!clean) return false;
  const key = ttsCacheKey(clean);
  return fs.existsSync(path.join(TTS_DIR, key + '.wav')) || fs.existsSync(path.join(TTS_DIR, key + '.mp3'));
}

// 计算第一段之后剩余的文本（容忍首段拼接时去掉的空格/换行）
function restAfterFirst(clean, first) {
  let i = 0;
  let j = 0;
  while (i < first.length && j < clean.length) {
    if (first[i] === clean[j]) {
      i++;
      j++;
    } else if (/\s/.test(clean[j])) {
      j++;
    } else if (/\s/.test(first[i])) {
      i++;
    } else {
      j++;
    }
  }
  return clean.slice(j).trim();
}

function ttsStatusFor(text) {
  const clean = cleanTtsText(text || '');
  if (!clean) return { ready: false };
  const fullKey = ttsCacheKey(clean);
  const fullMp3 = path.join(TTS_DIR, fullKey + '.mp3');
  const fullWav = path.join(TTS_DIR, fullKey + '.wav');
  if (fs.existsSync(fullMp3)) {
    return { ready: true, partial: false, mime: 'audio/mpeg', audioB64: fs.readFileSync(fullMp3).toString('base64') };
  }
  if (fs.existsSync(fullWav)) {
    return { ready: true, partial: false, mime: 'audio/wav', audioB64: fs.readFileSync(fullWav).toString('base64') };
  }
  // 自动朗读关闭时可能只预生成了第一段
  const segs = splitTtsSegments(clean);
  if (segs.length > 1) {
    const firstKey = ttsCacheKey(segs[0]);
    const firstMp3 = path.join(TTS_DIR, firstKey + '.mp3');
    const firstWav = path.join(TTS_DIR, firstKey + '.wav');
    const firstFile = fs.existsSync(firstMp3) ? firstMp3 : (fs.existsSync(firstWav) ? firstWav : '');
    if (firstFile) {
      return {
        ready: true,
        partial: true,
        mime: firstFile.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav',
        audioB64: fs.readFileSync(firstFile).toString('base64'),
        restText: restAfterFirst(clean, segs[0])
      };
    }
  }
  return { ready: false };
}

function queuePreGen(text, autoSpeak) {
  const clean = cleanTtsText(text);
  if (!clean) return;
  let target = clean;
  if (autoSpeak === false) {
    // 自动朗读关闭：只预生成第一段，供手动点播秒播
    const segs = splitTtsSegments(clean);
    if (segs.length > 1) target = segs[0];
  }
  if (ttsCacheReady(target)) return;
  const key = ttsCacheKey(target);
  if (preGenQueue.some(j => j.key === key)) return;
  preGenQueue.push({ key, text: target, ts: Date.now() });
  if (preGenQueue.length > 5) preGenQueue.shift(); // 旧任务丢弃，防止堆积
  processPreGenQueue();
}

function processPreGenQueue() {
  if (preGenRunning || ttsRealTimeBusy) return;
  const job = preGenQueue.shift();
  if (!job) return;
  preGenRunning = true;
  const jobId = 'pre' + Date.now().toString(36) + '-' + (++ttsStreamSeq);
  preGenJobId = jobId;
  const frames = [];
  try {
    const r = readTtsStreamFrames(job.text, jobId, (frame) => frames.push(frame), () => {});
    preGenCtrl = r.ctrl;
    r.task.then(() => {
      if (frames.length) {
        const wav = concatWavs(frames);
        fs.mkdirSync(TTS_DIR, { recursive: true });
        fs.writeFileSync(path.join(TTS_DIR, job.key + '.wav'), wav);
        if (TTS_PYTHON) {
          wavToMp3(wav).then(mp3 => {
            if (mp3 && mp3.length > 100) {
              fs.writeFileSync(path.join(TTS_DIR, job.key + '.mp3'), mp3);
            }
          }).catch(() => {});
        }
        pruneTtsCache();
        console.log('[tts] 预生成完成: ' + job.key.slice(0, 8) + '（' + frames.length + ' 段）');
      }
    }).catch(() => {}).finally(() => {
      preGenRunning = false;
      preGenCtrl = null;
      preGenJobId = '';
      processPreGenQueue();
    });
  } catch (e) {
    preGenRunning = false;
    preGenCtrl = null;
    preGenJobId = '';
    processPreGenQueue();
  }
}

function cancelPreGen() {
  if (preGenRunning && preGenJobId) cancelTtsJob(preGenJobId);
  if (preGenCtrl) {
    try { preGenCtrl.abort(); } catch (_) {}
    preGenCtrl = null;
  }
  preGenQueue.length = 0; // 实时请求优先，清掉排队中的预生成
}

function readTtsStreamFrames(text, jobId, onFrame, onEnd) {
  const base = String(config.ttsUrl || 'http://127.0.0.1:8866').replace(/\/+$/, '');
  const ctrl = new AbortController();
  const task = (async () => {
    const res = await fetch(base + '/tts/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: String(text || ''),
        emotion: config.ttsEmotion || '平静日常',
        emo_alpha: 1.0,
        use_random: false,
        job_id: jobId || ''
      }),
      signal: ctrl.signal
    });
    if (!res.ok || !res.body) throw new Error('语音流服务返回 ' + res.status);
    const reader = res.body.getReader();
    let buf = Buffer.alloc(0);
    let n = 0;
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      buf = Buffer.concat([buf, Buffer.from(r.value)]);
      while (buf.length >= 4) {
        const len = buf.readUInt32LE(0);
        if (len === 0) throw new Error('语音流异常终止');
        if (buf.length < 4 + len) break;
        const frame = buf.subarray(4, 4 + len);
        buf = buf.subarray(4 + len);
        n++;
        onFrame(frame, n);
      }
    }
    if (n === 0) throw new Error('语音流没有内容');
    onEnd(n);
  })();
  return { ctrl, task };
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
        if (/includeTurns/i.test(emsg) && !/not materialized|thread not found/i.test(emsg)) {
          return await c.call('thread/read', { threadId: params.threadId, includeTurns: false });
        }
        if (/not materialized|thread not found/i.test(emsg)) {
          console.log('[codex] 线程未加载，正在恢复线程: ' + params.threadId);
          try {
            await c.call('thread/resume', { threadId: params.threadId });
          } catch (e2) {
            console.error('[codex] 恢复线程失败: ' + (e2 && e2.message));
          }
          try {
            return await c.call('thread/read', { threadId: params.threadId, includeTurns: true });
          } catch (e3) {
            const emsg3 = (e3 && e3.message) || '';
            if (/includeTurns/i.test(emsg3)) {
              return await c.call('thread/read', { threadId: params.threadId, includeTurns: false });
            }
            throw new Error('读取对话失败，请稍后重试（' + emsg3 + '）');
          }
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
      cancelPreGen(); // 新消息一到就取消旧语音预生成，清空队列
      cancelRealTimeTts(); // 同时取消在途的实时分段合成
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
          turnAutoSpeak.set(respTurn, body.autoSpeak !== false);
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
    case 'ttsGenerate': {
      cancelPreGen();
      ttsRealTimeBusy = true;
      try {
        const r = await ttsGenerate(params.text);
        return { ok: true, mime: r.mime, audioB64: r.buf.toString('base64') };
      } finally {
        ttsRealTimeBusy = false;
        processPreGenQueue();
      }
    }
    case 'ttsStreamStart': {
      cancelPreGen();
      ttsRealTimeBusy = true;
      const text = String(params.text || '').replace(/\s+/g, ' ').trim();
      if (!text) {
        ttsRealTimeBusy = false;
        processPreGenQueue();
        throw new Error('没有可朗读的文字');
      }
      const sid = 'ts' + Date.now().toString(36) + '-' + (++ttsStreamSeq);
      const entry = { timer: null, ctrl: null, done: false };
      ttsStreams.set(sid, entry);
      const finish = (ok, error) => {
        if (entry.done) return;
        entry.done = true;
        ttsRealTimeBusy = false;
        processPreGenQueue();
        if (entry.timer) clearTimeout(entry.timer);
        ttsStreams.delete(sid);
        broadcastTts({ type: 'tts-stream-end', id: sid, ok, error: error || '', to: clientId });
      };
      (async () => {
        try {
          const r = readTtsStreamFrames(text, sid, (frame, seq) => {
            broadcastTts({ type: 'tts-stream', id: sid, seq, b64: frame.toString('base64'), to: clientId });
          }, () => finish(true, ''));
          entry.ctrl = r.ctrl;
          entry.timer = setTimeout(() => {
            cancelTtsJob(sid);
            try { entry.ctrl && entry.ctrl.abort(); } catch (_) {}
            finish(false, '语音生成超时');
          }, 12 * 60 * 1000);
          await r.task;
        } catch (e) {
          finish(false, (e && e.message) || '语音流失败');
        }
      })();
      return { ok: true, id: sid };
    }
    case 'ttsStreamStop': {
      const entry = ttsStreams.get(params.id);
      if (entry) {
        entry.done = true;
        ttsRealTimeBusy = false;
        processPreGenQueue();
        if (entry.timer) clearTimeout(entry.timer);
        cancelTtsJob(params.id);
        try { entry.ctrl && entry.ctrl.abort(); } catch (_) {}
        ttsStreams.delete(params.id);
      }
      return { ok: true };
    }
    case 'ttsStatus': {
      return ttsStatusFor(params.text);
    }
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
    if (p === '/api/tts' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 1024 * 1024)) || '{}');
      const r = await ttsGenerate(body.text);
      sendJson(res, 200, { ok: true, mime: r.mime, audioB64: r.buf.toString('base64') });
      return;
    }
    if (p === '/api/tts/stream' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 1024 * 1024)) || '{}');
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-cache' });
      try {
        const lanJob = 'lan' + Date.now().toString(36) + '-' + (++ttsStreamSeq);
        const r = readTtsStreamFrames(
          body.text,
          lanJob,
          (frame) => { try { res.write(frame); } catch (_) {} },
          () => { try { res.end(); } catch (_) {} }
        );
        await r.task;
      } catch (e) {
        try { res.end(); } catch (_) {}
      }
      return;
    }
    if (p === '/api/tts/cancel' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 1024 * 1024)) || '{}');
      cancelTtsJob(body.job_id);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (p === '/api/tts/status' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 1024 * 1024)) || '{}');
      sendJson(res, 200, ttsStatusFor(body.text));
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
pruneTtsCache();
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
