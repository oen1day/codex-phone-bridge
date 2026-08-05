// 发布前验证（9.9）：刷新重建后朗读按钮状态恢复路径
// 1) setSpeakBtn 从 DOM 按 _speakKey 找回按钮（注册表被刷新清空时）
// 2) restoreSpeakBtnState 刷新后强制回填当前会话状态
// 3) finishTts 用旧 key 收尾时，复位当前活跃会话的按钮（9.6 修复）
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function extractFn(name) {
  const marker = 'function ' + name + '(';
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('找不到 ' + name);
  const bodyStart = src.indexOf('{', start);
  let depth = 0, i = bodyStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

function evalFn(name, fn, ctx) {
  return new Function('ctx', 'with(ctx){ return (function(){ ' + fn + ' return ' + name + '; }); }')(ctx)();
}

function makeBtn() {
  const set = new Set();
  return {
    classList: {
      add(c) { set.add(c); },
      remove(c) { set.delete(c); },
      toggle(c) { if (set.has(c)) set.delete(c); else set.add(c); },
      contains(c) { return set.has(c); }
    },
    textContent: '',
    disabled: false,
    _speakKey: null
  };
}

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name); }
}

const fnSet = extractFn('setSpeakBtn');
const fnRestore = extractFn('restoreSpeakBtnState');
const fnFinish = extractFn('finishTts');

const btn = makeBtn();
btn._speakKey = 'c1_new-id';
const speakButtons = new Map(); // 模拟刷新后注册表被清空

const ctx = {
  console,
  speakButtons,
  document: { querySelectorAll: () => [btn] },
  state: { currentId: 'c1' },
  ttsActiveKey: 'c1_new-id',
  ttsActiveState: 'loading',
  ttsKey: (a, b) => a + '_' + b
};

const setSpeakBtn = evalFn('setSpeakBtn', fnSet, ctx);
ctx.setSpeakBtn = setSpeakBtn;
const restore = evalFn('restoreSpeakBtnState', fnRestore, ctx);
const finishTts = evalFn('finishTts', fnFinish, ctx);

setSpeakBtn('c1_new-id', 'loading');
check('注册表被清后按 _speakKey 从 DOM 找回', speakButtons.get('c1_new-id') === btn);
check('找回后按钮显示生成中', btn.textContent === '⏳ 生成中…');

ctx.ttsActiveState = 'playing';
restore();
check('刷新后回填保持播放中', btn.textContent === '⏹ 停止' && btn.classList.contains('speaking'));

ctx.ttsActiveKey = 'c1_new-id';
ctx.ttsActiveState = 'playing';
finishTts('c1_old-id');
check('结束复位当前活跃按钮（兼容旧 key）', btn.textContent === '🔊 朗读');
check('结束后会话键清空', ctx.ttsActiveKey === null && ctx.ttsActiveState === 'idle');

console.log('按钮状态恢复验证: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
