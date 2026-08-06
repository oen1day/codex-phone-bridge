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

check('zimage 直出文件有 CLIPTextEncode+KSampler+SaveImage', direct['27'] && direct['27'].class_type === 'CLIPTextEncode' && direct['3'] && direct['3'].class_type === 'KSampler' && direct['999'] && direct['999'].class_type === 'SaveImage');
check('zimage 超分文件有超分链+SaveImage', upscale['76'] && upscale['76'].class_type === 'ImageUpscaleWithModel' && upscale['77'] && upscale['999']);
check('gptimage2 文件有 LoadImage+GPT+SaveImage', gpt['299'] && gpt['300'] && gpt['300'].class_type === 'OpenAIGPTImage1' && gpt['999']);
check('三个文件 SaveImage 都带 filename_prefix', direct['999'].inputs.filename_prefix && upscale['999'].inputs.filename_prefix && gpt['999'].inputs.filename_prefix);
check('zimage 用展开后的真实管线节点', direct['30'] && direct['30'].class_type === 'CLIPLoader' && direct['8'] && direct['8'].class_type === 'VAEDecode');
check('server 有 comfyGenerate', server.includes('async function comfyGenerate('));
check('server 有工作流映射', server.includes('zimage_direct_api.json') && server.includes('gptimage2_api.json'));
check('server 能力开关校验', server.includes('图像生成未开启，请先在手机设置里开启'));
check('server 无图纯文生图（删 LoadImage）', server.includes("delete graph['299']") && server.includes("delete graph['300'].inputs.image"));
check('server 进度广播 comfyProgress', server.includes("method: 'comfyProgress'"));
check('server 广播 comfyStarted', server.includes("method: 'comfyStarted'"));
check('server 支持 comfyApiKey 透传', server.includes('extraData.api_key_comfy_org = config.comfyApiKey') && server.includes('extra_data: extraData'));
check('server 支持 Firebase 令牌自动续期', server.includes('function getComfyAuthToken()') && server.includes('securetoken.googleapis.com') && server.includes('comfyFirebaseRefreshToken'));
check('server 未启动可读提示', server.includes('请先在电脑上启动 ComfyUI'));
check('server 有 HTTP 端点', server.includes("'/api/comfy/generate'"));
check('app.js 处理 comfyProgress', app.includes("method === 'comfyProgress'") && app.includes('updateComfyProgress'));
check('app.js 处理 comfyStarted', app.includes("method === 'comfyStarted'") && app.includes('function startComfyProgress()'));
check('app.js 有生成卡片计时', app.includes('生成中 ' ) && app.includes('comfyTimer = setInterval'));
check('app.js 上报能力', app.includes('function reportCapabilities()') && app.includes("'reportCapabilities'"));
check('app.js lanCall 支持能力上报', app.includes("case 'reportCapabilities'"));
check('server 有上报 HTTP 端点', server.includes("'/api/report-capabilities'"));
check('能力缓存持久化', server.includes('PHONE_CAPS_PATH') && server.includes('loadPhoneCaps()'));
check('MCP 有 generate_image', mcp.includes("name: 'generate_image'"));
check('MCP 默认 gptimage2', mcp.includes("args.workflow || 'gptimage2'"));
check('MCP 描述强调默认 gptimage2', mcp.includes('除非用户明确要求使用本地 z-image 生成'));
check('server 默认 gptimage2', server.includes("params.workflow || 'gptimage2'"));
check('server gptimage2 直连 OpenAI', server.includes('async function openaiGenerate(') && server.includes('api.openai.com/v1/images/generations') && server.includes('api.openai.com/v1/images/edits') && server.includes('config.imageProvider === \'openai\''));
check('server 默认 comfy 通道', server.includes("imageProvider: 'comfy'") && server.includes("merged.imageProvider !== 'openai'"));
check('server 挂 undici 代理', server.includes("require('undici')") && server.includes('ProxyAgent') && server.includes('httpsProxy'));
check('server 刷新失败回退临时令牌', server.includes('回退使用临时 comfyAuthToken'));
check('server 读取 openaiApiKey', server.includes("config.openaiApiKey || process.env.OPENAI_API_KEY"));
check('server 错误翻译完整', server.includes('OpenAI API Key 无效或未授权') && server.includes('OpenAI 限流或额度不足'));
check('server 尺寸默认横图 1536x1024', server.includes("return '1536x1024'"));
check('MainActivity 有图像生成开关', java.includes('KEY_CAP_IMAGE_GEN') && java.includes('图像生成（ComfyUI'));
check('config.example 有 comfyUrl', cfg.includes('comfyUrl'));
check('config.example 有 comfyApiKey', cfg.includes('comfyApiKey'));
check('config.example 有 comfyFirebaseRefreshToken', cfg.includes('comfyFirebaseRefreshToken'));
check('config.example 有 openaiApiKey', cfg.includes('openaiApiKey'));
check('config.example 有 httpsProxy', cfg.includes('httpsProxy'));
check('.gitignore 忽略 node_modules', read('.gitignore').includes('node_modules/'));
const css = read('public/style.css');
check('style.css 有占位卡片样式', css.includes('.comfy-generating') && css.includes('.comfy-placeholder') && css.includes('.comfy-badge') && css.includes('comfy-breathe'));

console.log('Comfy 链路验证: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
