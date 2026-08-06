'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = __dirname;
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch (_) {}
const PORT = cfg.port || 8787;
if (!cfg.password) {
  console.error('phone-bridge: config.json 未配置 password，请先运行 start.bat 自动生成配置');
  process.exit(1);
}
const PASSWORD = cfg.password;
let cookie = '';

function api(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Cookie': cookie
      }
    }, (res) => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        const setc = res.headers['set-cookie'];
        if (setc && setc.length) cookie = setc[0].split(';')[0];
        let json = null;
        try { json = JSON.parse(buf); } catch (_) {}
        if (res.statusCode >= 400) {
          return reject(new Error((json && json.error) || ('HTTP ' + res.statusCode)));
        }
        resolve(json);
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function ensureLogin() {
  if (cookie) return;
  await api('/api/login', { password: PASSWORD });
}

const TOOLS = [
  {
    name: 'get_capabilities',
    description: '查询手机支持的所有能力及其开关状态。每次需要操作手机前先调用本工具，确认能力是否可用；未开启的能力直接告诉用户去手机设置里开启，不要假装能执行。',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_device_status',
    description: '读取手机设备状态：型号、系统版本、电量百分比、是否充电、网络类型（Wi-Fi/4G/5G）、屏幕分辨率、剩余存储。用于回答“我手机怎么样”“还剩多少电”。需要在手机设置里开启“设备状态查询”能力，未开启时会返回明确提示。',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'generate_image',
    description: '在电脑端 ComfyUI 生成或编辑图片。workflow 取值：gptimage2（默认，OpenAI API，不吃本地电脑性能，可生成可编辑）、zimage（本地 ComfyUI z-image）、zimage_upscale（本地 z-image + 超分）。除非用户明确要求使用本地 z-image 生成，否则一律使用 gptimage2（不传 workflow 或传 gptimage2）。prompt 必填，中文描述即可。imagePath 可选：用户上传了图片且要用 gptimage2 编辑时传图片的本机路径或 /uploads/ 路径；不传 imagePath 时 gptimage2 自动走纯文生图模式。生成完成返回图片地址，请在回复中以 Markdown 图片语法展示成品图：![图片](返回的url)。需要在手机设置里开启“图像生成”能力。',
    inputSchema: {
      type: 'object',
      properties: {
        workflow: { type: 'string', enum: ['zimage', 'zimage_upscale', 'gptimage2'], description: '工作流' },
        prompt: { type: 'string', description: '生成/编辑要求（中文即可）' },
        imagePath: { type: 'string', description: '要编辑的图片路径（本机路径或 /uploads/ 路径），仅 gptimage2 编辑模式需要' },
        upscale: { type: 'boolean', description: '仅当 workflow=zimage 且为 true 时走本地超分版（等价 zimage_upscale）' },
        width: { type: 'integer', description: 'zimage 宽度（可选）' },
        height: { type: 'integer', description: 'zimage 高度（可选）' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'list_phone_apps',
    description: '列出手机（鳍点AI App）上已安装的常用应用，返回名称和包名。这是读取手机应用列表的推荐方式：手机通过无线中继连接，不需要 USB 数据线、不需要 adb、不需要 USB 调试。直接调用本工具即可；不要检查 USB 设备或运行 adb 命令。需要电脑端桥接窗口正在运行、手机 App 已连接中继。',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'uninstall_phone_app',
    description: '卸载手机上的某个应用。参数 package 是包名（如 com.tencent.mm）。这是卸载手机应用的推荐方式：通过无线中继触发手机系统卸载确认框，用户在手机上点确认即可，不需要 USB 调试或 adb。先调用 list_phone_apps 获取包名。不要尝试用 adb/pm uninstall。',
    inputSchema: {
      type: 'object',
      properties: {
        package: { type: 'string', description: '要卸载的应用包名' }
      },
      required: ['package']
    }
  },
  {
    name: 'open_phone_app',
    description: '在手机上打开某个应用（前台显示）。参数 package 是包名（如 com.tencent.mm）。先调用 list_phone_apps 获取包名。',
    inputSchema: {
      type: 'object',
      properties: {
        package: { type: 'string', description: '要打开的应用包名' }
      },
      required: ['package']
    }
  },
  {
    name: 'open_phone_app_background',
    description: '在手机上打开某个应用，但随后自动回到 鳍点AI界面，让目标应用在后台运行。参数 package 是包名。',
    inputSchema: {
      type: 'object',
      properties: {
        package: { type: 'string', description: '要在后台打开的应用包名' }
      },
      required: ['package']
    }
  },
  {
    name: 'go_phone_home',
    description: '让手机返回桌面（Home）。无需参数。',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'phone_app_settings',
    description: '打开手机某个应用的应用详情/设置页（可看到权限、存储等）。参数 package 是包名。',
    inputSchema: {
      type: 'object',
      properties: {
        package: { type: 'string', description: '应用包名' }
      },
      required: ['package']
    }
  },
  {
    name: 'request_phone_battery_exemption',
    description: '打开手机的电池优化设置页，让用户可以把 鳍点AI设为“无限制”，保证后台常驻不被系统杀掉。无需参数。',
    inputSchema: { type: 'object', properties: {} }
  }
];

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (_) { continue; }
    handle(msg).catch(err => {
      if (msg && msg.id != null) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: (err && err.message) || '内部错误' } });
      }
    });
  }
});

async function handle(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.method === 'initialize') {
    const proto = (msg.params && msg.params.protocolVersion) || '2025-03-26';
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: proto,
        capabilities: { tools: {} },
        serverInfo: { name: 'codex-phone-bridge', version: '10.13' }
      }
    });
    return;
  }
  if (msg.method === 'notifications/initialized' || msg.method === 'notifications/cancelled') return;
  if (msg.method === 'ping') {
    if (msg.id != null) send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
    return;
  }
  if (msg.method === 'tools/call') {
    const name = msg.params && msg.params.name;
    const args = (msg.params && msg.params.arguments) || {};
    try {
      await ensureLogin();
      let result;
      if (name === 'list_phone_apps') {
        result = await api('/api/phone/apps', {});
      } else if (name === 'uninstall_phone_app') {
        if (!args.package) throw new Error('缺少 package 参数');
        result = await api('/api/phone/uninstall', { package: args.package });
      } else if (name === 'open_phone_app') {
        if (!args.package) throw new Error('缺少 package 参数');
        result = await api('/api/phone/open', { package: args.package });
      } else if (name === 'open_phone_app_background') {
        if (!args.package) throw new Error('缺少 package 参数');
        result = await api('/api/phone/open-background', { package: args.package });
      } else if (name === 'go_phone_home') {
        result = await api('/api/phone/home', {});
      } else if (name === 'phone_app_settings') {
        if (!args.package) throw new Error('缺少 package 参数');
        result = await api('/api/phone/app-settings', { package: args.package });
      } else if (name === 'request_phone_battery_exemption') {
        result = await api('/api/phone/ignore-battery', {});
      } else if (name === 'get_capabilities') {
        result = await api('/api/phone/capabilities', {});
      } else if (name === 'get_device_status') {
        result = await api('/api/phone/device-status', {});
      } else if (name === 'generate_image') {
        if (!args.prompt) throw new Error('缺少 prompt 参数');
        let wf = args.workflow || 'gptimage2';
        if (wf === 'zimage' && args.upscale) wf = 'zimage_upscale';
        result = await api('/api/comfy/generate', {
          workflow: wf,
          prompt: args.prompt,
          imagePath: args.imagePath || '',
          width: args.width,
          height: args.height
        });
      } else {
        throw new Error('未知工具: ' + name);
      }
      if (result && typeof result === 'object' && result.ok === false && result.error) {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: result.error }], isError: false }
        });
        return;
      }
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false }
      });
    } catch (e) {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: '操作失败: ' + ((e && e.message) || e) }], isError: true }
      });
    }
    return;
  }
  if (msg.id != null) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: '未知方法: ' + msg.method } });
  }
}
