// 发布前验证：分页逻辑（从 server.js 抽取真实函数体运行）
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const marker = 'function pageThread(';
const start = src.indexOf(marker);
if (start < 0) { console.error('找不到 pageThread'); process.exit(1); }
const bodyStart = src.indexOf('{', start);
let depth = 0, i = bodyStart;
for (; i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) break; }
}
const pageThread = new Function('return ' + src.slice(start, i + 1))();

function makeThread() {
  const turns = [];
  for (let n = 1; n <= 6; n++) {
    const items = [{ type: 'userMessage', id: 'u' + n, content: [{ type: 'text', text: '问' + n }] }];
    if (n === 3) items.push({ type: 'mcpToolCall', id: 't3', tool: 'x' });
    items.push({ type: 'agentMessage', id: 'a' + n, text: '答' + n });
    turns.push({ id: 'turn' + n, items });
  }
  return { name: '测试对话', status: { type: 'idle' }, turns };
}

function countMsgs(ts) {
  let n = 0;
  for (const t of ts) for (const it of (t.items || [])) if (it.type === 'userMessage' || it.type === 'agentMessage') n++;
  return n;
}

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name); }
}

const nested = { thread: makeThread() };
let p = pageThread(nested, 10);
check('嵌套形状能取到 turns', Array.isArray(p.turns) && p.turns.length > 0);
check('嵌套形状名称正确', p.thread.name === '测试对话');
check('第1页含最后一轮', p.turns.some(t => t.id === 'turn6'));
check('第1页 hasMore', p.hasMore === true);
check('第1页消息数≈10', countMsgs(p.turns) <= 12 && countMsgs(p.turns) >= 8);

const direct = makeThread();
p = pageThread(direct, 10);
check('直接形状能取到 turns', Array.isArray(p.turns) && p.turns.length > 0);
check('直接形状名称正确', p.thread.name === '测试对话');

const p1 = pageThread(direct, 10);
const p2 = pageThread(direct, 10, p1.nextCursor);
check('第2页 hasMore=false 或游标递减', p2.hasMore === false || p2.nextCursor < p1.nextCursor);
check('两页都有内容', p1.turns.length > 0 && p2.turns.length > 0);
const known = new Set(p1.turns.map(t => t.id));
const merged = p2.turns.filter(t => !known.has(t.id)).concat(p1.turns);
check('合并去重后覆盖全部轮次', new Set(merged.map(t => t.id)).size === 6);

p = pageThread({ thread: { turns: [] } }, 10);
check('空线程返回空且无更多', p.turns.length === 0 && p.hasMore === false);

console.log('分页验证: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
