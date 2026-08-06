// 发布前验证（10.2）：服务崩溃兜底 + 业务错误与服务器故障分离 + 手机端断连不卡死
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name); }
}

const server = read('server.js');
const app = read('public/app.js');
const mcp = read('phone-mcp.js');
const start = read('start.ps1');

check('server 挂 unhandledRejection', server.includes("process.on('unhandledRejection'"));
check('server 挂 uncaughtException', server.includes("process.on('uncaughtException'"));
check('server 有 BusinessError', server.includes('class BusinessError extends Error'));
check('phoneRpc 识别 business 标志', server.includes('msg.business ? new BusinessError'));
check('sendJson 防二次异常', server.includes('res.writableEnded || res.destroyed'));
check('HTTP 业务错误返回 200', server.includes('if (e instanceof BusinessError)') && server.includes('ok: false, error: e.message'));
check('app 断连连续失败计数', app.includes('relayFailStreak'));
check('app 断连提示电脑端未运行', app.includes('电脑端未运行，请检查电脑上的 start.bat 窗口'));
check('app 断连清理 running', app.includes('stopTurnPolling()') && app.includes('stopTurnWatchdog()'));
check('app 重连恢复回合', app.includes('function resumeTurnIfActive()'));
check('app 发送前检查连接', app.includes("!(relayChannel && relayChannel.ready)"));
check('app 业务错误带 business 标记', app.includes('business: !!(e && e.business)'));
check('MCP 透传业务错误', mcp.includes('result.ok === false && result.error'));
check('start.ps1 自动重启', start.includes('$restartLeft') && start.includes('服务异常退出'));
check('start.ps1 无全局 Stop', !start.includes("$ErrorActionPreference = 'Stop'"));
check('start.ps1 用 Start-Process 不接管道', start.includes('Start-Process') && start.includes('-RedirectStandardError'));
check('start.ps1 横幅显示双模式信息', start.includes('局域网模式（手机和电脑需连同一个 Wi-Fi）') && start.includes('中继模式（手机跨网络，走流量）') && start.includes('手机配对码(流量用)') && start.includes('一键配置密钥'));
check('config 保存改为单字段不覆盖', server.includes('function saveConfigField') && !server.includes('function saveConfig()'));
check('空线程无 rollout 按空对话返回', server.includes('no rollout|not materialized') && server.includes("status: { type: 'idle' }"));

console.log('崩溃兜底验证: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
