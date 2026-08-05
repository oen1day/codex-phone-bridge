// 发布前验证：刷新重建后朗读按钮按文本重新绑定（防止声音在播但按钮灰掉）
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

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name); }
}

const fnSet = extractFn('setSpeakBtn');
const fnEnsure = extractFn('ensureTtsBtn');
const fnRestore = extractFn('restoreSpeakBtnState');

const newBtn = makeBtn();
newBtn._speakKey = 'c1_new-id';
const speakButtons = new Map([['c1_new-id', newBtn]]);
const agentEl = {
  dataset: { msgId: 'new-id' },
  querySelectorAll: () => [{ classList: { add() {}, remove() {} }, textContent: '新回复内容' }]
};
const ctx = {
  console,
  speakButtons,
  document: { querySelectorAll: () => [newBtn] },
  state: { currentId: 'c1' },
  messagesEl: { querySelectorAll: () => [agentEl] },
  ttsActiveKey: 'c1_old-id',
  ttsActiveState: 'loading',
  ttsActiveText: '新回复内容',
  ttsKey: (a, b) => a + '_' + b,
  cleanTtsText,
  collectAgentText: (el) => el.querySelectorAll().map(b => (b.textContent || '').trim()).join('\n')
};
const ensureTtsBtn = evalFn('ensureTtsBtn', fnEnsure, ctx);
ctx.ensureTtsBtn = ensureTtsBtn;
const setSpeakBtn = evalFn('setSpeakBtn', fnSet, ctx);
ctx.setSpeakBtn = setSpeakBtn;

setSpeakBtn('c1_old-id', 'loading');
check('刷新后按文本重绑定到新id', ctx.ttsActiveKey === 'c1_new-id');
check('新按钮显示生成中', newBtn.textContent === '⏳ 生成中…');

ctx.ttsActiveKey = 'c1_old-id'; // 模拟 playTtsSegment 播放前重新认领
setSpeakBtn('c1_old-id', 'playing');
check('播放中状态应用到新按钮', newBtn.textContent === '⏹ 停止' && newBtn.classList.contains('speaking'));
check('状态记录正确', ctx.ttsActiveState === 'playing');

const restore = evalFn('restoreSpeakBtnState', fnRestore, ctx);
restore();
check('恢复函数保持播放中', newBtn.textContent === '⏹ 停止');

console.log('按钮重绑定验证: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
