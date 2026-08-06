// 发布前验证（10.1）：新增能力链路四层齐全（MCP 工具 -> 服务端 -> 手机端 -> Android 桥）
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name); }
}

const mcp = read('phone-mcp.js');
const server = read('server.js');
const app = read('public/app.js');
const java = read('android/src/com/local/codexbridge/MainActivity.java');
const mani = read('android/AndroidManifest.xml');
const vj = read('version.json');

check('MCP 有 get_capabilities 工具', mcp.includes("name: 'get_capabilities'"));
check('MCP 有 get_device_status 工具', mcp.includes("name: 'get_device_status'"));
check('MCP 路由到 capabilities', mcp.includes("'/api/phone/capabilities'"));
check('MCP 路由到 device-status', mcp.includes("'/api/phone/device-status'"));
check('server apiDispatch 有 phoneCapabilities', server.includes("case 'phoneCapabilities':"));
check('server apiDispatch 有 phoneDeviceStatus', server.includes("case 'phoneDeviceStatus':"));
check('server HTTP 有 /api/phone/capabilities', server.includes("'/api/phone/capabilities'"));
check('server HTTP 有 /api/phone/device-status', server.includes("'/api/phone/device-status'"));
check('app.js 分发 getCapabilities', app.includes("msg.method === 'getCapabilities'"));
check('app.js 分发 getDeviceStatus', app.includes("msg.method === 'getDeviceStatus'"));
check('app.js 未开启时抛出明确错误', app.includes('设备状态查询未开启'));
check('Java 有能力开关常量', java.includes('KEY_CAP_DEVICE_STATUS'));
check('Java 有 getCapabilities', java.includes('public String getCapabilities()'));
check('Java 有 getDeviceStatus', java.includes('public String getDeviceStatus()'));
check('Java 默认关闭', java.includes('p.getBoolean(KEY_CAP_DEVICE_STATUS, false)'));
check('Manifest 有网络状态权限', mani.includes('android.permission.ACCESS_NETWORK_STATE'));
check('版本六处 10.10', mcp.includes("version: '10.10'") && server.includes("const VERSION = '10.10'") &&
  app.includes("const APP_VERSION = '10.10'") && java.includes('"10.10"') &&
  mani.includes('versionName="10.10"') && JSON.parse(vj).version === '10.10');
check('versionCode 90', mani.includes('android:versionCode="90"'));

console.log('能力链路验证: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
