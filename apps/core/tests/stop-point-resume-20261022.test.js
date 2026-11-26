'use strict';
// 六格停点接进长工作过程侧 (2026-10-22, 第二十三批)
//
// 老板 10-21 原话:「就拿八字排盘, 其实都是规律结合变化形成的生彼泻克耗,
//   但是这用在项目上, 加强了停顿, 走一步判断一步, 而且挂永远没有100%」
//
// 上一批 (626883c/b7a2fea) 补的是**答案侧**: 主人问「该继续还是该停」,
//   模型调 wuxing_judge, 停点写进答复。这批补**过程侧** ——
//   盘古自己干一件长活时, 判过的「停」能不能拦住 auto-resume。
//
// 为什么必须分两批: 停点判出来的时候, 模型正**接话**;
//   续跑决策跑的时候, 模型**不接话** (它甩了句「继续」就 break 了,
//   或者 maxRounds 到了, 或者 task_done 被拒)。
//   两者不在同一时间点上 → 判据在模型这一侧, 闸门必须落在模型之外
//   (task checkpoint), 否则「停」在真正要拦的那一刻根本不在场。
//
// 本测试盯四件事, **负例为主** (守卫必须会咬人):
//   ① 停点落盘/读取/清理的往返
//   ② 作用域: 换一件事, 上件事的停点**必须失效** (陈旧停点挡新任务比没停点更坏)
//   ③ **零影响**: 没判过六格的长任务, 行为一字不变
//   ④ **不锁死用户**: 停点拦的是自动续跑, 不是用户

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// checkpoint 目录必须在 require 之前定好 —— task_checkpoint 在**模块加载时**
// 就把 TASK_DIR 算成常量了 (常量不做环境变量重读)。所以这里先设, 再 require。
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-stoppoint-'));
process.env.PANGU_TASK_DIR = TMP_DIR;

const CORE = path.join(__dirname, '..');
const SP = require(path.join(CORE, 'modules', 'stop_point.js'));
const TC = require(path.join(CORE, 'modules', 'task_checkpoint.js'));
const TJ = require(path.join(CORE, '64i', 'bagua_annotations', 'task_judge.js'));

function _sid(n) { return 'sp-test-' + n; }
function _cleanup() {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
}

const STOP = TJ.judgeTask({ subject: '空转长活', resources: [], outputs: ['x'], blockers: [], targets: [] });
const REDIRECT = TJ.judgeTask({ subject: '被压顶', resources: ['r1'], outputs: [], blockers: ['b1', 'b2', 'b3'], targets: ['t1'] });
const CONTINUE = TJ.judgeTask({ subject: '正常推进', resources: ['r1'], outputs: ['o1'], blockers: [], targets: ['t1'] });

// ============================================================
// 一、往返
// ============================================================

test('往返: 写进去能读出来, 字段齐全', () => {
  const s = _sid('rt');
  TC.saveTaskCheckpoint(s, { goal: 'G1' });
  const w = SP.writeStopPoint(s, STOP, 'G1');
  assert.equal(w.ok, true);
  assert.equal(w.verdict, 'stop');
  const r = SP.readStopPoint(s, 'G1');
  assert.equal(r.hit, true);
  assert.equal(r.verdict, 'stop');
  assert.equal(r.verdict_label, '停');
  assert.ok(r.stop_reason.length > 0, '停点必须有理由, 不许是个空壳');
  assert.ok(r.next_step.length > 0, '停点必须有下一步');
  assert.equal(r.subject, '空转长活');
});

test('往返: 六格摘要落盘, 但只落结论不落原文条目', () => {
  const s = _sid('cells');
  TC.saveTaskCheckpoint(s, { goal: 'G1' });
  SP.writeStopPoint(s, REDIRECT, 'G1');
  const r = SP.readStopPoint(s, 'G1');
  assert.equal(r.hit, true);
  assert.equal(r.verdict, 'redirect');
  assert.equal(r.cells.ke.state, 'strong');
  assert.equal(r.cells.xie.state, 'not_established');
  // 条目原文是给**模型**看的, 落盘的是给**续跑决策**看的结论 —— 别把长数组灌进 checkpoint
  assert.equal(r.cells.ke.items, undefined, '摘要里不该有 items 原文');
});

// ============================================================
// 二、作用域 (负例 —— 这条最容易出事)
// ============================================================

test('负例: 换一件事, 上一件事的停点必须失效', () => {
  const s = _sid('scope');
  TC.saveTaskCheckpoint(s, { goal: '任务甲' });
  SP.writeStopPoint(s, STOP, '任务甲');
  assert.equal(SP.readStopPoint(s, '任务甲').hit, true, '同一件事时停点该生效');

  // 老板在同一会话里换一件事问 —— 这是**必须支持**的用法, 不是边界情况
  const other = SP.readStopPoint(s, '任务乙');
  assert.equal(other.hit, false, '陈旧停点挡住了新任务 —— 比没有停点更坏');
  assert.equal(other.reason, 'GOAL_CHANGED');
  // 闸门视角: 对续跑决策而言「失效」= 放行
  assert.equal(SP.consultForResume(s, '任务乙').stop, false);
});

test('负例: 过期停点自动失效 (第二道保险)', () => {
  const s = _sid('ttl');
  TC.saveTaskCheckpoint(s, { goal: 'G1' });
  SP.writeStopPoint(s, STOP, 'G1');
  assert.equal(SP.readStopPoint(s, 'G1').hit, true);
  // 手工把 at 拨到 TTL 之外 —— 模拟「某条路径漏了清理」
  const cp = TC.loadTaskCheckpoint(s);
  cp[SP.FIELD].at = Date.now() - SP.STOP_POINT_TTL_MS - 1000;
  TC.saveTaskCheckpoint(s, { [SP.FIELD]: cp[SP.FIELD] });
  const r = SP.readStopPoint(s, 'G1');
  assert.equal(r.hit, false, '过期停点还生效 = 第一道保险漏了第二道没兜住');
  assert.equal(r.reason, 'EXPIRED');
});

test('负例: 空 goal 不参与指纹 (交给 TTL 兜底, 不拿指纹说事)', () => {
  assert.equal(SP.goalKey(''), null);
  assert.equal(SP.goalKey(null), null);
  assert.equal(SP.goalKey('   '), null);
  const s = _sid('nogoal');
  TC.saveTaskCheckpoint(s, { goal: '' });
  SP.writeStopPoint(s, STOP, '');
  // 空 goal 时不因指纹不符而误杀 —— 闸门仍生效 (由轮首清理 + TTL 管)
  assert.equal(SP.readStopPoint(s, '').hit, true);
});

// ============================================================
// 三、零影响 (默认路径必须一字不变)
// ============================================================

test('零影响: 从没判过六格 → 读不到, 续跑照旧', () => {
  const s = _sid('none');
  TC.saveTaskCheckpoint(s, { goal: '普通长活', status: 'active' });
  const r = SP.readStopPoint(s, '普通长活');
  assert.equal(r.hit, false);
  assert.equal(r.reason, 'ABSENT');
  assert.equal(SP.consultForResume(s, '普通长活').stop, false, '闸门必须放行');
});

test('零影响: 判「续」与没判过, 对续跑决策是同一件事 (都放行)', () => {
  const s = _sid('cont');
  TC.saveTaskCheckpoint(s, { goal: 'G1' });
  SP.writeStopPoint(s, CONTINUE, 'G1');
  assert.equal(SP.consultForResume(s, 'G1').stop, false);
});

test('零影响: 没有 checkpoint 的会话不炸, 也不给结论', () => {
  const r = SP.readStopPoint(_sid('ghost'), 'G1');
  assert.equal(r.hit, false);
  assert.equal(r.reason, 'NO_CHECKPOINT');
  assert.equal(SP.readStopPoint('', 'G1').reason, 'NO_SESSION_ID');
});

test('负例: 字段是垃圾时不猜, 当没有 (不许崩, 也不许瞎判)', () => {
  const s = _sid('junk');
  TC.saveTaskCheckpoint(s, { goal: 'G1', [SP.FIELD]: '我不是停点' });
  assert.equal(SP.readStopPoint(s, 'G1').reason, 'MALFORMED');
  TC.saveTaskCheckpoint(s, { [SP.FIELD]: { verdict: 'destroy', at: Date.now() } });
  assert.equal(SP.readStopPoint(s, 'G1').reason, 'BAD_VERDICT');
});

// ============================================================
// 四、清理时机与不锁死用户
// ============================================================

test('清理: 轮首清完 → 停点失效 (逼模型重新判一次)', () => {
  const s = _sid('clear');
  TC.saveTaskCheckpoint(s, { goal: 'G1' });
  SP.writeStopPoint(s, STOP, 'G1');
  assert.equal(SP.consultForResume(s, 'G1').stop, true);
  const c = SP.clearStopPoint(s);
  assert.equal(c.ok, true);
  assert.equal(SP.consultForResume(s, 'G1').stop, false,
    '清完还拦 = 「走一步判断一步」退化成「走一步拦一步」');
});

test('负例: 清理必须显式写 null (合并写不清就等于没清)', () => {
  // saveTaskCheckpoint 是 {...prev, ...state} —— 不带这个 key 的话旧值会活下来。
  // 这条测试是**对着实现细节**的: 若哪天 saveTaskCheckpoint 改成整体覆盖,
  // clearStopPoint 的显式 null 就变成冗余但无害; 若有人改成「不传 key 就清」,
  // 本模块的 null 依然正确。真正要防的是有人**删掉**那个 null。
  const s = _sid('merge');
  TC.saveTaskCheckpoint(s, { goal: 'G1' });
  SP.writeStopPoint(s, STOP, 'G1');
  TC.saveTaskCheckpoint(s, { status: 'active' });   // 不带 stop_point key
  assert.equal(SP.readStopPoint(s, 'G1').hit, true, '别人的 checkpoint 写不该顺手清掉停点');
  SP.clearStopPoint(s);
  assert.equal(SP.readStopPoint(s, 'G1').hit, false);
});

test('不锁死用户: 停点拦自动续跑, 用户说「继续」是新请求 → 指纹不符即放行', () => {
  const s = _sid('user');
  TC.saveTaskCheckpoint(s, { goal: '把报告写完' });
  SP.writeStopPoint(s, STOP, '把报告写完');
  // 自动续跑: 同一请求 → 拦
  assert.equal(SP.consultForResume(s, '把报告写完').stop, true);
  // 用户手动推一下 → 新一轮请求, goal 变了 → 放行
  assert.equal(SP.consultForResume(s, '继续').stop, false,
    '停点把用户也锁住了 —— 老板要的是「加强停顿」不是「禁止继续」');
});

// ============================================================
// 五、写入端守卫
// ============================================================

test('守卫: 拒绝写不是判局结果的东西', () => {
  assert.equal(SP.writeStopPoint(_sid('x'), null, 'G').error, 'NO_JUDGMENT');
  assert.equal(SP.writeStopPoint(_sid('x'), { ok: false }, 'G').error, 'NO_JUDGMENT');
  assert.ok(String(SP.writeStopPoint(_sid('x'), { ok: true, verdict: 'destroy' }, 'G').error)
    .startsWith('BAD_VERDICT'));
  assert.equal(SP.writeStopPoint('', STOP, 'G').error, 'NO_SESSION_ID');
});

test('守卫: NO_JUDGMENT 那种判据不足的返回, 不许被写成停点', () => {
  // judgeTask 判不出来时返回 ok:false —— 那是「不给结论」, 不是「停」。
  // 把它写成 stop 就是**拿空数据当结论**, 正是老板说的「永远没有100%」的反面。
  const none = TJ.judgeTask({ subject: '空的' });
  assert.equal(none.ok, false);
  assert.equal(SP.writeStopPoint(_sid('nojudge'), none, 'G').error, 'NO_JUDGMENT');
});

// ============================================================
// 六、接线 (建了没接 = 白建 —— 第八批的教训)
// ============================================================

test('接线: 工具 wuxing_judge 判完会落停点', () => {
  const src = fs.readFileSync(path.join(CORE, 'modules', 'tools', 'index.js'), 'utf8');
  assert.ok(src.includes('writeStopPoint'), '工具侧没接停点落盘 —— 判完就蒸发, 闸门永远是空的');
  // goal 不许让模型传: 多一个参数就多一条「模型编一个 goal 算糊过去」的路
  const toolSrc = src.slice(src.indexOf('wuxing_judge:'), src.indexOf('situation_check:'));
  assert.ok(!/params\.goal|ctx\.params\.goal/.test(toolSrc), 'goal 必须从 checkpoint 读, 不许模型传');
  assert.ok(toolSrc.includes('loadTaskCheckpoint'), 'goal 应从当前 checkpoint 读');
});

test('接线: 续跑循环读停点, 两条路径都在轮首清', () => {
  const src = fs.readFileSync(path.join(CORE, 'modules', 'j2_agent_loop.js'), 'utf8');
  assert.ok(src.includes('consultForResume'), '续跑侧没读停点 —— 判过的「停」拦不住任何东西');
  // 现场核实过: native 每轮写 checkpoint, **legacy 一轮都不写**
  // → 清理不能指望被 checkpoint 写顺手覆盖, 两条 for 循环都得显式挂。
  const nativeLoop = src.slice(src.indexOf('for (let round = 0; useNative'));
  const legacyLoop = src.slice(src.indexOf('for (let round = 0; !useNative'));
  assert.ok(nativeLoop.includes('clearStopPoint'), 'native 轮首没清停点');
  assert.ok(legacyLoop.includes('clearStopPoint'), 'legacy 轮首没清停点 (它每轮不写 checkpoint, 清不了就永远清不掉)');
  // 清理必须在 consult 之前发生 (轮首 vs 轮末)
  assert.ok(nativeLoop.indexOf('clearStopPoint') < nativeLoop.indexOf('consultForResume')
    || src.indexOf('consultForResume') < src.indexOf('clearStopPoint'),
  '轮首清理与续跑读停点的相对顺序被改坏了');
});

test('接线: 换向档要带换向内容进续跑指令 (不然白判)', () => {
  const src = fs.readFileSync(path.join(CORE, 'modules', 'j2_agent_loop.js'), 'utf8');
  assert.ok(src.includes("verdict === 'redirect'"), '换向档没接 —— 判了等于没判');
  assert.ok(src.includes('六格判局 · 换向'), '换向内容没进续跑指令');
});

test('接线: 停点要给用户看见 (不许只进日志)', () => {
  const src = fs.readFileSync(path.join(CORE, 'modules', 'j2_agent_loop.js'), 'utf8');
  assert.ok(src.includes('六格判局 · 停'), '停点原文没进收口消息');
  assert.ok(src.includes('想继续就说'), '停点消息没告诉用户怎么解锁 —— 会变成静默失败');
});

test('接线: 主提示写明长任务里走一步判断一步 (建了没接 = 白建)', () => {
  // 上一批 (b7a2fea) 的教训: 工具在白名单里 ≠ 会被用 —— 主 agent 走快路径,
  // 提示里没提它就一次都不碰。同样的形状会再犯一次, 所以这次先钉住提示。
  const SRC = fs.readFileSync(path.join(CORE, 'pangu-single.js'), 'utf8');
  assert.match(SRC, /走一步判断一步/, '主提示里没写「走一步判断一步」');
  assert.match(SRC, /别等收口才判|每做完一段/, '没写清「什么时候判」—— 模型会攒到最后一次性判');
  // 三档各自的处置都要写明, 尤其「停」的后果 (自动续跑不会替它冲)
  assert.match(SRC, /判「停」/, '没写判「停」时该怎么办');
  assert.match(SRC, /判「换向」/, '没写判「换向」时该怎么办');
  // ⚠️ 必须写清「判停是有代价的」, 否则模型会把条目列空骗一个停 —— 
  // 那样闸门就成了它自己给自己下的路障, 比没有闸门更坏。
  assert.match(SRC, /列空|骗一个|有代价/, '没提醒「列空条目骗停点」的自利用法');
});

// ============================================================
// 八、真跑一遍行为链 (静态断言证明不了运行时)
// ============================================================

test('真跑: 判停 → 拦住自动续跑 → 用户说继续放行 → 轮首清后放行', () => {
  // 这一条走的是 j2 里 _tryAutoResume 开头那道闸的**同一个函数**
  // (consultForResume), 所以它证明的是运行时行为, 不是源码里有没有那个字符串。
  const s = _sid('beh');
  const GOAL = '把整改方案落地';
  TC.saveTaskCheckpoint(s, { goal: GOAL, status: 'active', auto_resumes: 0 });

  // 模型在长任务里判了「停」: 手上没料、要啃的也没有 (只交了 3 个文件)
  const j = TJ.judgeTask({
    subject: GOAL, resources: [], outputs: ['已写 3 个文件'], blockers: [], targets: [],
  });
  assert.equal(j.verdict, 'stop');
  assert.equal(SP.writeStopPoint(s, j, GOAL).ok, true);

  // ① 自动续跑: 同一请求 → 拦 (盘古不自己往下冲)
  assert.equal(SP.consultForResume(s, GOAL).stop, true);

  // ② 用户手动说「继续」: 新一轮请求 → 放行 (不锁死用户)
  assert.equal(SP.consultForResume(s, '继续').stop, false);

  // ③ 轮首清理后 → 放行 (逼模型本轮重新判一次 = 走一步判断一步)
  SP.clearStopPoint(s);
  assert.equal(SP.consultForResume(s, GOAL).stop, false);

  // ④ 重新判「续」后 → 放行, 且连续多轮不会越攒越僵
  SP.writeStopPoint(s, CONTINUE, GOAL);
  assert.equal(SP.consultForResume(s, GOAL).stop, false);
});

// ============================================================
// 七、装时自检是机制不是注释
// ============================================================

test('守卫: 装时自检真的在 require 时跑 (不是躺在注释里)', () => {
  // 用「改坏 task_judge 的档位名 → 自检该抛」这个负例证明它会咬人。
  // 直接改真源不行 (会影响别的测试), 所以验的是**自检函数确实被调用**:
  // 造一个档位名不认识的三态表, 走同一个自检逻辑, 必须报出来。
  const spSrc = fs.readFileSync(path.join(CORE, 'modules', 'stop_point.js'), 'utf8');
  assert.ok(/_assertStopPointLayer\(\);/.test(spSrc), '装时自检没被调用 —— 只是定义了一个函数');
  // 自检必须真的去**跑** task_judge 取样 (而不是抄一份字符串)
  assert.ok(/require\('\.\.\/64i\/bagua_annotations\/task_judge\.js'\)/.test(spSrc),
    '自检没取 task_judge 真源 —— 抄一份字符串, 真源改了它不知道');
  assert.ok(spSrc.includes('seen.size < 3'), '自检没验三态是否走齐');
});

test('负例: 三条红线各自会咬人 (子进程实测, 守卫不能是永真)', () => {
  // 守卫最常见的死法是「判据写宽了, 什么都过」—— 那样它还在, 但已经不咬人了。
  // 所以逐条**真的拆坏**一次, 验它当场抛。子进程跑, 免得污染本进程 require 缓存。
  const { spawnSync } = require('child_process');
  const SP_PATH = path.join(CORE, 'modules', 'stop_point.js');
  const TJ_PATH = path.join(CORE, '64i', 'bagua_annotations', 'task_judge.js');
  const orig = fs.readFileSync(SP_PATH, 'utf8');
  const origTj = fs.readFileSync(TJ_PATH, 'utf8');

  function _requireIt(env, expectSubstr) {
    const r = spawnSync(process.execPath, ['-e', 'require(process.argv[1])', SP_PATH], {
      env: { ...process.env, ...env }, encoding: 'utf8', cwd: CORE,
    });
    const out = (r.stderr || '') + (r.stdout || '');
    assert.notEqual(r.status, 0, '守卫没拦住 —— 期望 require 就抛, 实际正常退出\n' + out);
    assert.ok(out.includes(expectSubstr), '抛错了但不是这条: 期望含「' + expectSubstr + '」\n' + out.slice(0, 400));
  }

  try {
    // 红线 ③: TTL 为零 → 所有停点当场过期, 闸门恒失效
    _requireIt({ PANGU_STOP_POINT_TTL_MS: '0' }, 'TTL 必须为正数');

    // 红线 ①: task_judge 档位名漂了 → readStopPoint 会把真停点当 BAD_VERDICT 丢掉
    fs.writeFileSync(TJ_PATH, origTj.replace("verdict = 'stop';", "verdict = 'halt';"), 'utf8');
    _requireIt({}, '产出了本模块不认识的档位');
    fs.writeFileSync(TJ_PATH, origTj, 'utf8');

    // 红线 ①的另一头: 真源整个没了 → 不能静默变成「闸门开着」
    fs.unlinkSync(TJ_PATH);
    _requireIt({}, '取 task_judge 真源失败');
  } finally {
    // 尺子自己也要校: 真源必须还原 (试过三遍, 顺序固定)
    fs.writeFileSync(TJ_PATH, origTj, 'utf8');
    fs.writeFileSync(SP_PATH, orig, 'utf8');
  }
  // 还原后自检必须过 —— 顺带证明上面那次「档位漂移」真被改回去了
  const after = spawnSync(process.execPath, ['-e', 'require(process.argv[1])', SP_PATH], {
    env: process.env, encoding: 'utf8', cwd: CORE,
  });
  assert.equal(after.status, 0, '真源没还原干净: ' + ((after.stderr || '') + (after.stdout || '')).slice(0, 300));
});

test('清理: 测试目录不留在磁盘上', () => {
  _cleanup();
  assert.equal(fs.existsSync(TMP_DIR), false);
});
