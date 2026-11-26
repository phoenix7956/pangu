// 2026-10-17 "主人的全量清单"从继承上下文漏进子 agent —— 一刀 6 轮 / 重填 24k 字
//
// 老板原话: "全量重填肯定是大问题, 乾就应该把任务拆了, 分下去, 子 agent 只做自己
// 相关的, 做好汇报"。拆了、路径锚也收窄了(2026-10-16), 但实测 2026-10-17 仍在重填。
//
// 现场取证 (子会话落盘 ~/.pangu-data/sessions/lt3-1792176406069_sub-0-analyzer.json,
// 逐条读 messages, 不是看代码猜的)。sub-0 被派 j2_loop_shared.js, 它的消息列表是:
//
//   [2] role=user len=485  "【盘古起卦…】…请分别分析这三个文件各自解决什么问题,
//                             每个文件给 3 个要点: 1) …/j2_loop_shared.js
//                             2) …/router/model_cost.js 3) …/checkpoint.js"
//                             ← **主人原话全文, 三个绝对路径都在**
//   [3] role=user len=683  "…请分别分析这三个文件… —— 只做这一项: …/j2_loop_shared.js"
//                             ← 它自己那刀 (已收窄)
//
// 同一轮里 [2] 和 [3] 打架, 模型照**前**那句把三件都干了:
//   [4] tools=exec_command,read_file → wc -l 三个文件 + read_file 自己的(24071 字)
//   [7] tools=read_file,read_file,read_file → 11057 / 6195 / 6229 (自己的读第二遍 + 两个兄弟)
//   [11] task_done
// 自己那份 24071 字读了两遍, 兄弟两份白读 12424 字, nativeRounds=6。
// 同一轮 sub-1(只读自己那份) 2 轮就收工 —— 差的不是模型, 是它看到几份清单。
//
// 为什么相关性筛选没挡住 —— 日志把话说明白了:
//   [dispatch] 分工上下文 task: 作业键=200 轮次 1(相关 0/砍无关 0) 下发 485 字符
// "相关 0" = 判定跟这一刀无关; "砍无关 0" = 它照发。差别在 CONTEXT_FLOOR_TURNS:
// 最近 2 轮无条件保留, 绕过相关性判定 (isFloor)。
//
// 底线本身不能删 (治"上一手干过别的活, 别撞车")。但一条**点了兄弟刀名字**的轮次
// 不是"别撞车"提醒, 是一条**竞争性指令** —— 底线豁免不该护住它。
// 修法: buildScopedContext 收 excludeScopePaths, 命中兄弟路径的轮次无条件砍,
// 不吃底线豁免。判据与路径锚共用 j2_dispatcher._ownerPathScope, 两边不漂。
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { _ownerPathScope, _ownerScopeBlock } = require('../modules/j2_dispatcher');
const { getContainer } = require('../modules/session_container');

const BASE = '/Users/you/Desktop/pangu/apps/core/modules/';
const F_A = BASE + 'j2_loop_shared.js';
const F_B = BASE + 'router/model_cost.js';
const F_C = BASE + 'checkpoint.js';

const OWNER = '请分别分析这三个文件各自解决什么问题, 每个文件给 3 个要点: '
  + '1) ' + F_A + ' 2) ' + F_B + ' 3) ' + F_C;
const HEAD = '请分别分析这三个文件各自解决什么问题, 每个文件给 3 个要点';
const knife = (one) => HEAD + ' —— 只做这一项: ' + one;

const _reset = () => {
  const c = getContainer();
  if (c && typeof c._states === 'object') c._states.clear();
  if (c && c._states && typeof c._states.clear === 'function') c._states.clear();
  return c;
};

// 现场那句话逐字抄: 卦块 + 主人全量清单。它就是那条"底线轮次"。
const OWNER_TURN = '【盘古起卦 · 先于推理 (梅花易数, 64i 真卦辞爻辞)】\n'
  + '本卦: 临 ䷒ (坤上兑下)「临，元亨利贞，至于八月有凶。」 | 动爻: 九二'
  + '「九二：咸临，吉无不利」\n'
  + '请分别分析这三个文件各自解决什么问题, 每个文件给 3 个要点: '
  + '1) ' + F_A + ' 2) ' + F_B + ' 3) ' + F_C;

test('S1 判据单源: 路径锚与继承过滤必须算出同一份兄弟路径', () => {
  for (const one of [F_A, F_B, F_C]) {
    const scope = _ownerPathScope(OWNER, knife(one));
    assert.ok(scope.scoped, '并列清单那一刀必须收窄');
    assert.deepStrictEqual(scope.own, [one], 'own 只能是这一刀自己的那条');
    assert.strictEqual(scope.siblings.length, 2, '兄弟恰好是另外两条');
    assert.ok(!scope.siblings.includes(one), '兄弟里不能混进自己');
    // 路径锚那一侧也必须只给这一条 (复用同一判据, 不许两边漂)
    const block = _ownerScopeBlock(OWNER, 3, knife(one));
    assert.ok(block.includes(one));
    for (const s of scope.siblings) {
      assert.ok(!block.includes(s), '路径锚里混进了兄弟 ' + s);
    }
  }
});

test('S2 点名兄弟的底线轮次必须被砍 —— 这是本次实测的那 485 字', () => {
  const c = _reset();
  c.ensureRoot('sib-1');
  // 现场顺序: 先 append 本轮主人原话, 再记轮数, 再派子 agent。
  c.appendTurn('sib-1', 'user', OWNER_TURN);
  const upTo = c.getState('sib-1').turns.length;

  const scope = _ownerPathScope(OWNER, knife(F_A));
  const live = c.buildScopedContext('sib-1', {
    taskText: knife(F_A), upToTurns: upTo, excludeScopePaths: scope.siblings,
  });

  const kept = (live.turns || []).map((t) => String(t.content || '')).join('\n');
  assert.ok(!kept.includes(F_B) && !kept.includes(F_C),
    '兄弟路径还漏在继承上下文里 —— 实测这一条就是 6 轮 + 24k 字重填的成因: ' + kept.slice(0, 200));
  assert.ok(live.scope.turns_dropped_sibling >= 1,
    '砍兄弟计数必须 > 0, 否则这条日志就是在骗人 (现场就是"砍无关 0")');
});

test('S3 差分: 去掉 excludeScopePaths 就必须漏 —— 证明这条护栏钉的是机制不是措辞', () => {
  const c = _reset();
  c.ensureRoot('sib-2');
  c.appendTurn('sib-2', 'user', OWNER_TURN);
  const upTo = c.getState('sib-2').turns.length;

  // 不传兄弟路径 = 修复前的老行为, 这时必须漏出来。
  const before = c.buildScopedContext('sib-2', { taskText: knife(F_A), upToTurns: upTo });
  const beforeText = (before.turns || []).map((t) => String(t.content || '')).join('\n');
  assert.ok(beforeText.includes(F_B) && beforeText.includes(F_C),
    '老行为下兄弟路径本来就在继承上下文里 —— 漏不出来就说明这条测试没在测真东西');
});

test('S4 连续性不能被误伤: 不点兄弟的上一手必须照旧继承', () => {
  const c = _reset();
  c.ensureRoot('sib-3');
  c.appendTurn('sib-3', 'user', OWNER_TURN);
  c.appendTurn('sib-3', 'user', '接着说: 上一次那个日志文件你放哪了?');
  const upTo = c.getState('sib-3').turns.length;

  const scope = _ownerPathScope(OWNER, knife(F_A));
  const live = c.buildScopedContext('sib-3', {
    taskText: knife(F_A), upToTurns: upTo, excludeScopePaths: scope.siblings,
  });
  const kept = (live.turns || []).map((t) => String(t.content || '')).join('\n');
  assert.ok(kept.includes('日志文件你放哪了'),
    '不点兄弟路径的上一手被砍了 —— 底线轮次存在的意义就是它, 不许为了治 sibling 就把连续性一起治没');
});

test('S5 步骤型子任务不受影响: 它要的就是主人全量路径, 不许收窄', () => {
  const step = '真实写入 ' + F_B + '; 写入后检查文件存在且内容完整';
  const scope = _ownerPathScope(OWNER, step);
  assert.ok(!scope.scoped, '步骤型没有「只做这一项」标记, 必须维持旧行为');
  assert.deepStrictEqual(scope.own, scope.all, '步骤型的 own 就是全量');
  assert.deepStrictEqual(scope.siblings, [], '没收窄就没有兄弟, 否则会砍掉它真正要读的路径');
});
