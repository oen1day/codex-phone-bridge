// 发布前验证（10.3）：公开寄语 + 隐藏作者印记 + 许可证
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name); }
}

const app = read('public/app.js');
const css = read('public/style.css');
const java = read('android/src/com/local/codexbridge/MainActivity.java');
const server = read('server.js');
const readme = read('README.md');

const quote = '初，帝以一手机起家';
check('app.js 空状态含寄语', app.includes(quote));
check('app.js 有空状态渲染函数', app.includes('function renderEmptyHero()'));
check('app.js 空状态不挡点击', css.includes('pointer-events: none'));
check('style.css 有空状态样式', css.includes('.empty-hero'));
check('MainActivity 有关于入口', java.includes('关于本软件'));
check('MainActivity 有关于页', java.includes('private void showAboutDialog()'));
check('MainActivity 有隐藏彩蛋', java.includes('private void showHiddenDialog()'));
check('彩蛋长按 3 秒', java.includes('postDelayed(openHidden, 3000)'));
check('彩蛋单点不误触', java.includes('removeCallbacks(openHidden)'));
check('关于页有开源链接', java.includes('github.com/oen1day/codex-phone-bridge'));
check('README 有寄语', readme.includes(quote));
check('README 有版权行', readme.includes('保留所有权利'));
check('server.js 有源码暗记', server.includes('作者暗记：鳍点-2026-0805-A1'));
check('LICENSE 存在且禁止商用', fs.existsSync(path.join(root, 'LICENSE')) && read('LICENSE').includes('禁止将本软件'));

console.log('关于页与暗记验证: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
