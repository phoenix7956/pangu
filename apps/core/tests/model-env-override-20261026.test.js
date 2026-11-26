'use strict';
// 2026-10-26: PANGU_MODEL 守卫 —— 环境变量定盘古的认知模型
//
// 本守卫要证明:
//   G103a · 没设 PANGU_MODEL ⇒ 配置文件的选择原样保留 (不多事)
//   G103b · 设了且指向池里可用模型 ⇒ 认知模型就是它 (env > 配置文件)
//   G103c · 设了但池里没这个 id ⇒ **不改** current_model_id, 报错
//          (绝不静默退化成「enabled 第一个」—— 2026-10-14 踩过的坑:
//           配的模型不在池里 → 静默跑成云端付费端点, 全程零提示)
//   G103d · 设了但那个模型 enabled=false ⇒ 同样不改, 同样报错
//   G103e · 空串 / 纯空格 ⇒ 当没设 (plist 里写个空值不该让盘古起不来)
//   G103f · 钉子**不许**落进配置文件 (钉子是运行时旋钮, 不是配置改写)
//   G103g · 接线: 启动链真的调了它, 且致命错误在 catch **外面**抛
//          (在 catch 里抛会被降级成空配置 ⇒ 「盘古起来了但请求全挂」)
//   G103h · 变异体检: 把关键几处改回旧行为 ⇒ 守卫必须**真**报红

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const envOverride = require(path.join(ROOT, 'modules', 'model_env_override'));

function _cfg(current, models) {
  return {
    llm: {
      current_model_id: current,
      models: models || [
        { id: 'k3', enabled: true },
        { id: 'qwen_qwen3.8-27b', enabled: true },
        { id: 'minimax-m3', enabled: false },
      ],
    },
  };
}

test('G103a: 没设 PANGU_MODEL ⇒ 配置文件的选择原样保留', () => {
  envOverride.resetPin();
  const cfg = _cfg('qwen_qwen3.8-27b');
  const r = envOverride.applyEnvOverride(cfg, {});
  assert.equal(r.requested, null);
  assert.equal(r.reason, 'unset');
  assert.equal(r.applied, false);
  assert.equal(cfg.llm.current_model_id, 'qwen_qwen3.8-27b', '没设环境变量就不许碰配置');
  assert.equal(envOverride.getPin(), null, '没钉上的话就不该有钉子');
});

test('G103b: PANGU_MODEL 指向池里可用模型 ⇒ 认知模型就是它 (env > 配置文件)', () => {
  envOverride.resetPin();
  const cfg = _cfg('qwen_qwen3.8-27b');
  const r = envOverride.applyEnvOverride(cfg, { PANGU_MODEL: 'k3' });
  assert.equal(r.ok, true, 'k3 在池子里且 enabled ⇒ 应当解析成功');
  assert.equal(r.id, 'k3');
  assert.equal(r.applied, true);
  assert.equal(cfg.llm.current_model_id, 'k3', '环境变量必须压过配置文件');
  assert.equal(envOverride.getPin().id, 'k3', '钉子要记下来, 后面落盘/偏离播报要用');
  // 空白也要认 (plist 里手抖打个空格很常见)
  envOverride.resetPin();
  const cfg2 = _cfg('qwen_qwen3.8-27b');
  const r2 = envOverride.applyEnvOverride(cfg2, { PANGU_MODEL: '  k3  ' });
  assert.equal(r2.ok, true);
  assert.equal(cfg2.llm.current_model_id, 'k3');
});

test('G103c: PANGU_MODEL 指向池里没有的 id ⇒ 不改模型 + 报错 (绝不静默退化)', () => {
  envOverride.resetPin();
  const cfg = _cfg('qwen_qwen3.8-27b');
  const r = envOverride.applyEnvOverride(cfg, { PANGU_MODEL: 'gpt-4o-mini' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_in_pool');
  assert.equal(r.applied, false);
  assert.equal(cfg.llm.current_model_id, 'qwen_qwen3.8-27b',
    '池里没有这个模型时, current_model_id 必须原样保留 —— '
    + '悄悄换成「enabled 第一个」就是 2026-10-14 那个静默跑成云端付费端点的坑');
  assert.equal(envOverride.getPin(), null, '钉不上就不该留钉子');
  // 报错要能直接告诉主人「怎么改」
  const msg = envOverride.describeFailure(r);
  assert.match(msg, /gpt-4o-mini/);
  assert.match(msg, /k3/, '可用清单要列出来, 不然主人不知道能填什么');
});

test('G103d: PANGU_MODEL 指向 enabled=false 的模型 ⇒ 不改模型 + 报错', () => {
  envOverride.resetPin();
  const cfg = _cfg('qwen_qwen3.8-27b');
  const r = envOverride.applyEnvOverride(cfg, { PANGU_MODEL: 'minimax-m3' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'disabled');
  assert.equal(cfg.llm.current_model_id, 'qwen_qwen3.8-27b',
    '被主人停用的模型不许偷偷复活, 也不许换成别的');
});

test('G103e: 空串 / 纯空格 ⇒ 当没设', () => {
  envOverride.resetPin();
  for (const v of ['', '   ']) {
    const cfg = _cfg('qwen_qwen3.8-27b');
    const r = envOverride.applyEnvOverride(cfg, { PANGU_MODEL: v });
    assert.equal(r.requested, null, `PANGU_MODEL=${JSON.stringify(v)} 应当当没设`);
    assert.equal(cfg.llm.current_model_id, 'qwen_qwen3.8-27b');
  }
});

test('G103f: 钉子不许落进配置文件 (钉子是运行时旋钮, 不是配置改写)', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-model-env-'));
  const cfgPath = path.join(sandbox, 'node.json');
  const routerModelsPath = path.join(sandbox, 'router-models.json');
  const prevRouterPath = process.env.PANGU_MODELS_PATH;
  // ⚠️ router/models.json 是**生产**文件 (第 101/102 批踩过: 测试把它清成 0 个模型)。
  //    写路径认 PANGU_MODELS_PATH, 这里必须导走。
  process.env.PANGU_MODELS_PATH = routerModelsPath;
  fs.writeFileSync(routerModelsPath, JSON.stringify({ models: [] }), 'utf8');
  const onDisk = { llm: { current_model_id: 'qwen_qwen3.8-27b', models: _cfg().llm.models } };
  fs.writeFileSync(cfgPath, JSON.stringify(onDisk, null, 2), 'utf8');

  const helpers = require(path.join(ROOT, 'modules', 'pangu_helpers'));
  try {
    const cfg = _cfg('qwen_qwen3.8-27b');
    envOverride.resetPin();
    const rep = envOverride.applyEnvOverride(cfg, { PANGU_MODEL: 'k3' });
    assert.equal(rep.ok, true);
    assert.equal(cfg.llm.current_model_id, 'k3');

    helpers.init({ _config: cfg, CONFIG_PATH: cfgPath, PRESETS: [], safeGuard: {}, fs });
    helpers.saveConfig();

    const written = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.equal(written.llm.current_model_id, 'qwen_qwen3.8-27b',
      '钉子被写进配置文件了 —— 那样「撤销钉子」就变成「手改文件」, 钉子的语义丢了');

    // 反过来: 主人运行时显式切了模型 ⇒ 那是主人的选择, 落盘, 并且要把偏离说出来
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => { warns.push(a.join(' ')); };
    try {
      cfg.llm.current_model_id = 'minimax-m3';
      helpers.saveConfig();
    } finally {
      console.warn = origWarn;
    }
    const written2 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.equal(written2.llm.current_model_id, 'minimax-m3',
      '主人运行时选的模型必须落盘 —— 钉子不许盖掉主人的显式选择');
    assert.ok(warns.some(w => /PANGU_MODEL/.test(w) && /k3/.test(w)),
      '偏离钉子必须出声 (不许闷掉): ' + JSON.stringify(warns));
  } finally {
    envOverride.resetPin();
    if (prevRouterPath === undefined) delete process.env.PANGU_MODELS_PATH;
    else process.env.PANGU_MODELS_PATH = prevRouterPath;
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}
  }
});

test('G103g: 接线 —— 启动链真的调了它, 且致命错误在 catch 外面抛', () => {
  const src = fs.readFileSync(path.join(ROOT, 'pangu-single.js'), 'utf8');
  assert.match(src, /require\('\.\/modules\/model_env_override'\)/,
    'pangu-single.js 没引 model_env_override —— 环境变量就没人读');
  assert.match(src, /applyEnvOverride\(_config\)/,
    '启动链里没有 applyEnvOverride —— 配了也不生效');
  // 致命错误必须在「配置初始化 catch」**之外**抛。
  // 在里面抛 ⇒ 被降级成空配置 ⇒ 症状变成「盘古起来了但请求全挂」(2026-10-23 修过的病)。
  const catchIdx = src.indexOf("_config = { llm: { models: [], current_model_id: null } };");
  assert.ok(catchIdx > 0, '没找到配置初始化 catch 的降级分支 —— 守卫自己失效了');
  const fatalIdx = src.indexOf('[model-env] 拒绝启动');
  assert.ok(fatalIdx > catchIdx,
    '致命错误必须在配置初始化的 catch 之外退出, 否则会被降级成空配置 (起来但全挂)');
  const block = src.slice(fatalIdx, fatalIdx + 800);
  assert.match(block, /process\.exit\(1\)/,
    '致命错误必须以非 0 退出码退出 —— 退出码 0 看着像「干净退出」, 没人知道是启动失败');
  assert.doesNotMatch(block, /\bthrow\b/,
    '致命错误不许走 throw —— safe-guard 的 uncaughtException 处理器会「继续」, '
    + '结果退出码 0 + launchd 每重启一次往 issues/ 撒 4 个 crash 文件');
});

test('G103i: 读不到配置文件的模型选择时 ⇒ 钉子仍然不许落盘', () => {
  // 2026-10-26 第 103 批探针实测: 原来 _configForWrite 的 catch 分支
  // 直接 `return _config` —— 内存里是什么就写什么, 而内存里此刻**就是钉子**
  // (applyEnvOverride 把 cfg.llm.current_model_id 改成了钉子)。
  // ⇒ 配置文件被删 / JSON 坏了的时候, 一次 saveConfig 就把钉子写进了文件,
  //    「撤销钉子」变成「手改文件」—— 铁律② 破了。
 const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-model-env-io-'));
 const cfgPath = path.join(sandbox, 'node.json');
 const routerModelsPath = path.join(sandbox, 'router-models.json');
 const prevRouterPath = process.env.PANGU_MODELS_PATH;
 process.env.PANGU_MODELS_PATH = routerModelsPath;
 fs.writeFileSync(routerModelsPath, JSON.stringify({ models: [] }), 'utf8');

 const helpers = require(path.join(ROOT, 'modules', 'pangu_helpers'));
 try {
   const cfg = _cfg('qwen_qwen3.8-27b');
   envOverride.resetPin();
   const rep = envOverride.applyEnvOverride(cfg, { PANGU_MODEL: 'k3' });
   assert.equal(rep.ok, true);
   assert.equal(cfg.llm.current_model_id, 'k3');

   // 情形一: 配置文件**不存在** (被删了)
   helpers.init({ _config: cfg, CONFIG_PATH: cfgPath, PRESETS: [], safeGuard: {}, fs });
   helpers.saveConfig();
   const written = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
   assert.notEqual(written.llm.current_model_id, 'k3',
     '读不到配置文件时把钉子写进去了 —— 铁律② 破了 (撤销钉子会变成手改文件)');
   assert.equal(written.llm.current_model_id, null,
     '读不到文件 ⇒ 落盘成「文件没指定」(null), 让启动时的 PANGU_MODEL / enabled+priority 兜底');

   // 情形二: 配置文件**JSON 坏了**
   fs.writeFileSync(cfgPath, '{ 这不是 JSON', 'utf8');
   helpers.init({ _config: cfg, CONFIG_PATH: cfgPath, PRESETS: [], safeGuard: {}, fs });
   helpers.saveConfig();
   const written2 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
   assert.notEqual(written2.llm.current_model_id, 'k3',
     '配置文件 JSON 坏了的时候把钉子写进去了 —— 铁律② 破了');
 } finally {
   envOverride.resetPin();
   if (prevRouterPath === undefined) delete process.env.PANGU_MODELS_PATH;
   else process.env.PANGU_MODELS_PATH = prevRouterPath;
   try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}
 }
});

test('G103j: 变异体检必须用共享实现 (加锁 + 从备份还原 + 复验)', () => {
  // 2026-10-26 第 103 批探针实测: 103 守卫原来自己写了一套变异实现 ——
  //   没加锁 ⇒ 和 101/102 同时改同一批源码会互相还原错 (实测把
  //   model_capability.js 的门卫删掉留在生产代码里);
  //   还原用内存 src ⇒ src 本身是别人的变异版时, 还原等于把坏的写回去;
  //   还原后不复验 ⇒ 没还原成功也不知道。
  const src = fs.readFileSync(__filename, 'utf8');
  assert.match(src, /helpers['"],\s*['"]mutation_guard['"]/,
    '103 守卫没用共享的 mutation_guard —— 没加锁的变异实现会互相还原错');
  assert.doesNotMatch(src, /fs\.writeFileSync\(p,\s*src\)/,
    '103 守卫不许用内存 src 还原 —— 还原必须从备份文件来');

  // 残留备份的**位置**也要被链尾的残留检查扫到:
  // 103 守卫改的是 pangu-single.js (在 apps/core 根目录), 旧的 glob 只扫
  // modules/ 和 pangu-single/routes/ ⇒ 扫不到 ⇒ 变异版能留在生产代码里。
  const runner = fs.readFileSync(path.join(ROOT, 'bin', 'run-tests.sh'), 'utf8');
  const globLine = (runner.split('\n').find(l => l.includes('pangu-mut-backup*') && l.includes('for f in')) || '');
  assert.ok(globLine, 'run-tests.sh 里找不到变异残留的检查 glob');
  assert.match(globLine, /^\s*for f in\s+\*\.pangu-mut-backup\*/,
    '残留检查的 glob 必须覆盖 apps/core 根目录 (pangu-single.js 的备份就在那儿)');
});

// ─────────────────────────────────────────────────────────────
// G103h · 变异体检
// ─────────────────────────────────────────────────────────────
const _IS_MUTATION_CHILD = !!process.env.PANGU_MODEL_ENV_103_MUTATION_CHILD;
const _MUT_BACKUP_SUFFIX = '.pangu-mut-backup-env103';

// ⚠️ 变异体检必须用**共享实现** (2026-10-26 第 103 批探针实测):
//   这个文件原来自己写了一套「改源码 → 跑守卫 → finally 写回」:
//     · 没加锁 ⇒ 和 101/102 两个守卫同时改同一批源码时会互相还原错,
//       变异版留在**生产代码**里 (实测留过 model_capability.js 的门卫被删)。
//     · 还原用的是内存里的 src ⇒ src 本身要是别人留下的变异版, 还原等于把坏的写回去。
//     · 还原后不复验 ⇒ 没还原成功也不知道。
//   共享实现 (tests/helpers/mutation_guard.js): 跨进程加锁 + 从**备份文件**还原
//   + 逐字节复验 + 启动时自愈残留备份。
//
// ⚠️ 残留备份的**位置**也要对: 本守卫改的是 pangu-single.js (在 ROOT 根目录),
//   不是 modules/ 也不是 pangu-single/routes/ ⇒ 恢复目录要带上 ROOT 本身。
const _mutationGuard = require(path.join(__dirname, 'helpers', 'mutation_guard'));

function _recoverStaleMutations() {
  _mutationGuard.recoverStaleMutations(
    [path.join(ROOT, 'modules'), ROOT],
    _MUT_BACKUP_SUFFIX
  );
}

if (!_IS_MUTATION_CHILD) _recoverStaleMutations();

function _runGuardExpectingRed() {
  // ⚠️ 必须摘掉 NODE_TEST_CONTEXT (第 98 批 G4 的教训): 被继承时 --test 被忽略 ⇒ 假阴性。
  const childEnv = Object.assign({}, process.env, { PANGU_MODEL_ENV_103_MUTATION_CHILD: '1' });
  delete childEnv.NODE_TEST_CONTEXT;
  // 摘掉 NODE_TEST_CONTEXT 之后, model_registry 就认不出「我是测试进程」⇒ 会往
  // **生产** registry 写。显式给一条沙箱路径, 孙进程的写全部落在临时目录。
  childEnv.PANGU_REGISTRY_PATH = path.join(os.tmpdir(), 'pangu-registry-mut103-' + process.pid + '.json');
  try {
    execFileSync(process.execPath, ['--test', path.join(__dirname, 'model-env-override-20261026.test.js')], {
      cwd: ROOT, stdio: 'pipe', timeout: 120000,
      env: childEnv,
    });
    return null;   // 全绿 = 守卫没咬 = 失败
  } catch (e) {
    return String(e.stdout || '') + String(e.stderr || '');
  }
}

function _mutateAndExpectRed(file, from, to) {
  // 跨进程加锁 + 从备份还原 + 复验 —— 见 tests/helpers/mutation_guard.js 的注释
  _mutationGuard.mutateAndExpectRed({
    root: ROOT,
    file,
    from,
    to,
    suffix: _MUT_BACKUP_SUFFIX,
    runGuard: _runGuardExpectingRed,
  });
}

test('G103h1: 把「环境变量压过配置文件」改回无效 ⇒ 守卫必须报红', () => {
  if (_IS_MUTATION_CHILD) return;
  _mutateAndExpectRed(
    'modules/model_env_override.js',
    '  cfg.llm.current_model_id = r.id;',
    '  cfg.llm.current_model_id = cfg.llm.current_model_id;',
  );
});

test('G103h2: 把「查不到就报错」改回静默退化 ⇒ 守卫必须报红', () => {
  if (_IS_MUTATION_CHILD) return;
  // 这个变异复现的正是 2026-10-14 那个病: 池里没有就悄悄换一个模型跑。
  _mutateAndExpectRed(
    'modules/model_env_override.js',
    '  const hit = models.find(m => m && String(m.id) === requested);',
    '  const hit = models.find(m => m && String(m.id) === requested) || models.find(m => m && m.enabled !== false);',
  );
});

test('G103h3: 把「致命错误在 catch 外抛」改回只报错不抛 ⇒ 守卫必须报红', () => {
  if (_IS_MUTATION_CHILD) return;
  // ⚠️ 变异串必须**唯一**: pangu-single.js 里现在有两处 `process.exit(1)`
  //   (节点配置解析失败 一处 + 本条要改的 model-env 致命错误一处),
  //   而 mutation_guard 用的是 `src.replace(from, to)` —— 只换**第一处**。
  //   变异串写短了就会改到节点配置那一处, 真正的目标根本没被改 ⇒ 守卫全绿 ⇒ 假阴性。
  _mutateAndExpectRed(
    'pangu-single.js',
    "  try { fs.writeSync(2, _msg); } catch (_) { console.error(_msg); }\n  process.exit(1);",
    "  try { fs.writeSync(2, _msg); } catch (_) { console.error(_msg); }\n  /* 变异: 退出码 0 = 看着像干净退出 */ process.exit(0);",
  );
});
