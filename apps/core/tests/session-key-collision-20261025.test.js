'use strict';
/**
 * 第 92 批 —— session id → 落盘文件名的唯一真源 (session_key.js)
 *
 * ## 现场 (2026-10-25, 实跑不是推理)
 *
 * 原来有**十一份**自己抄的清洗, 规则还不完全一样
 * (有的留 '-' 有的留 '.' 有的截 80 有的截 60 有的不截),
 * goal.js 还多一道正则 —— 同一个 sid 在不同账里落到不同文件名。
 *
 * **病一 · 不同 session 互相覆盖**:
 *   sid='!!!' → 清洗成 '___' → 落 ___ .json
 *   sid='@@@' → 清洗成 '___' → **也**落 ___ .json
 *
 * **病二 · goal.js 塌成 'default', 跟真 default 会话串味** (更严重):
 *   goal.js 那道正则要求清洗结果含至少一个字母数字, 不满足就整条塌成 'default',
 *   而 'default' 本身是个**真实存在的 session id**。
 *   实跑 (PANGU_HOME 指到临时目录):
 *     setGoal('default', '目标A') → setGoal('!!!', '目标B')
 *   之后 getGoal('default') 读出来的是 **'目标B'**。
 *   goal 会被注入 system 消息 ⇒ **这不只是账目串味, 是给主人看了别人的目标**。
 *
 * ## 修法: **纯清洗 + 真撞名才用指纹**
 *
 *   1. 默认纯清洗 ⇒ **存量零改名**。
 *      实测 14530 个存量文件, 纯清洗逐字复现, 不一致 0。
 *   2. 只有**真的撞了**才换指纹名。判据是**盘上的事实**:
 *      目标文件里写的 session_id 不是我的。
 *
 * ⚠️ 中途否掉的那条路 (留档, 免得以后有人再走一遍):
 *   「一律加指纹」看着更干净, 实测后果是 18053 个文件里 **9391 个按新名指不到**
 *   ⇒ 盘古读不到自己的历史 (goal 读不到、checkpoint 续不了、budget 归零)
 *   ⇒ 断点续跑直接失效。所以走「零改名 + 真撞名兜底」。
 *
 * ## 判据
 *
 * A. 十一本账**共用同一个模块** —— 源码里不许再有第二份 session id 清洗。
 * B. **真撞名时必须分开**: 两个不同的脏 id 落盘后不许共用一个文件, 且
 *    先写的那份不许被覆盖。 (行为证明, 不是名字推演。)
 * B2. 非法 id 不许跟 default 会话撞。
 * C. **存量零迁移**: 正常 id 的文件名**逐字不变**。
 * C2. **存量全量可达**: 真实账本里每个文件的 session_id 都能解析回它自己的文件名。
 * D. **端到端不串味**: 真跑 goal / checkpoint / budget / tasks, 验证互不顶账。
 * E. 变异体检: 内存编译一份「坏掉的」session_key, 证明守卫会咬。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');

const CORE = path.join(__dirname, '..');
const MODULES = path.join(CORE, 'modules');

const SK_PATH = path.join(MODULES, 'session_key.js');
const sk = require(SK_PATH);

// 全仓按 session id 落盘的地方 (第 92 批逐个查出来的, 一个不漏)
const CALLERS = [
  'budget.js',
  'task_checkpoint.js',
  'plan_state.js',
  'goal.js',
  'checkpoint.js',
  'compaction.js',
  'handoff.js',
  'outcome_tracker.js',
  'peer_message.js',
  'task_ledger.js',
  'session_store.js',
];

// 危险 id 池: 清洗后会撞的 / 会跟 default 撞的 / 各种脏输入
const DANGEROUS = [
  '!!!', '@@@', '###', '___', '---', '...',
  'default', '', '   ', '\t\t',
  '会话#1', '!!!1', '@!1', '会话1', 'A#1',
  'abc!', 'a!b!c', '!会话', 'x!',
  '!!!A', 'A!!!', '#', '@', '_', '-', ' ',
  '!!', '@@', '##', 'xx!',
  'a'.repeat(200),
];

// **真实场景** (2026-10-25 实跑出来的, 不是构造的):
//   两个不同父会话, 各自派了同编号同角色的子 agent
//   sid = parentId + '#sub-' + n + '-' + role
// 清洗后两个 sid **完全相同** ⇒ 旧代码下两个子 agent 共用同一个 checkpoint 文件,
// 实测 A 读到了 B 的完整对话 (含 B 的上下文)。
const REAL_COLLIDE_PAIR = ['probe!!!X#sub-0-li', 'probe@@@X#sub-0-li'];

// ---- 小工具 ------------------------------------------------------------

// 让某个模块在**新的 env 下**重新加载 (目录常量在 require 时就定死了)。
function reloadModule(file, envPatch) {
  const prev = {};
  for (const k of Object.keys(envPatch)) {
    prev[k] = process.env[k];
    if (envPatch[k] === undefined) delete process.env[k];
    else process.env[k] = envPatch[k];
  }
  for (const k of Object.keys(require.cache)) {
    if (k.includes(`${path.sep}modules${path.sep}${file}`)) delete require.cache[k];
  }
  const mod = require(path.join(MODULES, file));
  return {
    mod,
    restore() {
      for (const k of Object.keys(envPatch)) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    },
  };
}

// 造一个「旧规则写的」存量文件: 文件名是清洗后的, 内容里写着原始 sid。
function writeLegacyFile(dir, sid, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(Object.assign({ session_id: sid }, body || {})));
  return file;
}

// ---- A: 唯一真源 --------------------------------------------------------

test('第92批 A: 十一本账共用同一个唯一真源, 没有第二份实现', () => {
  for (const f of CALLERS) {
    const p = path.join(MODULES, f);
    assert.ok(fs.existsSync(p), `${f} 不在了`);
    const src = fs.readFileSync(p, 'utf8');
    // 源码里**不许**再出现自己的 _safeSid 实现。
    assert.ok(
      !/function\s+_safeSid\s*\(/.test(src),
      `${f} 里还有自己的 _safeSid 实现 —— 各写一份就是本批要修的病本身`,
    );
    // 必须 require 唯一真源。
    assert.ok(
      /require\(['"]\.\/session_key['"]\)/.test(src),
      `${f} 没有 require('./session_key') —— 它没接上唯一真源`,
    );
    // 必须真的用它 (调导出的函数), 不是 require 完不用。
    assert.ok(
      /\b(sessionKey|fingerprintKey|sessionKeyCandidates|resolveSessionKey|resolveSessionKeyPrefix)\s*\(/.test(src),
      `${f} require 了 session_key 却没调用它 —— 接了个摆设`,
    );
  }
});

test('第92批 A3: 全仓不再有第二份「session id → 文件名」的清洗', () => {
  // 判据: 除 session_key.js 自己以外, 任何模块都不许再清洗 session id。
  // 排除项要**逐个说明**, 不能笼统排除整个 modules/ 目录。
  //
  // ⚠️ 判据的形状踩过一次坑 (变异体检发现):
  //   原来写成 /replace\(\/\[\^(?:[Aa]-)?[Zz]A-Za-z0-9_-\]\/g/ ——
  //   字符类写漏了 ('[^A-Za-z0-9_-]' 里 A 后面还有 -za-z0-9_-),
  //   注入一份自己的清洗它**匹配不上** ⇒ 这条守卫当时是空枪。
  //   现在改成不拆字符类的形状: /replace\(\/\[\^[^\]]*\]\/g/
  const ALLOWED = new Set([
    // 唯一真源本身。
    'session_key.js',
    // 这两个清洗的是 plugin 名 / tool 名, 不是 session id:
    'plugin_loader.js',
    'tools_sdk.js',
    // 这个清洗的是**环境变量名** ('PANGU_CRED_<NAME>'), 不是 session id:
    'credentials.js',
    // 这个清洗的是**中文答案正文**, 用来把卦辞归一化后查表, 跟文件名/跟 session id 无关:
    'gua_answer_gate.js',
    // 这个清洗的是 **trace 文件的组合名** (<毫秒时间戳>-<agent>-<文件名>),
    //   trace 不是「按 session 分账」的文件 (名字里带毫秒时间戳, 两个会话不可能撞);
    //   其中 session id 那一段已经改成走 session_key 唯一真源了:
    'run_trace.js',
  ]);
  const PATTERN = /replace\(\/\[\^[^\]]*\]\/g/;
  const offenders = [];
  for (const f of fs.readdirSync(MODULES)) {
    if (!f.endsWith('.js')) continue;
    if (ALLOWED.has(f)) continue;
    const src = fs.readFileSync(path.join(MODULES, f), 'utf8');
    if (PATTERN.test(src)) offenders.push(f);
  }
  assert.deepStrictEqual(
    offenders,
    [],
    `这些模块还在自己清洗 session id (各写一份 = 第 92 批要修的病):\n  ${offenders.join('\n  ')}`,
  );
});

test('第92批 A3 变异体检: 塞一份自己的清洗进去, A3 必须红', () => {
  // 证明 A3 不是空枪 —— 它必须真能认出「有人又自己写了一份清洗」。
  const fake = 'const safe = String(sessionId).replace(/[^A-Za-z0-9_-]/g, "_");';
  const PATTERN = /replace\(\/\[\^[^\]]*\]\/g/;
  assert.ok(PATTERN.test(fake), '★ 空枪: 判据连示例都匹配不上 —— A3 根本不咬');
});

// ---- B: 真撞名必须分开 (行为证明) ---------------------------------------

test('第92批 B: 两个不同的脏 id 落盘后不许共用一个文件, 先写的还不许被覆盖', () => {
  // 这是本批的**核心行为**。判据不是「名字长得不一样」(名字本来就一样),
  // 而是: 真写一遍, 看盘上到底是不是两份, 先写的内容还在不在。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-collide-'));
  try {
    const [sidA, sidB] = REAL_COLLIDE_PAIR;
    const plainA = sk.sessionKey(sidA);
    const plainB = sk.sessionKey(sidB);
    assert.strictEqual(
      plainA,
      plainB,
      '前提确认: 这两个 sid 清洗后同名 (所以才需要真源来兜底)',
    );

    // A 先写 —— 落在纯清洗名下。
    writeLegacyFile(dir, sidA, plainA + '.json', { tag: 'A' });
    // B 再解析 ⇒ 必须换名字 (不能跟 A 共用)。
    const keyB = sk.resolveSessionKey(dir, sidB, { ext: '.json' });
    assert.notStrictEqual(
      keyB,
      plainB,
      `★ B 解析到了 ${keyB} —— 跟 A 同一个文件 ⇒ 后写的覆盖先写的 (会话串味)`,
    );
    // A 自己解析回来还是原来那个文件 (不能因为 B 来了就搬家)。
    assert.strictEqual(
      sk.resolveSessionKey(dir, sidA, { ext: '.json' }),
      plainA,
      '★ A 的文件名被改了 —— 自己都找不到自己的账',
    );
    // 先写的那份内容没被动过。
    const kept = JSON.parse(fs.readFileSync(path.join(dir, plainA + '.json'), 'utf8'));
    assert.strictEqual(kept.session_id, sidA, '★ 先写的那份被覆盖了');

    // 反过来 (B 先写) 也一样。
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-collide2-'));
    try {
      writeLegacyFile(dir2, sidB, plainB + '.json', { tag: 'B' });
      const keyA = sk.resolveSessionKey(dir2, sidA, { ext: '.json' });
      assert.notStrictEqual(keyA, plainB, '★ 顺序反过来也撞了');
      assert.strictEqual(
        JSON.parse(fs.readFileSync(path.join(dir2, plainB + '.json'), 'utf8')).session_id,
        sidB,
        '★ 先写的那份被覆盖了',
      );
    } finally {
      try { fs.rmSync(dir2, { recursive: true, force: true }); } catch (_) {}
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('第92批 B2: 非法 id 不许跟 default 会话撞', () => {
  // 这是 goal.js 原来那个病 (病二) 的直接判据。
  const defaultKey = sk.sessionKey('default');
  for (const id of DANGEROUS) {
    if (id === 'default') continue;
    if (id === '') continue; // 空 id 本来就是 default (旧行为一致)
    const key = sk.sessionKey(id);
    assert.notStrictEqual(
      key,
      defaultKey,
      `${JSON.stringify(id)} 落到了 ${key} —— 跟真 default 会话撞了 (goal 会串味)`,
    );
  }
});

// ---- C: 存量零迁移 ------------------------------------------------------

test('第92批 C: 正常 id 的文件名逐字不变 (存量零迁移)', () => {
  // 从真实账本取样本 —— 判据只认**实际存在过的文件名**。
  const realNames = new Set();
  for (const dir of ['budget', 'plans', 'tasks', 'goals']) {
    const d = path.join(os.homedir(), '.pangu', 'state', dir);
    try {
      for (const f of fs.readdirSync(d)) {
        if (!f.endsWith('.json')) continue;
        const n = f.slice(0, -5);
        // 只取「本来就干净的」那些 (清洗会改动的不算, 它们本来就不该原样落盘)
        if (/^[A-Za-z0-9_-]{1,80}$/.test(n)) realNames.add(n);
      }
    } catch (_) { /* 目录不存在就跳过 */ }
  }
  // 兜底样本 (读不到真实账本时也要能验)
  for (const n of [
    'b60-live-20261023', 'desktop-1792407402764', '94196419_sub-0-executor',
    'b12-he-e2e2_sub-1-kun', 'probe92b-local_sub-0-li', 'default',
  ]) realNames.add(n);

  assert.ok(realNames.size > 0, '一个样本都没取到 —— 这条守卫会变成空枪');
  for (const n of realNames) {
    assert.strictEqual(
      sk.sessionKey(n),
      n,
      `正常 session id ${JSON.stringify(n)} 的文件名被改了 ⇒ 存量账本迁不动 (旧文件读不到)`,
    );
  }
});

test('第92批 C2: 真实账本里每个文件的 session_id 都解析得回它自己的文件名 (零失联)', () => {
  // 这是本批**最要紧**的一条 —— 中途那版「一律加指纹」的改法,
  // 实测让 18053 个文件里 9391 个按新名指不到 ⇒ 断点续跑直接失效。
  // 现在锁死: 谁的名字解析不出它自己, 这条就红。
  const HOME = os.homedir();
  const dirs = [
    [path.join(HOME, '.pangu', 'state', 'budget'), '.json'],
    [path.join(HOME, '.pangu', 'state', 'tasks'), '.json'],
    [path.join(HOME, '.pangu', 'state', 'plans'), '.json'],
    [path.join(HOME, '.pangu', 'state', 'goals'), '.json'],
    [path.join(HOME, '.pangu', 'state', 'handoff'), '.json'],
    [path.join(HOME, '.pangu', 'state', 'ledger'), '.json'],
    [path.join(HOME, '.pangu-data', 'sessions'), '.json'],
    [path.join(HOME, '.pangu', 'state', 'outcomes'), '.jsonl'],
    [path.join(HOME, '.pangu', 'state', 'peer'), '.jsonl'],
  ];
  let checked = 0;
  const orphans = [];
  for (const [dir, ext] of dirs) {
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith(ext)); } catch (_) { continue; }
    for (const f of files) {
      let sid = null;
      try {
        const raw = fs.readFileSync(path.join(dir, f), 'utf8');
        if (ext === '.jsonl') {
          const line = raw.split('\n').find(x => x.trim());
          sid = line ? (JSON.parse(line).session_id || null) : null;
        } else {
          const j = JSON.parse(raw);
          sid = j.session_id || j.sessionId || null;
        }
      } catch (_) { continue; }
      if (!sid) continue;
      checked++;
      const key = sk.resolveSessionKey(dir, sid, { ext });
      if (key + ext !== f) orphans.push(`${f}  (sid=${sid}) ⇒ 解析成 ${key}`);
    }
  }
  assert.ok(checked > 0, '一个存量文件都没读到 —— 这条守卫会变成空枪');
  assert.deepStrictEqual(
    orphans.slice(0, 10),
    [],
    `存量文件按 session id 解析不回来 (共 ${orphans.length} 个) ⇒ 盘古读不到自己的历史:\n  ${orphans.slice(0, 10).join('\n  ')}`,
  );
});

test('第92批 C3: 合成的「旧规则存量」也必须解析得回 (判据不靠本机有没有历史)', () => {
  // 真机没有历史账本时 (新克隆的机器), C2 会读不到东西 ⇒ 那条会空枪。
  // 这条用合成的存量样本兜底: 文件名是旧规则 (清洗) 出来的, 内容写着原始 sid。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-legacy-'));
  try {
    const samples = [
      ['94196419#sub-0-executor', '94196419_sub-0-executor.json'],
      ['cli-regress', 'cli-regress.json'],
      ['probe92b-local#sub-1-li', 'probe92b-local_sub-1-li.json'],
      ['default', 'default.json'],
    ];
    for (const [sid, name] of samples) writeLegacyFile(dir, sid, name, { tag: sid });
    for (const [sid, name] of samples) {
      const key = sk.resolveSessionKey(dir, sid, { ext: '.json' });
      assert.strictEqual(
        key + '.json',
        name,
        `存量文件 ${name} (sid=${sid}) 解析成了 ${key} —— 改名会让它失联`,
      );
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

// ---- D: 端到端不串味 ----------------------------------------------------

test('第92批 D: 端到端 —— goal 的两笔账不许互相顶掉 (真跑)', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-goal-'));
  const r = reloadModule('goal.js', { PANGU_HOME: tmpHome });
  try {
    const goal = r.mod;
    goal.setGoal('default', '目标A: 真 default 会话的目标');
    goal.setGoal('!!!', '目标B: 非法 id 会话的目标');

    const a = goal.getGoal('default');
    const b = goal.getGoal('!!!');

    assert.ok(a && b, '两笔 goal 都该读得到');
    assert.strictEqual(
      String(a.text || ''),
      '目标A: 真 default 会话的目标',
      `★ default 会话的目标被顶掉了, 现在是: ${String(a.text || '')} —— 这就是会话串味`,
    );
    assert.strictEqual(
      String(b.text || ''),
      '目标B: 非法 id 会话的目标',
      `非法 id 会话读不到自己的目标: ${String(b.text || '')}`,
    );
  } finally {
    r.restore();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_) {}
  }
});

test('第92批 D2: 端到端 —— 两个父会话的子 agent 不许共用 checkpoint (真跑)', () => {
  // 这是本批**最严重**的一档: checkpoint 里存的是完整会话历史。
  // 撞名 ⇒ A 会话读回 B 会话的对话 ⇒ 断点续跑接着别人的上下文跑。
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-ck-'));
  const r = reloadModule('checkpoint.js', { PANGU_CHECKPOINT_DIR: tmpDir });
  try {
    const ck = r.mod;
    const [sidA, sidB] = REAL_COLLIDE_PAIR;
    ck.saveCheckpoint(sidA, { round: 3, messages: [{ role: 'user', content: 'A 的上下文, 秘密=ALPHA' }] });
    ck.saveCheckpoint(sidB, { round: 3, messages: [{ role: 'user', content: 'B 的上下文, 秘密=BRAVO' }] });

    const files = fs.readdirSync(tmpDir);
    assert.strictEqual(
      files.length,
      2,
      `两个不同父会话的子 agent 落到了 ${files.length} 个文件 (应 2 个): ${JSON.stringify(files)}`,
    );

    const a = ck.loadLatestCheckpoint(sidA);
    const b = ck.loadLatestCheckpoint(sidB);
    assert.ok(a && b, '两个 checkpoint 都该读得到');
    assert.ok(
      !String(a.messages[0].content).includes('BRAVO'),
      `★ A 会话读到了 B 的上下文: ${String(a.messages[0].content)} —— 会话串味`,
    );
    assert.ok(
      !String(b.messages[0].content).includes('ALPHA'),
      `★ B 会话读到了 A 的上下文: ${String(b.messages[0].content)} —— 会话串味`,
    );
    assert.ok(
      String(a.messages[0].content).includes('ALPHA'),
      'A 读不到自己的上下文 —— 修法过头了 (该读自己的读不到)',
    );
  } finally {
    r.restore();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('第92批 D3: 其余每一本账也都要各写各的 (真跑, 逐个模块)', () => {
  // D2 只证了 checkpoint 一本, D 只证了 goal 一本。
  // 这里把会落盘的账本挨个跑一遍: 两个同名脏 id 各写一次 ⇒ 盘上必须是两份, 且互不顶账。
  const [sidA, sidB] = REAL_COLLIDE_PAIR;
  const cases = [
    {
      file: 'budget.js',
      env: (home) => ({ PANGU_BUDGET_DIR: path.join(home, 'budget') }),
      dir: (home) => path.join(home, 'budget'),
      write: (m, sid) => m.recordRound(sid, sid.includes('!!!') ? 10 : 20),
      extract: (file) => String(JSON.parse(fs.readFileSync(file, 'utf8')).tokens),
      expectA: '10',
      expectB: '20',
    },
    {
      file: 'task_checkpoint.js',
      env: (home) => ({ PANGU_TASK_DIR: path.join(home, 'tasks') }),
      dir: (home) => path.join(home, 'tasks'),
      write: (m, sid) => m.saveTaskCheckpoint(sid, { next_action: sid.includes('!!!') ? 'A 的下一步' : 'B 的下一步' }),
      extract: (file) => String(JSON.parse(fs.readFileSync(file, 'utf8')).next_action),
      expectA: 'A 的下一步',
      expectB: 'B 的下一步',
    },
    {
      file: 'plan_state.js',
      env: (home) => ({ PANGU_PLAN_DIR: path.join(home, 'plans') }),
      dir: (home) => path.join(home, 'plans'),
      write: (m, sid) => m.setPlan(sid, { goal: sid.includes('!!!') ? 'A 的目标' : 'B 的目标', steps: [] }),
      extract: (file) => String(JSON.parse(fs.readFileSync(file, 'utf8')).goal),
      expectA: 'A 的目标',
      expectB: 'B 的目标',
    },
    {
      file: 'handoff.js',
      env: (home) => ({ PANGU_HANDOFF_DIR: path.join(home, 'handoff') }),
      dir: (home) => path.join(home, 'handoff'),
      write: (m, sid) => m.writeHandoff(sid, { reason: sid.includes('!!!') ? 'silent_fail' : 'timeout', rounds: 1, inputTokens: 0 }),
      extract: (file) => String(JSON.parse(fs.readFileSync(file, 'utf8')).reason),
      expectA: 'silent_fail',
      expectB: 'timeout',
    },
    {
      file: 'outcome_tracker.js',
      env: (home) => ({ PANGU_OUTCOMES_DIR: path.join(home, 'outcomes') }),
      dir: (home) => path.join(home, 'outcomes'),
      write: (m, sid) => m.recordOutcome(sid, { status: sid.includes('!!!') ? 'completed' : 'failed', artifacts: [] }),
      extract: (file) => {
        const line = fs.readFileSync(file, 'utf8').split('\n').find(x => x.trim());
        return String(JSON.parse(line).status);
      },
      expectA: 'completed',
      expectB: 'failed',
    },
    {
      file: 'peer_message.js',
      env: (home) => ({ PANGU_HOME: home }),
      dir: (home) => path.join(home, 'state', 'peer'),
      write: (m, sid) => m.send(sid, { content: sid.includes('!!!') ? 'A 的消息' : 'B 的消息' }),
      extract: (file) => {
        const line = fs.readFileSync(file, 'utf8').split('\n').find(x => x.trim());
        return String(JSON.parse(line).content);
      },
      expectA: 'A 的消息',
      expectB: 'B 的消息',
    },
    {
      file: 'task_ledger.js',
      // 2026-10-26 第 100 批: 账本目录的**唯一真源**是 modules/state_paths.js,
      // 解析顺序 PANGU_LEDGER_DIR > PANGU_HOME/state/ledger > 生产默认。
      // 只设 PANGU_HOME 会被链沙箱里的 PANGU_LEDGER_DIR 抢在前面 ⇒ 账本落到别处。
      env: (home) => ({ PANGU_HOME: home, PANGU_LEDGER_DIR: path.join(home, 'state', 'ledger') }),
      dir: (home) => path.join(home, 'state', 'ledger'),
      write: (m, sid) => m.saveLedger(sid, { goal: sid.includes('!!!') ? 'A 的目标' : 'B 的目标' }),
      extract: (file) => String(JSON.parse(fs.readFileSync(file, 'utf8')).goal),
      expectA: 'A 的目标',
      expectB: 'B 的目标',
    },
  ];

  for (const c of cases) {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-d3-'));
    const r = reloadModule(c.file, c.env(tmpHome));
    try {
      const dir = c.dir(tmpHome);
      c.write(r.mod, sidA);   // A 先写 ⇒ 拿纯清洗名
      c.write(r.mod, sidB);   // B 后写 ⇒ 真撞名 ⇒ 换指纹名
      const files = fs.readdirSync(dir);
      assert.strictEqual(
        files.length,
        2,
        `${c.file}: 两个同名脏 id 落到了 ${files.length} 个文件 (应 2 个): ${JSON.stringify(files)}`,
      );
      const aName = sk.sessionKey(sidA) + (c.file === 'outcome_tracker.js' || c.file === 'peer_message.js' ? '.jsonl' : '.json');
      const bName = files.find(f => f !== aName);
      assert.ok(bName, `${c.file}: 找不到第二份文件: ${JSON.stringify(files)}`);
      assert.strictEqual(
        c.extract(path.join(dir, aName)),
        c.expectA,
        `${c.file}: 先写的 A 那份被顶掉了`,
      );
      assert.strictEqual(
        c.extract(path.join(dir, bName)),
        c.expectB,
        `${c.file}: B 那份读错了`,
      );
    } finally {
      r.restore();
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_) {}
    }
  }
});

test('第92批 D4: session_store —— 父会话与它的子 agent 不许共用一个会话文件 (真跑)', async () => {
  // 这一对是**线上真会发生的**: 子 agent 的 sid 恒为 `父会话#sub-N-role`,
  // 所以 'parent#sub-0-li' (子) 与 'parent_sub-0-li' (另一个真会话) 清洗后同名。
  // session_store 的 validateSessionId 放行 '#' ⇒ 这两个都合法。
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-d4-'));
  const r = reloadModule('session_store.js', {
    PANGU_SESSIONS_DIR: path.join(tmpHome, 'sessions'),
    PANGU_AGENTDB_DIR: path.join(tmpHome, 'agentdb'),
  });
  try {
    const m = r.mod;
    const child = 'parent#sub-0-li';
    const other = 'parent_sub-0-li';
    assert.strictEqual(
      sk.sessionKey(child),
      sk.sessionKey(other),
      '前提确认: 这两个合法 sid 清洗后同名',
    );
    const [ra, rb] = await Promise.all([
      m.sessionSave({ session_id: child, messages: [{ role: 'user', content: '子 agent 的对话' }] }),
      m.sessionSave({ session_id: other, messages: [{ role: 'user', content: '另一个会话的对话' }] }),
    ]);
    assert.ok(ra && ra.ok, `子 agent 的会话没存上: ${JSON.stringify((ra && ra.error) || {})}`);
    assert.ok(rb && rb.ok, `另一个会话没存上: ${JSON.stringify((rb && rb.error) || {})}`);
    const files = fs.readdirSync(path.join(tmpHome, 'sessions'));
    assert.strictEqual(
      files.length,
      2,
      `两个 sid 落到了 ${files.length} 个文件 (应 2 个): ${JSON.stringify(files)}`,
    );
    for (const f of files) {
      const body = fs.readFileSync(path.join(tmpHome, 'sessions', f), 'utf8');
      assert.ok(
        !(body.includes('子 agent 的对话') && body.includes('另一个会话的对话')),
        `★ 一个会话文件里混进了两个会话的对话: ${f} —— 会话串味`,
      );
    }
  } finally {
    r.restore();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_) {}
  }
});

// ---- E: 变异体检 --------------------------------------------------------

test('第92批 E: 变异体检 —— 把真源改坏, 守卫必须红', () => {
  const src = fs.readFileSync(SK_PATH, 'utf8');

  // 变异一: 去掉「归属判定」⇒ 一律用纯清洗名 ⇒ 撞名的两个 id 共用一个文件。
  const m1 = src.replace(
    "  // ★ 真撞名: 这个文件是别人的 ⇒ 用指纹名另起一份, 不覆盖它。\n  return fp;",
    "  return plain; // 变异: 不判归属了",
  );
  assert.notStrictEqual(m1, src, '★ 变异一没打上 —— 源码形状变了, 变异体检作废 (空枪)');

  // 变异二: 一律加指纹 ⇒ 存量全部改名 ⇒ 失联。
  const m2 = src.replace(
    "function sessionKey(sid, maxLen) {\n  const _max = Number.isFinite(maxLen) && maxLen > 0 ? Math.floor(maxLen) : 80;\n  return _clean(_effective(sid), _max) || 'default';\n}",
    "function sessionKey(sid, maxLen) {\n  const _max = Number.isFinite(maxLen) && maxLen > 0 ? Math.floor(maxLen) : 80;\n  const raw = _effective(sid);\n  return (_clean(raw, _max) + '-' + _fingerprint(raw)) || 'default';\n}",
  );
  assert.notStrictEqual(m2, src, '★ 变异二没打上 —— 源码形状变了, 变异体检作废 (空枪)');

  const compile = (code, tag) => {
    const m = new Module(SK_PATH + '#' + tag, null);
    m.filename = SK_PATH + '#' + tag;
    m.paths = Module._nodeModulePaths(MODULES);
    m._compile(code, SK_PATH + '#' + tag);
    return m.exports;
  };

  // 变异一在 B 组判据上必须红 (撞名的两个 id 必须分开)。
  const broken1 = compile(m1, 'broken1');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-mut-'));
  try {
    const [sidA, sidB] = REAL_COLLIDE_PAIR;
    writeLegacyFile(dir, sidA, broken1.sessionKey(sidA) + '.json', { tag: 'A' });
    const keyB = broken1.resolveSessionKey(dir, sidB, { ext: '.json' });
    assert.strictEqual(
      keyB,
      broken1.sessionKey(sidB),
      '★ 空枪: 去掉归属判定后 B 并没有跟 A 撞 —— B 组判据没在判这件事',
    );
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }

  // 变异二在 C2/C3 组判据上必须红 (存量全部失联)。
  const broken2 = compile(m2, 'broken2');
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-mut2-'));
  try {
    writeLegacyFile(dir2, '94196419#sub-0-executor', '94196419_sub-0-executor.json', { tag: 'x' });
    const key = broken2.resolveSessionKey(dir2, '94196419#sub-0-executor', { ext: '.json' });
    assert.notStrictEqual(
      key,
      '94196419_sub-0-executor',
      '★ 空枪: 一律加指纹后存量竟然还解析得回 —— C2/C3 组判据没在判失联',
    );
  } finally {
    try { fs.rmSync(dir2, { recursive: true, force: true }); } catch (_) {}
  }
});

// ---- F: 存量命中 + 新写的仍写原名 (零迁移) ------------------------------

test('第92批 F: 存量文件按原名命中, 新写的仍写在原名下 (零迁移)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-legacy-ck-'));
  const r = reloadModule('checkpoint.js', { PANGU_CHECKPOINT_DIR: tmpDir });
  try {
    const ck = r.mod;
    const sid = '94196419#sub-0-executor';
    const legacyName = '94196419_sub-0-executor';
    // 造一个「旧规则写的」存量文件
    writeLegacyFile(tmpDir, sid, `${legacyName}_r2.json`, {
      round: 2,
      messages: [{ role: 'user', content: '存量上下文' }],
    });

    const got = ck.loadLatestCheckpoint(sid);
    assert.ok(got, '存量 checkpoint 读不到了 —— 断点续跑会失效');
    assert.strictEqual(
      String(got.messages[0].content),
      '存量上下文',
      '存量 checkpoint 内容不对',
    );
    assert.strictEqual(got._path, `${legacyName}_r2.json`, '存量文件应当按原名命中');

    // 新写的**继续写在原名下** (不改名 ⇒ 不产生第二个文件前缀)。
    ck.saveCheckpoint(sid, { round: 3, messages: [{ role: 'user', content: '新写的上下文' }] });
    const files = fs.readdirSync(tmpDir);
    assert.strictEqual(
      files.length,
      2,
      `新写后应有两份 (r2 + r3, 同一个文件名前缀), 实际: ${JSON.stringify(files)}`,
    );
    assert.ok(
      files.every(f => f.startsWith(legacyName + '_r')),
      `新写的落到了别的文件名下: ${JSON.stringify(files)} ⇒ 存量与新增对不上号`,
    );
    const newest = ck.loadLatestCheckpoint(sid);
    assert.strictEqual(String(newest.messages[0].content), '新写的上下文', '新写的 checkpoint 读不到');
  } finally {
    r.restore();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});
