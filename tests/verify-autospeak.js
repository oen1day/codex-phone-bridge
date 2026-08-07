// 发布前验证：自动朗读触发守卫（从 app.js 抽取真实函数体运行）
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const marker = 'function maybeAutoSpeak(';
const start = src.indexOf(marker);
if (start < 0) { console.error('找不到 maybeAutoSpeak'); process.exit(1); }
const bodyStart = src.indexOf('{', start);
let depth = 0, i = bodyStart;
for (; i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) break; }
}
const fn = src.slice(start, i + 1);

function makeAgent(msgId, text) {
  return {
    dataset: { msgId },
    querySelectorAll: () => [{ classList: { add() {}, remove() {} }, textContent: text }]
  };
}

function run(agent, override) {
  const ctx = {
    console,
    state: { currentId: 'c1' },
    autoSpeak: true,
    turnStartLastMsgId: 'old-id',
    ttsActiveKey: null,
    ttsActiveState: 'idle',
    autoSpokenMsgKey: null,
    liveGenRunning: 0,
    metaObj: {},
    getTtsMeta: () => ctx.metaObj,
    ttsKey: (a, b) => a + '_' + b,
    collectAgentText: (el) => el.querySelectorAll().map(b => (b.textContent || '').trim()).join('\n'),
    speakMessage: (c, m, t, a) => { ctx.spoken = { m, t, a }; },
    messagesEl: { querySelectorAll: () => [agent] }
  };
  if (override) Object.assign(ctx, override);
  const f = new Function('ctx', 'with(ctx){ return (function(){ ' + fn + ' return maybeAutoSpeak; }); }')(ctx)();
  return { r: f(), spoken: ctx.spoken, ctx };
}

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name); }
}

let x = run(makeAgent('new-id', '新回复内容'));
check('开关开+新真实id → 触发并调用朗读', x.r === true && x.spoken && x.spoken.m === 'new-id');

x = run(makeAgent('live-T1-1', '新回复内容'));
check('流式临时id → 等刷新不触发', x.r === false && !x.spoken);

x = run(makeAgent('new-id', '新回复内容'), { autoSpeak: false });
check('开关关 → 跳过且不生成', x.r === false && !x.spoken);

x = run(makeAgent('old-id', '旧内容'));
check('仍是本轮开始前消息 → 跳过', x.r === false);

x = run(makeAgent('new-id', '内容'), { metaObj: { 'c1_new-id': { temp: false, segs: 1 } } });
check('已播完永久 → 跳过', x.r === false);

x = run(makeAgent('new-id', '内容'), { ttsActiveKey: 'c1_new-id', ttsActiveState: 'playing' });
check('同消息播放中 → 跳过', x.r === false);

x = run(makeAgent('new-id', '内容'), { ttsActiveKey: 'c1_new-id', ttsActiveState: 'idle' });
check('残留key自愈 → 触发', x.r === true && x.spoken && x.ctx.ttsActiveKey === null);

x = run(makeAgent('new-id', '内容'), { autoSpokenMsgKey: 'c1_new-id' });
check('已自动朗读过 → 跳过不重复', x.r === false && !x.spoken);

console.log('自动朗读验证: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
