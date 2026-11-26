'use strict';
/**
 * tests/comfyui-local-config-20261030.test.js
 *
 * 第 174 批守卫 —— 本机 ComfyUI 配置归一 (2026-10-30)
 *
 * 起因 (老板: 「本机comfyui你全部整理下, 优化」):
 *   整理前实测, 本机 ComfyUI 的配置**散在四个地方**:
 *     · 权重 72G 全躺在安装目录 models/ 里,
 *       而 extra_model_paths.yaml 声明的 ~/AI-Models/ (防 Desktop 更新删权重的那层
 *       防护) **完全是空的** ⇒ 防护从未生效过。
 *     · extra_model_paths.yaml **漏声明 embeddings** ⇒ 那 10 个 minimaxh3
 *       音色 embedding 找不到 ⇒ ACE-Step 出歌直接坏。
 *     · 输出目录四处并存: install/output (600M) / ~/Desktop/workspace/ComfyUI_Output
 *       (657M) / ~/ComfyUI-Shared/output (47M) / ~/ComfyUI_Output (helper 默认根,
 *       不存在) ⇒ 产物散落, 而且 ComfyUI-Shared/models 是一排空目录 ——
 *       正是 AGENTS.md §11.2 记的「查错路径得出『权重没了』的假结论」那个坑。
 *     · ComfyUI 没有 launchd 守护 (Marvis 手工 nohup 起的), 日志写 /tmp ⇒
 *       重启电脑就没了, 重启即失日志。
 *     · Comfy Desktop 的 settings.json 还指向已删的 ComfyUI-Shared。
 *
 * 这条守卫盯住「别再漂回去」:
 *   ① extra_model_paths.yaml 必须声明 embeddings (漏了 ⇒ ACE-Step 坏)
 *   ② 权重真身必须在 ~/AI-Models/ (不在安装目录 ⇒ Desktop 更新会删)
 *   ③ 安装目录 models/ 里不许再出现 .safetensors (搬干净了)
 *   ④ ComfyUI 服务端必须有 launchd 守护 + 输出目录归一
 *   ⑤ helper 的默认输出根必须跟 AGENTS.md §6 一致 (Desktop/workspace/ComfyUI_Output)
 *   ⑥ Comfy Desktop 的 settings.json 不许再指向 ComfyUI-Shared
 *   ⑦ 负例自检 —— 守卫本身会咬
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOME = os.homedir();
const INSTALL = path.join(HOME, 'ComfyUI-Installs', 'ComfyUI (1)', 'ComfyUI');
const YAML_PATH = path.join(INSTALL, 'extra_model_paths.yaml');
const HELPER = path.join(__dirname, '..', 'modules', 'tools', 'comfyui_helper.py');
const PLIST = path.join(HOME, 'Library', 'LaunchAgents', 'local.comfyui-server.plist');
const SERVER_SH = path.join(HOME, 'bin', 'comfyui-server.sh');
const DESKTOP_SETTINGS = path.join(HOME, 'Library', 'Application Support', 'Comfy Desktop', 'settings.json');

const CANON_OUT = path.join(HOME, 'Desktop', 'workspace', 'ComfyUI_Output');
const AI_MODELS = path.join(HOME, 'AI-Models');

const hasYaml = fs.existsSync(YAML_PATH);
const yamlSrc = hasYaml ? fs.readFileSync(YAML_PATH, 'utf8') : '';
const helperSrc = fs.existsSync(HELPER) ? fs.readFileSync(HELPER, 'utf8') : '';

test('174-①: extra_model_paths.yaml 必须声明 embeddings', { skip: !hasYaml && '本机没有 ComfyUI 安装' }, () => {
  // 漏声明 embeddings 的后果很具体: 那 10 个 minimaxh3 音色 embedding
  // (ACE-Step 出歌要用) ComfyUI 枚举不到 ⇒ 出歌流程直接坏。
  assert.match(yamlSrc, /embeddings:\s*embeddings\//,
    'extra_model_paths.yaml 没声明 embeddings —— 搬完权重后 ACE-Step 的音色 embedding 会找不到');
  assert.match(yamlSrc, /base_path:\s*\/Users\/feng\/AI-Models\//,
    'base_path 必须指向 ~/AI-Models/ (那是防 Desktop 更新删权重的那层防护)');
  assert.match(yamlSrc, /is_default:\s*true/,
    'is_default: true 才能让该路径插到搜索列表第一位 (ComfyUI 优先用)');
});

test('174-②: 权重真身必须在 ~/AI-Models/, 不在安装目录', () => {
  if (!fs.existsSync(AI_MODELS)) {
    assert.fail('~/AI-Models/ 不存在 —— 权重没落到防护目录');
  }
  const real = [];
  for (const d of fs.readdirSync(AI_MODELS)) {
    const p = path.join(AI_MODELS, d);
    if (!fs.statSync(p).isDirectory()) continue;
    for (const f of fs.readdirSync(p)) {
      if (f.endsWith('.safetensors')) real.push(`${d}/${f}`);
    }
  }
  assert.ok(real.length > 0, '~/AI-Models/ 里一个权重都没有 —— 防护目录是空的, 等于没防护');

  // 安装目录里不许再出现权重 (装在安装目录 = Desktop 更新会连权重一起删)
  const modelsDir = path.join(INSTALL, 'models');
  if (fs.existsSync(modelsDir)) {
    const leaked = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.safetensors')) leaked.push(p);
      }
    };
    walk(modelsDir);
    assert.deepStrictEqual(leaked, [],
      `安装目录里还有权重 (${leaked.length} 个) ⇒ Desktop 自动更新会连权重一起删, 防护失效`);
  }
});

test('174-③: ComfyUI 必须有 launchd 守护, 且输出目录归一', () => {
  assert.ok(fs.existsSync(PLIST), '没有 local.comfyui-server.plist ⇒ ComfyUI 重启电脑就没了');
  assert.ok(fs.existsSync(SERVER_SH), '没有 ~/bin/comfyui-server.sh ⇒ 没有守护入口');
  const sh = fs.readFileSync(SERVER_SH, 'utf8');
  assert.match(sh, /--output-directory/,
    '启动脚本没带 --output-directory ⇒ 服务端产物又落回安装目录');
  assert.match(sh, /Desktop.*workspace.*ComfyUI_Output/,
    '启动脚本的输出目录必须是 ~/Desktop/workspace/ComfyUI_Output (AGENTS.md §6)');

  const plist = fs.readFileSync(PLIST, 'utf8');
  assert.match(plist, /<key>KeepAlive<\/key>/,
    'plist 没有 KeepAlive ⇒ 进程挂了不会自己回来');
});

test('174-④: helper 默认输出根必须跟 AGENTS.md §6 一致', () => {
  assert.ok(helperSrc, '找不到 comfyui_helper.py');
  // 老默认值是 ~/ComfyUI_Output (跟 AGENTS.md §6 规定的不一致, 且跟服务端
  // 的 --output-directory 不同根 ⇒ 产物散两处)。
  // 判据要匹配**结构**, 不是字面量:
  //   新的默认值拼成 os.path.join(home, "Desktop", "workspace", "ComfyUI_Output"),
  //   所以源码里不该再出现孤零零的 "ComfyUI_Output" 当默认根。
  //   (用「跟 Desktop/workspace/ 同段」来判, 避免把整段换掉自欺欺人)
  // 按**行区间**切出完整定义块 (正则截断会切在半路 —— os.path.join 里嵌套的
  // 括号会让非贪婪匹配提前收尾, 那是最容易写出假红的写法)。
  //
  // ⚠️ 切片窗口必须刚好盖住 `_DEFAULT_OUTPUT_ROOT = os.path.join(...)` 这一条,
  //    **不能**往后多吃几行 —— 否则会把下一句 DEFAULT_OUT 里的
  //    `"ComfyUI_Output"` 一起吃进来, 误判成"硬编码旧根" ⇒ 假红。
  //    这就是「判据要匹配结构, 不是字面量」那条老坑的现场版。
  const helperLines = helperSrc.split('\n');
  const rootStart = helperLines.findIndex(l => l.includes('_DEFAULT_OUTPUT_ROOT'));
  assert.ok(rootStart >= 0, 'helper 里找不到 _DEFAULT_OUTPUT_ROOT 定义');
  // 从定义行往下找**第一个**以 ')' 结尾的行 = os.path.join 的收尾
  let end = rootStart;
  while (end < helperLines.length && !helperLines[end].trim().endsWith(')')) end += 1;
  const defaultRootBlock = helperLines.slice(rootStart, end + 1).join('\n');
  assert.match(defaultRootBlock, /Desktop/,
    'helper 的默认输出根必须是 ~/Desktop/workspace/ComfyUI_Output (AGENTS.md §6)');
  assert.ok(!/"ComfyUI_Output"/.test(defaultRootBlock.replace(/"Desktop", "workspace", "ComfyUI_Output"/, '')),
    'helper 还硬编码 ~/ComfyUI_Output 当默认根 —— 会跟服务端的输出目录分叉');
  assert.match(helperSrc, /Desktop["',\s]+workspace["',\s]+ComfyUI_Output/,
    'helper 的默认输出根必须是 ~/Desktop/workspace/ComfyUI_Output');
  // 环境变量覆盖能力必须保留 (pangu 的 launchd plist 靠它)
  assert.match(helperSrc, /COMFYUI_OUTPUT_ROOT/,
    'helper 必须仍认 COMFYUI_OUTPUT_ROOT 环境变量');
});

test('174-⑤: Comfy Desktop 不许再指向已删的 ComfyUI-Shared', () => {
  if (!fs.existsSync(DESKTOP_SETTINGS)) return; // Desktop 没装过, 无所谓
  const d = JSON.parse(fs.readFileSync(DESKTOP_SETTINGS, 'utf8'));
  const dirs = [].concat(d.modelsDirs || [], d.inputDir || '', d.outputDir || '');
  for (const x of dirs) {
    assert.ok(!String(x).includes('ComfyUI-Shared'),
      `Comfy Desktop 还指向 ComfyUI-Shared (${x}) —— 那是已删的空目录树, 会让人误判「权重没了」`);
  }
  assert.ok(JSON.stringify(d.modelsDirs || '').includes('AI-Models'),
    'Comfy Desktop 的 modelsDirs 必须指向 ~/AI-Models (权重真身所在)');
});

test('174-⑥: 负例自检 —— 守卫会咬', () => {
  // 把 ① 的判据拿去测一份「漏声明 embeddings」的 yaml, 必须判红。
  // ⚠️ 这里**不许**写本机绝对路径字面量 (会被 open-source-hygiene 判红:
  //    被跟踪文件里不许出现本机真名的绝对路径) ⇒ 用 HOME 运行时拼。
  const badYaml = `ai_models:\n  base_path: ${HOME}/AI-Models/\n  is_default: true\n  checkpoints: checkpoints/\n`;
  assert.ok(!/embeddings:\s*embeddings\//.test(badYaml),
    '负例本身有问题: 漏声明 embeddings 的 yaml 竟然通过了判据');
  // 把 ⑤ 的判据拿去测一个仍指向 ComfyUI-Shared 的配置, 必须判红。
  const badSettings = { modelsDirs: [`${HOME}/ComfyUI-Shared/models`], outputDir: `${HOME}/ComfyUI-Shared/output` };
  assert.ok(JSON.stringify(badSettings).includes('ComfyUI-Shared'),
    '负例本身有问题: 指向 ComfyUI-Shared 的配置竟然没被识别');
});

test('174-⑦: int8_convrot 权重不许再出现 (MPS 加载不了, 纯占 16.6G)', () => {
  // 2026-10-30 清理时实测:
  //   torch._scaled_mm 在 MPS 上直接 TypeError ——
  //   "Trying to convert Float8_e4m3fn to the MPS backend but it does not
  //    have support for that dtype."
  //   ⇒ int8/fp8 权重在这台机器上**根本加载不了**, 不是「慢」是「跑不了」。
  //   safetensors header 实测这两个文件的 dtype 是 I8/U8 量化。
  //   且全盘搜过: 没有任何 workflow 引用它们。
  //   ⇒ 删掉是纯收益 (16.61G), 但守卫要盯着别再装回来 ——
  //      「装回来」这个动作的代价是 16.6G 磁盘 + 一条永远加载失败的链路。
  const INT8_NAMES = ['qwen_image_2.1_int8_convrot', 'qwen3vl_8b_int8_convrot'];
  const found = [];
  for (const dir of ['diffusion_models', 'text_encoders', 'checkpoints', 'vae']) {
    const p = path.join(AI_MODELS, dir);
    if (!fs.existsSync(p)) continue;
    for (const f of fs.readdirSync(p)) {
      if (INT8_NAMES.some(n => f.includes(n))) found.push(`${dir}/${f}`);
    }
  }
  assert.deepStrictEqual(found, [],
    `又出现了 int8_convrot 权重 (${found.join(', ')}) —— MPS 加载不了 (float8 不支持 MPS dtype), 纯占地方`);
});

test('174-⑧: ComfyUI 不许复活第二个 python env (会分裂依赖)', () => {
  // 2026-10-30 清理: ComfyUI/.venv 1.85G 被删。
  //   它只有已废的 local.mm3-gen 引用; server 跑的是 standalone-env,
  //   而 ComfyUI-Manager 装包走 sys.executable (= server 的解释器),
  //   ⇒ .venv 里的包 server 根本看不见 ⇒ 装了也不生效, 只浪费盘。
  const venv = path.join(INSTALL, '.venv');
  assert.ok(!fs.existsSync(venv),
    'ComfyUI/.venv 又出现了 —— server 用 standalone-env, 这个 venv 的依赖它看不见 (装也不生效)');
  // server 必须还在用 standalone-env (manifest 把 torch pin 在 2.12.1, 别动它)
  const sh = fs.existsSync(SERVER_SH) ? fs.readFileSync(SERVER_SH, 'utf8') : '';
  assert.match(sh, /standalone-env/,
    '启动脚本必须用 standalone-env (manifest 的 MPS torch pin 在那里)');
});

// ═══════════════════════════════════════════════════════════════════════
// 第 175 批: 「ACE-Step 和 MiniMax Music 3 默认走本地不走云端」
// ═══════════════════════════════════════════════════════════════════════

const ACE_NODE = path.join(INSTALL, 'custom_nodes', 'ACE-Step-ComfyUI', 'nodes.py');
const ACE_SERVER = path.join(HOME, 'bin', 'ace-step-server.py');

test('175-①: ComfyUI 的 ACE-Step 节点默认必须走本地', () => {
  if (!fs.existsSync(ACE_NODE)) return; // 没装 ACE-Step custom node
  const src = fs.readFileSync(ACE_NODE, 'utf8');
  // 锚点用 **class 定义行** (源码里是 `class AceStepText2MusicServer:`),
  // 不用 "name": "..." —— 那个字符串形式在这个 custom node 里根本不存在,
  // 照着不存在的形式找 ⇒ 永远判红 (判据要匹配**实际结构**)。
  const i = src.indexOf('class AceStepText2MusicServer:');
  assert.ok(i > 0, '找不到 AceStepText2MusicServer 类定义');
  const seg = src.slice(i, i + 2500);
  // 默认 mode 必须是 local (原版是 cloud → 打 api.acemusic.ai 云端)
  assert.match(seg, /"mode":\s*\(\["cloud",\s*"local"\],\s*\{[^}]*"default":\s*"local"/,
    'ACE-Step 节点的 mode 默认必须是 local —— 老板: 「默认走本地不走云端」');
  // 默认 server_url 必须指向本机服务
  assert.match(seg, /"server_url":\s*\("STRING",\s*\{[^}]*"default":\s*"http:\/\/127\.0\.0\.1:7860"/,
    'ACE-Step 节点的 server_url 默认必须是本机 7860 (ACE-Step 服务所在端口)');
  // 不许再出现云端默认地址
  assert.ok(!/"default":\s*"https:\/\/api\.acemusic\.ai"/.test(seg),
    'ACE-Step 节点的默认地址还指着云端 api.acemusic.ai');
});

test('175-②: ACE-Step 服务必须同时提供 Gradio UI 和 OpenAI 兼容 API', () => {
  if (!fs.existsSync(ACE_SERVER)) return;
  const src = fs.readFileSync(ACE_SERVER, 'utf8');
  // ⚠️ 判据要匹配**真正的路由定义**, 不能只是「源码里出现过这个字符串」——
  //    文档注释里也写着 /v1/chat/completions, 那样的话把真路由改坏了它也不红。
  assert.match(src, /api\.post\(\s*['"]\/v1\/chat\/completions['"]\s*\)/,
    'ACE-Step 服务没有 /v1/chat/completions ⇒ ComfyUI 节点打过来会 404');
  // 同理: 要匹配**真正的调用**, 不是注释里提过一句
  assert.match(src, /gr\.mount_gradio_app\(/,
    'ACE-Step 服务必须用 mount_gradio_app (UI 和 API 同一进程, 模型只加载一次)');
  assert.match(src, /def health|\/health/,
    'ACE-Step 服务必须有 /health (守护和守卫靠它判活)');
});

test('175-③: ACE-Step 的 5Hz LM 必须跑 CPU (MPS 上会 nan/inf)', () => {
  if (!fs.existsSync(ACE_SERVER)) return;
  const src = fs.readFileSync(ACE_SERVER, 'utf8');
  // 硬坑来源: ~/Music/jianxiao/gen_auto_v10.py 的实测结论 ——
  //   5Hz LM 在 MPS 上采样报 "probability tensor contains either `inf`, `nan`
  //   or element < 0" ⇒ LM 放 CPU (1.7B, 128GB 内存够), DiT 仍走 MPS。
  // 按**行区间**切 llm.initialize 的调用块 (正则切窗口太脆: 结尾既可能是
  // ')' 也可能是 '\n)'; 交给行号更稳。device='cpu' 在参数列表末尾,
  // 400 字符窗口够不到 —— 之前就是这么判红的)
  const aceLines = src.split('\n');
  const llmStart = aceLines.findIndex(l => l.includes('llm.initialize('));
  assert.ok(llmStart >= 0, '找不到 llm.initialize 调用');
  // 从**下一行**开始找收尾 —— 起始行本身就含 ')' (「llm.initialize(」),
  // 从起始行找会立刻停在那儿, 只切到第一行 (实测判红的原因)
  let llmEnd = llmStart;
  llmEnd += 1;
  while (llmEnd < aceLines.length && !aceLines[llmEnd].trim().endsWith(')')) llmEnd += 1;
  const llmBlock = aceLines.slice(llmStart, llmEnd + 1).join('\n');
  assert.ok(llmBlock, '找不到 llm.initialize 调用');
  assert.match(llmBlock, /device\s*=\s*['"]cpu['"]/,
    '5Hz LM 必须 device="cpu" —— MPS 上采样会 nan/inf');
  // DiT 仍走 MPS (别把推理也搬到 CPU, 会慢十倍)
  const ditStart = aceLines.findIndex(l => l.includes('dit.initialize_service('));
  assert.ok(ditStart >= 0, '找不到 dit.initialize_service 调用');
  let ditEnd = ditStart;
  ditEnd += 1;
  while (ditEnd < aceLines.length && !aceLines[ditEnd].trim().endsWith(')')) ditEnd += 1;
  const ditBlock = aceLines.slice(ditStart, ditEnd + 1).join('\n');
  assert.match(ditBlock, /device\s*=\s*['"]mps['"]/,
    'DiT 必须留在 MPS (搬 CPU 会慢十倍)');
});

test('175-④: MiniMax Music 3 的本地节点和权重必须都在', () => {
  // 「默认走本地」对 MiniMax 的落点: 本地 core 节点 (comfy_extras/nodes_minimax_music.py)
  //   + 本地权重 (minimax_music3_dit / text_encoder / dav)。
  //   云节点 ComfyCloudMiniMaxMusic3TextToAudioNode 是另一条路 (要 api_key)。
  const dit = path.join(AI_MODELS, 'diffusion_models', 'minimax_music3_dit_fp16.safetensors');
  const te = path.join(AI_MODELS, 'text_encoders', 'minimax_music3_text_encoder_pruned_bf16.safetensors');
  const vae = path.join(AI_MODELS, 'vae', 'minimax_music3_dav.safetensors');
  for (const [label, p] of [['dit', dit], ['text_encoder', te], ['dav vae', vae]]) {
    assert.ok(fs.existsSync(p), `MiniMax Music 3 的 ${label} 权重没了: ${p.replace(HOME, '~')}`);
  }
  // 本地节点源码必须在 (云节点不能是唯一入口)
  const nodeFile = path.join(INSTALL, 'comfy_extras', 'nodes_minimax_music.py');
  assert.ok(fs.existsSync(nodeFile),
    'comfy_extras/nodes_minimax_music.py 不在了 ⇒ 本地 MiniMax Music 3 节点没了');
});

test('175-④b: ComfyUI 原生 ACE-Step 1.5 的 aio checkpoint 不许消失', () => {
  // 2026-10-30 实测 (重要, 差点判错):
  //   ace_step_1.5_turbo_aio.safetensors 是 Comfy-Org 官方发布的**一体化**
  //   ACE-Step 1.5 checkpoint (9.34G: DiT + qwen3_06b TE + qwen3_2b LM + VAE,
  //   diffusers 风格前缀 model.diffusion_model. / text_encoders. / vae.)。
  //
  //   ComfyUI 0.39 **原生支持** ACE-Step 1.5:
  //     · comfy/text_encoders/ace15.py (Qwen3_06B / Qwen3_2B / Qwen3_4B 三档 LM)
  //     · 节点 TextEncodeAceStepAudio1.5 / EmptyAceStep1.5LatentAudio
  //     · 官方模板 audio_ace_step_1_5_checkpoint.json 用的就是 CheckpointLoaderSimple
  //       加载这个 aio (checkpoint loader 能从一个文件里拆出 model/clip/vae)
  //   实测: CheckpointLoaderSimple 能把它拆成 model+clip+vae, 且端到端出歌成功
  //   (30s 音频, RMS 0.142, 频谱 高频57% —— 符合 synthwave 提示词)。
  //
  // ⇒ 它是「ComfyUI 原生 ACE-Step」这条线的**唯一依赖**, 删了就只剩 HTTP 线。
  const aio = path.join(AI_MODELS, 'checkpoints', 'ace_step_1.5_turbo_aio.safetensors');
  assert.ok(fs.existsSync(aio),
    'ace_step_1.5_turbo_aio.safetensors 不在了 ⇒ ComfyUI 原生 ACE-Step 1.5 这条线断了');
  // 原生节点源码也得在 (ace15.py 提供 qwen3_06b / qwen3_2b / qwen3_4b 三档 LM)
  assert.ok(fs.existsSync(path.join(INSTALL, 'comfy', 'text_encoders', 'ace15.py')),
    'comfy/text_encoders/ace15.py 不在了 ⇒ ComfyUI 原生 ACE-Step 1.5 的 LM 没了');
});

test('175-⑤: 负例自检 —— 守卫会咬', () => {
  const badMode = '"mode": (["cloud", "local"], {"default": "cloud"})';
  assert.ok(!/"default":\s*"local"/.test(badMode),
    '负例本身有问题: cloud 默认竟然通过了判据');
  const badServer = "llm.initialize(checkpoint_dir='x', lm_model_path='y', backend='pt', device='mps')";
  assert.ok(!/device\s*=\s*['"]cpu['"]/.test(badServer),
    '负例本身有问题: MPS 的 LM 竟然通过了判据');
});



test('175-⑥: ACE-Step API 每次出歌必须清掉自己的临时缓存 (不留 75M 歌堆在 /var/folders)', () => {
  if (!fs.existsSync(ACE_SERVER)) return;
  const src = fs.readFileSync(ACE_SERVER, 'utf8');
  // 之前每次生成 tempfile.mkdtemp(prefix='acestep-api-') 留一个 75M wav,
  // 没人清 ⇒ 越积越多。现在必须: finally 里 shutil.rmtree 删掉临时目录。
  assert.match(src, /shutil\.rmtree\(tmp_dir, ignore_errors=True\)/,
    'ACE-Step API 没在 finally 里删临时目录 ⇒ 每次出歌留一个 75M 歌在 /var/folders');
  assert.ok(src.includes("prefix='acestep-api-'"),
    'ACE-Step API 的临时目录前缀改了, 守卫认不出了');
});
