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
const readmeEn = fs.existsSync(path.join(root, 'README.en.md')) ? read('README.en.md') : '';

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
check('彩蛋署名 add', java.includes('作者署名：add'));
check('关于页有开源链接', java.includes('github.com/oen1day/codex-phone-bridge'));
check('README 有寄语', readme.includes(quote));
check('README 版权行 add', readme.includes('© 2026 add'));
check('README 有 GPL 说明', readme.includes('GPL-3.0'));
check('README 有贡献章节', readme.includes('## 贡献'));
check('README 有版权许可章节', readme.includes('## 版权与许可') && readme.includes('同样以 GPL-3.0 开源'));
check('README 有致谢章节', readme.includes('## 致谢'));
check('README 有英文版链接', readme.includes('[English](README.en.md)'));
check('README 有翻译招募', readme.includes('欢迎提交翻译、贡献其他语言'));
check('README.en.md 存在且完整', readmeEn.includes('# 鳍点AI') && readmeEn.includes('## Contributing') &&
  readmeEn.includes('## Copyright and License') && readmeEn.includes('GPL-3.0'));
check('README.en.md 有截图引用', readmeEn.includes('docs/screenshots/01-chat.jpg') && readmeEn.includes('docs/screenshots/03-settings.jpg'));
check('server.js 有源码暗记', server.includes('作者暗记：add-2026-0805-A1'));
const license = fs.existsSync(path.join(root, 'LICENSE')) ? read('LICENSE') : '';
check('LICENSE 是 GPL-3.0', license.includes('GNU GENERAL PUBLIC LICENSE') && license.includes('Version 3'));
check('LICENSE 版权行 add', license.includes('Copyright (C) 2026 add'));
const noPlaceholder = !readme.includes('待补充') && !java.includes('待作者提供') && !license.includes('署名待补充');
check('无占位符残留', noPlaceholder);

console.log('关于页与暗记验证: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
