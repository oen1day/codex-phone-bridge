// 发布前验证：手机端 app.js 顶层可加载、无同步错误（模拟浏览器环境）
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeEl() {
  return {
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    style: {},
    dataset: {},
    value: '',
    textContent: '',
    innerHTML: '',
    scrollHeight: 0,
    scrollTop: 0,
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    remove() {},
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    focus() {},
    select() {},
    click() {}
  };
}

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  TextEncoder,
  TextDecoder,
  fetch: async () => { throw new Error('no server'); },
  crypto: require('crypto').webcrypto,
  URL,
  Blob,
  FileReader: class { readAsDataURL() {} },
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  location: { reload() {} },
  navigator: {},
  document: {
    getElementById: () => makeEl(),
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    createElement: () => makeEl(),
    body: makeEl()
  }
};
sandbox.window = {
  addEventListener() {},
  RELAY_CONFIG: null,
  AndroidBridge: undefined,
  innerWidth: 375,
  innerHeight: 700,
  location: sandbox.location,
  document: sandbox.document,
  localStorage: sandbox.localStorage
};

const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
try {
  vm.runInNewContext(code, sandbox, { filename: 'app.js' });
  console.log('app.js 顶层执行：无同步错误');
  setTimeout(() => {
    console.log('等待 1.5 秒后：仍在运行，无未捕获异常');
    process.exit(0);
  }, 1500);
} catch (e) {
  console.error('app.js 顶层执行失败: ' + e.message);
  console.error(e.stack);
  process.exit(1);
}
