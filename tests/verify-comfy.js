// 发布前验证（10.9）：ComfyUI 图像生成链路四层齐全
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
const java = read('android/src/com/local/codexbridge/MainActivity.java');
const cfg = read('config.example.json');

const wfDir = path.join(root, 'comfy-workflows');
const direct = JSON.parse(fs.readFileSync(path.join(wfDir, 'zimage_direct_api.json'), 'utf8'));
const upscale = JSON.parse(fs.readFileSync(path.join(wfDir, 'zimage_upscale_api.json'), 'utf8'));
const gpt = JSON.parse(fs.readFileSync(path.join(wfDir, 'gptimage2_api.json'), 'utf8'));

check('zimage 直出文件有生成节点+SaveImage', direct['57'] && direct['57'].class_type.startsWith('f2fdebf6') && direct['999'] && direct['999'].class_type === 'SaveImage');
check('zimage 超分文件有超分链+SaveImage', upscale['76'] && upscale['76'].class_type === 'ImageUpscaleWithModel' && upscale['77'] && upscale['999']);
check('gptimage2 文件有 LoadImage+GPT+SaveImage', gpt['299'] && gpt['300'] && gpt['300'].class_type === 'OpenAIGPTImage1' && gpt['999']);
check('server 有 comfyGenerate', server.includes('async function comfyGenerate('));
check('server 有工作流映射', server.includes('zimage_direct_api.json') && server.includes('gptimage2_api.json'));
check('server 能力开关校验', server.includes('图像生成未开启，请先在手机设置里开启'));
check('server 无图纯文生图（删 LoadImage）', server.includes("delete graph['299']") && server.includes("delete graph['300'].inputs.image"));
check('server 进度广播 comfyProgress', server.includes("method: 'comfyProgress'"));
check('server 未启动可读提示', server.includes('请先在电脑上启动 ComfyUI'));
check('server 有 HTTP 端点', server.includes("'/api/comfy/generate'"));
check('app.js 处理 comfyProgress', app.includes("method === 'comfyProgress'") && app.includes('updateComfyProgress'));
check('app.js 上报能力', app.includes('function reportCapabilities()') && app.includes("'reportCapabilities'"));
check('MCP 有 generate_image', mcp.includes("name: 'generate_image'"));
check('MainActivity 有图像生成开关', java.includes('KEY_CAP_IMAGE_GEN') && java.includes('图像生成（ComfyUI'));
check('config.example 有 comfyUrl', cfg.includes('comfyUrl'));

console.log('Comfy 链路验证: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
