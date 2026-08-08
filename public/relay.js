(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.RelayChannel = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const CHUNK_SIZE = 30 * 1024;

  function b64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  function b64ToBytes(str) {
    const s = atob(str);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function randId() {
    const a = new Uint8Array(8);
    crypto.getRandomValues(a);
    let s = '';
    for (const b of a) s += b.toString(16).padStart(2, '0');
    return s;
  }

  async function toBytes(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
    if (data instanceof Uint8Array) return data;
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) return new Uint8Array(data);
    if (typeof data === 'string') return encoder.encode(data);
    throw new Error('无法识别的消息数据');
  }

  // ---------- MQTT 3.1.1 ----------
  function encodeRemaining(len) {
    const out = [];
    do {
      let b = len % 128;
      len = Math.floor(len / 128);
      if (len > 0) b |= 128;
      out.push(b);
    } while (len > 0);
    return out;
  }

  function encodeString(str) {
    const b = encoder.encode(str);
    const out = new Uint8Array(2 + b.length);
    out[0] = (b.length >> 8) & 0xff;
    out[1] = b.length & 0xff;
    out.set(b, 2);
    return out;
  }

  function wrap(type, flags, body) {
    const head = [(type << 4) | flags].concat(encodeRemaining(body.length));
    const out = new Uint8Array(head.length + body.length);
    out.set(head, 0);
    out.set(body, head.length);
    return out;
  }

  function buildConnect(clientId) {
    const proto = encodeString('MQTT');
    const vh = [4, 0x02, 0, 60];
    const payload = encodeString(clientId);
    const body = new Uint8Array(proto.length + vh.length + payload.length);
    body.set(proto, 0);
    body.set(vh, proto.length);
    body.set(payload, proto.length + vh.length);
    return wrap(1, 0, body);
  }

  function buildSubscribe(topic, id) {
    const t = encodeString(topic);
    const body = new Uint8Array(2 + t.length + 1);
    body[0] = (id >> 8) & 0xff;
    body[1] = id & 0xff;
    body.set(t, 2);
    body[2 + t.length] = 0;
    return wrap(8, 2, body);
  }

  function buildPublish(topic, payload, packetId) {
    const t = encodeString(topic);
    const body = new Uint8Array(t.length + (packetId ? 2 : 0) + payload.length);
    body.set(t, 0);
    let off = t.length;
    if (packetId) {
      body[off] = (packetId >> 8) & 0xff;
      body[off + 1] = packetId & 0xff;
      off += 2;
    }
    body.set(payload, off);
    return wrap(3, packetId ? 2 : 0, body);
  }

  function parsePackets(buf) {
    const packets = [];
    let off = 0;
    while (off < buf.length) {
      const b0 = buf[off];
      let len = 0;
      let mult = 1;
      let pos = off + 1;
      let remLen = -1;
      while (pos < buf.length) {
        const b = buf[pos];
        len += (b & 127) * mult;
        mult *= 128;
        pos++;
        if ((b & 128) === 0) { remLen = len; break; }
      }
      if (remLen < 0) break;
      if (pos + remLen > buf.length) break;
      const body = buf.slice(pos, pos + remLen);
      packets.push(parsePacket(b0 >> 4, body, b0 & 0x0f));
      off = pos + remLen;
    }
    return { packets, rest: buf.slice(off) };
  }

  function parsePacket(type, body, flags) {
    if (type === 2) return { type: 'connack', code: body[1] };
    if (type === 4) return { type: 'puback', packetId: (body[0] << 8) | body[1] };
    if (type === 9) return { type: 'suback', packetId: (body[0] << 8) | body[1] };
    if (type === 13) return { type: 'pingresp' };
    if (type === 3) {
      const tlen = (body[0] << 8) | body[1];
      const topic = decoder.decode(body.slice(2, 2 + tlen));
      let off = 2 + tlen;
      let packetId = 0;
      const qos = (flags >> 1) & 3;
      if (qos > 0) {
        packetId = (body[off] << 8) | body[off + 1];
        off += 2;
      }
      return { type: 'publish', topic, qos, packetId, payload: body.slice(off) };
    }
    return { type: 'unknown' };
  }

  // ---------- 加密 ----------
  async function deriveKey(password) {
    const data = encoder.encode('codexbridge-v1:' + password);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  async function encryptJson(key, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = encoder.encode(JSON.stringify(obj));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
    return { iv: b64(iv), data: b64(new Uint8Array(ct)) };
  }

  async function decryptJson(key, env) {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(env.iv) },
      key,
      b64ToBytes(env.data)
    );
    return JSON.parse(decoder.decode(plain));
  }

  // ---------- 中继通道 ----------
  class RelayChannel {
    constructor(opts) {
      this.broker = opts.broker || 'wss://broker.emqx.io:8084/mqtt';
      this.roomCode = (opts.roomCode || '').trim().toUpperCase();
      this.password = opts.password || '';
      this.role = opts.role || 'phone';
      this.onMessage = opts.onMessage || function () {};
      this.onStatus = opts.onStatus || function () {};
      this.onError = opts.onError || null;
      this.onChunkError = opts.onChunkError || null;
      this.base = 'codexbridge/v1/' + this.roomCode;
      this.inTopic = this.role === 'pc' ? this.base + '/up' : this.base + '/down';
      this.outTopic = this.role === 'pc' ? this.base + '/down' : this.base + '/up';
      this.ws = null;
      this.buf = new Uint8Array(0);
      this.key = null;
      this.ready = false;
      this.clientId = opts.clientId || ('cb_' + randId());
      this.chunks = {};
      this._sentChunks = {}; // 已发送的大消息分片缓存，供接收端补拉（QoS 0 可能丢片）
      this._pktId = 1;
      this._unacked = {}; // QoS1 未确认 publish，超时自动重发
      this._resendCount = 0; // 分片补拉次数（诊断日志）
      this._chunkTimeoutCount = 0; // 分片重组超时次数（诊断日志）
      this.closed = false;
      this._retryTimer = null;
      this.pingTimer = null;
    }

    async start() {
      this.key = await deriveKey(this.password);
      await this._connect();
    }

    _connect() {
      return new Promise((resolve, reject) => {
        if (this.closed) {
          reject(new Error('closed'));
          return;
        }
        let settled = false;
        let ws;
        try {
          ws = new WebSocket(this.broker, 'mqtt');
        } catch (e) {
          reject(e);
          return;
        }
        const fail = (err) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        };
        this.ws = ws;
        const onOpen = () => {
          ws.binaryType = 'arraybuffer';
          ws.send(buildConnect(this.clientId));
        };
        const onMessage = async (ev) => {
          try {
            const bytes = await toBytes(ev.data);
            this._feed(bytes);
          } catch (_) {}
        };
        const onClose = () => {
          this.ready = false;
          this._clearUnacked();
          fail(new Error('中继连接被关闭'));
          if (!this.closed) {
            this.onStatus('连接断开，重连中…');
            this._retryTimer = setTimeout(() => {
              if (!this.closed) this._connect().catch(() => {});
            }, 3000);
          }
        };
        ws.addEventListener('open', onOpen);
        ws.addEventListener('message', onMessage);
        ws.addEventListener('close', onClose);
        ws.addEventListener('error', () => fail(new Error('无法连接中继服务器')));

        this._waitConnack = (packet) => {
          if (packet.type !== 'connack') return false;
          if (packet.code === 0) {
            settled = true;
            this._subscribe();
            return true;
          }
          settled = true;
          this.onStatus('中继服务器拒绝连接');
          reject(new Error('MQTT CONNACK code=' + packet.code));
          return true;
        };

        // 等待 CONNACK
        const origFeed = this._feed.bind(this);
        this._feed = (bytes) => {
          const parsed = parsePackets(bytes);
          for (const p of parsed.packets) {
            if (this._waitConnack && this._waitConnack(p)) {
              this._waitConnack = null;
              this._feed = origFeed;
              this._handlePackets(parsed.packets);
              resolve();
              return;
            }
            this._handlePacket(p);
          }
        };
        this._connectResolve = resolve;
      });
    }

    _subscribe() {
      this.ws.send(buildSubscribe(this.inTopic, 1));
      this.ready = true;
      this.onStatus('connected');
      this.send({ type: 'hello', role: this.role, clientId: this.clientId }).catch(() => {});
      this._startPing();
    }

    _startPing() {
      if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
        try { if (this.ws && this.ws.readyState === 1) this.ws.send(new Uint8Array([0xc0, 0])); } catch (_) {}
      }, 20000);
    }

    _feed(bytes) {
      const merged = new Uint8Array(this.buf.length + bytes.length);
      merged.set(this.buf, 0);
      merged.set(bytes, this.buf.length);
      const parsed = parsePackets(merged);
      this.buf = parsed.rest;
      for (const p of parsed.packets) this._handlePacket(p);
    }

    _handlePackets(packets) {
      for (const p of packets) this._handlePacket(p);
    }

    _handlePacket(packet) {
      if (packet.type === 'puback') {
        this._handlePuback(packet.packetId);
        return;
      }
      if (packet.type === 'publish') {
        if (packet.qos === 1 && packet.packetId) this._sendPuback(packet.packetId);
        this._onPublish(packet.payload);
      }
    }

    async _onPublish(payload) {
      let text;
      try {
        text = decoder.decode(payload);
        const env = JSON.parse(text);
        if (env.c !== undefined) {
          this._addChunk(env);
          return;
        }
        const obj = await decryptJson(this.key, env);
        if (obj && obj.type === 'relay-resend') {
          this._handleResend(obj);
          return;
        }
        this.onMessage(obj);
      } catch (e) {
        this._reportError((e && e.message) || '消息解密失败');
      }
    }

    _reportError(s) {
      const now = Date.now();
      if (this._lastErrAt && now - this._lastErrAt < 3000) return;
      this._lastErrAt = now;
      if (this.onError) {
        try { this.onError(s); } catch (_) {}
      }
    }

    _addChunk(env) {
      const entry = this.chunks[env.c] || { total: env.t, parts: [], count: 0 };
      if (!entry.timer) {
        // 分片重组超时按片数自适应：每 20 片加 10 秒，上限 120 秒（大片数在公共 MQTT 上需要更久收齐）
        entry.timer = setTimeout(() => {
          if (this.chunks[env.c] === entry) delete this.chunks[env.c];
          this._chunkTimeoutCount++;
          console.log('[relay] 分片重组超时 id=' + env.c + ' 累计=' + this._chunkTimeoutCount);
          if (this.onChunkError) {
            try { this.onChunkError('中继消息分片不完整，已丢弃'); } catch (_) {}
          }
        }, Math.min(120000, 10000 + Math.ceil(entry.total / 20) * 10000));
        entry.firstAt = Date.now();
        entry.lastReq = 0;
      }
      if (entry.parts[env.i] == null) {
        entry.parts[env.i] = b64ToBytes(env.b);
        entry.count++;
      }
      this.chunks[env.c] = entry;
      if (entry.count >= entry.total) {
        delete this.chunks[env.c];
        if (entry.timer) clearTimeout(entry.timer);
        let len = 0;
        for (const p of entry.parts) len += p.length;
        const full = new Uint8Array(len);
        let off = 0;
        for (const p of entry.parts) { full.set(p, off); off += p.length; }
        const text = decoder.decode(full);
        try {
          const env2 = JSON.parse(text);
          decryptJson(this.key, env2).then(obj => this.onMessage(obj)).catch(() => {});
        } catch (_) {}
      } else {
        this._maybeResend(entry, env.c);
      }
    }

    // QoS 0 丢片补拉：接收端发现缺片时，请求发送端重发缺失片（限频 3 秒一次）
    _maybeResend(entry, id) {
      const now = Date.now();
      if (now - entry.firstAt < 3000) return; // 先等自然到达
      if (now - entry.lastReq < 3000) return;
      entry.lastReq = now;
      const missing = [];
      for (let i = 0; i < entry.total; i++) {
        if (!entry.parts[i]) missing.push(i);
      }
      if (!missing.length) return;
      this._resendCount++;
      console.log('[relay] 分片补拉 missing=' + missing.length + ' 累计=' + this._resendCount);
      this.send({ type: 'relay-resend', id, missing }).catch(() => {});
    }

    // 收到补拉请求：重发缺失分片
    _handleResend(req) {
      const rec = this._sentChunks[req && req.id];
      if (!rec || !rec.parts) return;
      const missing = Array.isArray(req.missing) ? req.missing : [];
      for (const i of missing) {
        const part = rec.parts[i];
        if (!part) continue;
        const chunk = JSON.stringify({ c: req.id, t: rec.parts.length, i, b: b64(part) });
        this._publish(this.outTopic, encoder.encode(chunk));
      }
    }

    // QoS1 发布：带 packet id，未收到 PUBACK 每 3 秒重发，最多 6 次后放弃
    _publish(topic, payload) {
      if (!this.ws || this.ws.readyState !== 1) return;
      this._pktId = this._pktId >= 0xffff ? 1 : this._pktId + 1;
      const id = this._pktId;
      const rec = { topic, payload, id, attempts: 0, timer: null };
      this._unacked[id] = rec;
      this.ws.send(buildPublish(topic, payload, id));
      rec.timer = setTimeout(() => this._retryPublish(rec), 3000);
    }

    _retryPublish(rec) {
      if (!this._unacked[rec.id]) return;
      if (rec.attempts >= 6) {
        delete this._unacked[rec.id];
        console.log('[relay] publish 未确认已放弃 id=' + rec.id);
        return;
      }
      rec.attempts++;
      try { this.ws.send(buildPublish(rec.topic, rec.payload, rec.id)); } catch (_) {}
      rec.timer = setTimeout(() => this._retryPublish(rec), 3000);
    }

    _handlePuback(id) {
      const rec = this._unacked[id];
      if (!rec) return;
      if (rec.timer) clearTimeout(rec.timer);
      delete this._unacked[id];
    }

    _sendPuback(id) {
      try {
        this.ws.send(wrap(4, 0, new Uint8Array([(id >> 8) & 0xff, id & 0xff])));
      } catch (_) {}
    }

    _clearUnacked() {
      for (const c of Object.keys(this._unacked)) {
        const rec = this._unacked[c];
        if (rec && rec.timer) clearTimeout(rec.timer);
      }
      this._unacked = {};
    }

    async send(obj) {
      if (!this.ready || !this.ws || this.ws.readyState !== 1) {
        throw new Error('中继未连接');
      }
      const env = await encryptJson(this.key, obj);
      const bytes = encoder.encode(JSON.stringify(env));
      if (bytes.length <= CHUNK_SIZE) {
        this._publish(this.outTopic, bytes);
        return;
      }
      const id = randId();
      const total = Math.ceil(bytes.length / CHUNK_SIZE);
      const parts = [];
      for (let i = 0; i < total; i++) {
        const part = bytes.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        parts.push(part);
        const chunk = JSON.stringify({ c: id, t: total, i, b: b64(part) });
        this._publish(this.outTopic, encoder.encode(chunk));
      }
      // 保留已发分片 120 秒，供接收端补拉
      const rec = { parts, timer: null };
      this._sentChunks[id] = rec;
      rec.timer = setTimeout(() => {
        if (this._sentChunks[id] === rec) delete this._sentChunks[id];
      }, 120000);
    }

    stop() {
      this.closed = true;
      for (const c of Object.keys(this.chunks)) {
        const entry = this.chunks[c];
        if (entry && entry.timer) clearTimeout(entry.timer);
      }
      this.chunks = {};
      for (const c of Object.keys(this._sentChunks)) {
        const rec = this._sentChunks[c];
        if (rec && rec.timer) clearTimeout(rec.timer);
      }
      this._sentChunks = {};
      this._clearUnacked();
      if (this._retryTimer) {
        clearTimeout(this._retryTimer);
        this._retryTimer = null;
      }
      if (this.pingTimer) clearInterval(this.pingTimer);
      try { if (this.ws) this.ws.close(); } catch (_) {}
    }
  }

  return RelayChannel;
});
