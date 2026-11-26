// modules/model_registry.js — R88 老板拍 "不是写死,盘古直接读才对"
// Runtime cache of model context_window, 从模型商 runtime 探得, 不在 Pangu 写死
// Cache 落盘 ~/.pangu/models-registry.json, 下次启动零 API call 直读
// 2026-09-09 立: 干掉 5 处 || 32768 硬编码, 让 Pangu 自己知道每个 model 真 ctx

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_REGISTRY_PATH = path.join(os.homedir(), '.pangu', 'models-registry.json');

// 2026-10-14: registry 的读写路径必须跟 router/models.json 一样支持 env 隔离。
// router 那边有 PANGU_MODELS_PATH (2026-08-23 事故后加的), registry 这边一直没有 ——
// 于是 tests/r46-sync.test.js 隔离了 router 文件, 却照样把 r46-test-model /
// minimax/MiniMax-M3 这几条测试条目写进了**生产** ~/.pangu/models-registry.json
// (现场 source='test' 就是这么来的)。同一个事故修了半边。
// 惰性求值: 不在模块加载时定死, 改了 env 立即生效 (测试可在 require 之后再设)。
function registryPath() {
  if (process.env.PANGU_REGISTRY_PATH) return process.env.PANGU_REGISTRY_PATH;
  // 2026-10-26 第 102 批收尾: **测试进程不许写生产 registry**。
  //
  // 事故复盘 (真事): 链是沙箱的 (run-tests.sh 导出 PANGU_REGISTRY_PATH), 但**单跑一个测试文件**
  // (node --test tests/xxx.test.js) 没有任何隔离 ⇒ timeout-policy-20261023 的 mock 上游
  // 把 `probe-local` 直接写进生产 ~/.pangu/models-registry.json。
  // 也就是说「沙箱导出 ⇒ 不会再长回来」只对链成立, 单跑就漏 ——
  // 生产状态被测试污染, 而 G102f 只在链尾查一次, 下一次单跑就又脏了。
  //
  // 修法: 认得自己是测试进程 (node --test 的子进程带 NODE_TEST_CONTEXT),
  // 且没人显式指定 registry 路径时 ⇒ 落到**临时目录**, 永远不碰生产。
  // 显式 PANGU_REGISTRY_PATH 仍然最优先 (沙箱链要的就是它)。
  if (_isTestProcess()) {
    return path.join(os.tmpdir(), 'pangu-models-registry-test-' + process.pid + '.json');
  }
  return DEFAULT_REGISTRY_PATH;
}

// 「我是不是测试进程?」—— 两道判据, 缺一道就漏。
//
// 2026-10-26 (第 103 批探针实测): 原来只看 NODE_TEST_CONTEXT, 而那只在
// `node --test` 的**子进程**里才有。于是**裸跑** `node tests/xxx.test.js`
// (不带 --test) 时它是 undefined ⇒ registryPath() 落回生产路径 ⇒
// 那个测试里的 mock 上游把 `probe-ctx-newvendor` 直接写进了生产
// ~/.pangu/models-registry.json (探针用 fake HOME 复现, 真写进去了)。
//
// ⇒ 加第二道判据: **我自己的文件名就是个测试文件**。
//   测试文件的名字是我们自己定的 (约定: *.test.js), 认它不依赖任何环境变量,
//   也不依赖父进程怎么调 —— 裸跑、npm 跑、--test 跑, 一律认得出。
function _isTestProcess() {
  // 第一道: node --test 的子进程 (老判据, 保留)
  if (process.env.NODE_TEST_CONTEXT) return true;
  // 第二道: 我就是个测试文件 (裸跑时唯一能认出来的线索)
  const argv1 = process.argv && process.argv[1];
  if (!argv1) return false;
  const s = String(argv1);
  if (/\.test\.[cm]?js$/i.test(s)) return true;
  if (/(^|[\\/])tests?[\\/].*\.[cm]?js$/i.test(s)) return true;
  return false;
}
const REGISTRY_VERSION = 1;

let _cache = null;
let _cachePath = null;

function load() {
  const REGISTRY_PATH = registryPath();
  // 缓存必须认路径: 测试改了 PANGU_REGISTRY_PATH 之后还拿着上一个路径的
  // 缓存, 就会把 temp 文件的内容当生产数据写回去 —— 那等于没隔离。
  if (_cache && _cachePath === REGISTRY_PATH) return _cache;
  _cachePath = REGISTRY_PATH;
  const tryParse = () => {
    if (!fs.existsSync(REGISTRY_PATH)) return null;
    const parsed = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    return parsed && parsed.version === REGISTRY_VERSION && parsed.models ? parsed : null;
  };
  try {
    const parsed = tryParse();
    if (parsed) {
      _cache = parsed;
      return _cache;
    }
  } catch (e) {
    // Registry can be read while another pangu process is writing it. Never
    // let a transient parse failure poison this process with an empty cache.
    console.warn('[model-registry] load failed:', e.message);
  }
  try {
    const retried = tryParse();
    if (retried) {
      _cache = retried;
      console.warn('[model-registry] retry load succeeded after initial failure');
      return _cache;
    }
  } catch (_) {}
  _cache = { version: REGISTRY_VERSION, models: {} };
  return _cache;
}

function save() {
  if (!_cache) return;
  const REGISTRY_PATH = registryPath();
  try {
    const dir = path.dirname(REGISTRY_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    _cache.updated = new Date().toISOString();
    // Atomic replace so concurrent readers never observe a truncated file.
    const tmpPath = REGISTRY_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(_cache, null, 2));
    fs.renameSync(tmpPath, REGISTRY_PATH);
  } catch (e) {
    console.warn('[model-registry] save failed:', e.message);
  }
}

function getContextLength(modelId) {
  if (!modelId) return null;
  const models = load().models;
  const k = resolveKey(modelId);
  const m = k ? models[k] : null;
  return m && typeof m.context_length === 'number' && m.context_length > 0 ? m.context_length : null;
}

// registry 的 id 查找规则 (唯一真源): 精确, 下划线换连字符, 两级。
// 现场: 池里 minimax_m3.1-flash-preview, registry 里 minimax-m3.1-flash-preview。
// 谁要问"这个池内 id 在 registry 里对应哪条", 都必须走 resolveKey, 不许自己写精确匹配 ——
// 精确匹配会把一条活着的模型缓存误判成池外垃圾删掉, 正好制造 registry miss。
function resolveKey(modelId) {
  const id = String(modelId || '');
  if (!id) return null;
  const models = load().models;
  const alt = id.replace(/_/g, '-');
  if (models[id]) return id;
  if (alt !== id && models[alt]) return alt;
  return null;
}

function getModelInfo(modelId) {
  const k = resolveKey(modelId);
  return k ? load().models[k] : null;
}

function setContextLength(modelId, contextLength, source = 'probe', extra = {}) {
  if (!modelId || typeof contextLength !== 'number' || contextLength <= 0) return null;
  const reg = load();
  reg.models[modelId] = {
    ...(reg.models[modelId] || {}),
    ...extra,
    context_length: contextLength,
    source,
    verified_at: new Date().toISOString(),
  };
  save();
  return reg.models[modelId];
}

function listModels() {
  return Object.entries(load().models).map(([id, m]) => ({ id, ...m }));
}

// 2026-10-14: registry 以前只进不出, 几年下来积成坟场。
// 现场 ~/.pangu/models-registry.json 24 条里:
//   - 4 条 r46-*/test-model 测试垃圾
//   - 3 条 mlx-serve 死条目 (端口早 DEAD, 模型还在)
//   - 2 条幽灵 (google_gemma-4-26b-a4b-qat / qwen_qwen3.6-35b-a3b, ctx 185386/185378)
//     —— 这两个正是曾经躺在 fallback_chain 里的幽灵引用
//   - 1 条 oMLX 的 Qwen3.8-27B-4bit (端点已不用)
// 而且**没有一条记 endpoint**, 所以事后无法判断某条 ctx 是从哪个端点探来的。
//
// pruneModels: 只保留池子里还活着的 id (config.llm.models 是唯一真源),
// 与 router/models.json 的 prune 同一个数据源、同一个时机 —— 不另立标准。
// keep 额外传入的 id 用于"已从池里删掉但随时会加回来"的模型 (宁可留垃圾不可丢缓存)。
function pruneModels(validIds, opts = {}) {
  // 空池 = 数据源未就绪, 不是"该清空" —— 拒绝执行。
  // (跟 pangu_helpers 里 router models.json 的同一道闸: 2026-08-23 一次空配置
  //  把生产 models.json 清成 0 个模型, router 全哑。空配置清库 = 事故, 不是清理。)
  const ids = (Array.isArray(validIds) ? validIds : []).filter(Boolean);
  const alsoKeep = (Array.isArray(opts.alsoKeep) ? opts.alsoKeep : []).filter(Boolean);
  if (!ids.length && !alsoKeep.length) {
    console.warn('[model-registry] pruneModels refused: validIds 为空 (拒绝清空 registry)');
    return { before: Object.keys(load().models).length, after: Object.keys(load().models).length, removed: [], refused: 'empty_valid_ids' };
  }
  const reg = load();
  // 用 resolveKey 判"池内 id 查得到哪条", 而不是猜 id 写法 ——
  // 否则 minimax_m3.1-flash-preview / minimax-m3.1-flash-preview 这种下划线-连字符
  // 变体对会被误判成池外垃圾, 删掉一条活着的模型缓存。
  const keep = new Set();
  for (const id of [...ids, ...alsoKeep]) {
    keep.add(String(id));
    const k = resolveKey(id);
    if (k) keep.add(k);
  }
  const before = Object.keys(reg.models).length;
  const removed = [];
  for (const id of Object.keys(reg.models)) {
    if (!keep.has(id)) {
      removed.push(id);
      delete reg.models[id];
    }
  }
  if (removed.length) {
    reg.updated = new Date().toISOString();
    save();
    console.warn(
      '[model-registry] pruned ' + removed.length + ' 条池外条目: ' + removed.join(', ')
    );
  }
  return { before, after: Object.keys(reg.models).length, removed };
}

function _reset() { _cache = null; _cachePath = null; }  // 仅测试用

module.exports = {
  load, save,
  getContextLength, getModelInfo, resolveKey,
  setContextLength, listModels, pruneModels,
  registryPath, REGISTRY_VERSION,
  _reset,
};
