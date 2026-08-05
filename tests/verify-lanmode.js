// 发布前验证（10.8）：局域网“填错地址”体验重设计
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name); }
}

const java = read('android/src/com/local/codexbridge/MainActivity.java');
const app = read('public/app.js');

check('原生桥无条件下注入', java.includes('web.addJavascriptInterface(new JsBridge(), "AndroidBridge");'));
check('桥注入不再限定中继模式', !java.includes('if ("relay".equals(mode)) {\n            web.addJavascriptInterface'));
check('保存时拦截 localhost', java.includes('lowerUrl.startsWith("localhost")'));
check('保存时拦截 127.0.0.1', java.includes('lowerUrl.startsWith("127.0.0.1")'));
check('防呆提示文案', java.includes('请填电脑的局域网 IP，例如 http://192.168.1.100:8787'));
check('保存前 TCP 预检', java.includes('new Socket()') && java.includes('InetSocketAddress'));
check('预检 4 秒超时', java.includes('4000'));
check('检测中禁用保存按钮', java.includes('save.setEnabled(false)') && java.includes('正在检测地址…'));
check('服务未启动提示', java.includes('电脑端桥接服务未启动，请先运行 start.bat'));
check('地址不可达提示', java.includes('地址不可达，请检查 IP 是否正确'));
check('域名无法解析提示', java.includes('域名无法解析，请检查地址拼写'));
check('失败留在设置页（内联红字）', java.includes('lanError.setVisibility(View.VISIBLE)'));
check('WebView 有 onReceivedError 兜底', java.includes('onReceivedError'));
check('错误覆盖层标题', java.includes('无法加载该页面'));
check('覆盖层含三个检查点', java.includes('start.bat') && java.includes('localhost 指向的是手机自己') && java.includes('同一个 Wi-Fi'));
check('覆盖层返回设置按钮', java.includes('返回设置') && java.includes('showSettingsDialog()'));
check('覆盖层重试按钮', java.includes('web.reload()'));
check('8 秒加载超时兜底', java.includes('postDelayed(lanLoadTimeout, 8000)'));
check('返回键兜底回设置', java.includes('public void onBackPressed()'));
check('空地址不加载直接进设置', java.includes('lanUrl.isEmpty()') && java.includes('showSettingsDialog()'));
check('app.js 设置按钮逻辑保留', app.includes('AndroidBridge.openSettings'));

console.log('局域网模式验证: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
