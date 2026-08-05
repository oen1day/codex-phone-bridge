// 发布前验证（10.7）：局域网模式两个修复
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
check('WebViewClient 有 onReceivedError', java.includes('onReceivedError'));
check('错误弹窗标题', java.includes('无法连接到该地址'));
check('弹窗含三个检查点', java.includes('start.bat') && java.includes('localhost 指向的是手机自己') && java.includes('同一个 Wi-Fi'));
check('弹窗有重新修改设置', java.includes('showSettingsDialog()'));
check('弹窗有重试', java.includes('web.reload()'));
check('app.js 设置按钮逻辑保留', app.includes('AndroidBridge.openSettings'));

console.log('局域网模式验证: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
