// 2026-10-16 "子 agent 只做自己相关的" 在工具层根本没做到 —— 每一刀都被命令去读**全部**文件
//
// 老板原话: "乾就应该把任务拆了, 分下去, 子 agent 只做自己相关的, 做好汇报"。
// 拆分做了 (三刀各一个文件, 互不依赖), 汇报也做了, 但**工具层全塌了**。
//
// 实测取证 (子会话落盘 ~/.pangu-data/sessions/e2e-tsmeas-20261016_sub-*_analyzer.json,
// 逐条读 tool_calls, 不是看代码猜的):
//
//   sub-1-analyzer  被派 model_cost.js
//     → read_file j2_loop_shared.js / model_cost.js / checkpoint.js     ← 三个全读
//   sub-2-analyzer  被派 checkpoint.js
//     → read_file j2_loop_shared.js / model_cost.js / checkpoint.js     ← 同样三个全读
//
// 代价是实打实的: 每个 analyzer 的工具结果里躺着 16k 字文件内容 (本该 5k),
// 而**之后每一轮都要为这 3 份内容重新 prefill**。这就是"同样模型, 盘古比 codex 慢"
// 的一大半。
//
// 根因是 _ownerScopeBlock 的 pathBlock。它原话是:
//   【主人原话里的路径 — **直接照抄**, 禁止用你自己的 cwd 顶替】<主人的全部路径>
// 主人问"分别分析这三个文件…1) a 2) b 3) c"拆成三刀之后, 每一刀的 pathBlock 里
// 都还是**三个路径 + "直接照抄"** —— 等于在命令每个子 agent 把兄弟刀的活也做掉。
//
// 这块 2026-09-18 加它是对的 (治"扫了 pangu 仓库没扫易经", 子 agent 拿自己 cwd 顶替),
// 只是范围给宽了: 钉路径要钉**这一刀自己的**那条, 不是把主人的整份清单抄一遍。
// 收窄条件很保守 —— 子任务文本自己点了名、且那确实是主人原话里的路径才收窄;
// 少一条都不放行, 拿不到就维持旧行为 (宁可多给, 不能让子 agent 找不到该读的文件)。
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { _ownerScopeBlock } = require('../modules/j2_dispatcher');

const BASE = '/Users/you/Desktop/pangu/apps/core/modules/';
const F_A = BASE + 'j2_loop_shared.js';
const F_B = BASE + 'router/model_cost.js';
const F_C = BASE + 'checkpoint.js';

const OWNER = '请分别分析这三个文件各自解决什么问题, 每个文件给 3 个要点: '
  + '1) ' + F_A + ' 2) ' + F_B + ' 3) ' + F_C;
const HEAD = '请分别分析这三个文件各自解决什么问题, 每个文件给 3 个要点';
const knife = (one) => HEAD + ' —— 只做这一项: ' + one;

const pathLine = (block) =>
  (block.split('\n').find((l) => l.indexOf('路径') >= 0) || '').trim();

test('T1 本刀点了名 → 路径块只给这一条, 兄弟路径一个字都不许出现', () => {
  const cases = [
    ['第一刀', F_A, [F_B, F_C]],
    ['第二刀', F_B, [F_A, F_C]],
    ['第三刀', F_C, [F_A, F_B]],
  ];
  for (const [label, one, mustNot] of cases) {
    const block = _ownerScopeBlock(OWNER, 3, knife(one));
    assert.ok(block.includes(one), label + ' 必须拿到自己那条路径 —— 钉路径是这块存在的理由');
    for (const other of mustNot) {
      assert.ok(!block.includes(other),
        label + ' 的路径块里混进了兄弟刀的 ' + other
        + ' —— 实测两个 analyzer 因此各读了 3 个文件');
    }
  }
});

test('T2 收窄时改口 —— 不然子 agent 会以为那是主人的全量清单', () => {
  const line = pathLine(_ownerScopeBlock(OWNER, 3, knife(F_B)));
  assert.ok(line.indexOf('这一刀自己的路径') >= 0,
    '文案要说清这是"这一刀自己的路径"而不是"主人原话里的路径" —— '
    + '后者读起来就是一份完整清单, 模型照单全收正是实测到的行为');
});

test('T3 收窄的前提不成立时, 一律维持旧行为', () => {
  const cases = [
    '把三份东西都核对一遍',                                    // 完全不点名
    HEAD + ' —— 只做这一项: 把三处引用都查一遍',                  // 有标记但没具体路径
    HEAD + ' —— 只做这一项: /Users/you/完全不是主人说的那个文件.js', // 有标记但不是主人原话里的
    // 这一条是被 owner-spec-to-subagent-20261013 打回来的: 步骤型子任务也会点名路径,
    // 但那多半是它**要写的**, 而它要**读**的是主人原话里的那几个 (治 longtask-01
    // 「5 个 executor 抢同一个汇总文件」的就是那条路径锚)。
    '真实写入 ' + F_B + '; 写入后检查文件存在且内容完整',
  ];
  for (const sub of cases) {
    const block = _ownerScopeBlock(OWNER, 3, sub);
    const tag = sub.slice(0, 20);
    assert.ok(block.includes(F_A) && block.includes(F_B) && block.includes(F_C),
      '子任务 "' + tag + '…" 必须退回全量路径块 —— 收窄的前提不成立时收窄, '
      + '等于让子 agent 读不到该读的文件');
    assert.ok(pathLine(block).indexOf('主人原话里的路径') >= 0,
      '没收窄就别改文案, 否则名实不符');
  }
});

test('T4 收窄只认主人原话里的路径 —— planner 编出来的陌生路径不许顶替', () => {
  const invented = '/etc/passwd';
  const block = _ownerScopeBlock(OWNER, 3, HEAD + ' —— 只做这一项: ' + invented);
  assert.ok(!block.includes(invented), '主人没提过的路径不许进子 agent 的任务');
  assert.ok(block.includes(F_A), '该退回主人的全量路径块');
});

test('T5 单子任务 (subTaskCount<=1) 的老行为不许被这次改动带歪', () => {
  const block = _ownerScopeBlock(OWNER, 1, knife(F_B));
  assert.ok(block.includes(F_A),
    '单刀时主人原话本就是它自己的任务, 全量注入无害 —— 别顺手收窄');
});

test('T6 收窄只认「只做这一项」这个服务端标记 —— 它才是"项被分走了"的唯一证据', () => {
  // 只凭"文本里出现路径"收窄过一次, 被 owner-spec-to-subagent-20261013 的反向不变量
  // 打回: 步骤型任务里那个路径是**要写的**, 它要**读**的仍是主人原话里的路径。
  // 「只做这一项」是 task_split._splitEnumeratedParallel 服务端自己拼上去的标记,
  // 只有真并列清单才有 —— 顺序/步骤型任务永远没有, 正好对应"项与项被分给不同子 agent"。
  const stepTask = '真实写入 ' + F_B + '; 写入后检查文件存在且内容完整';
  const block = _ownerScopeBlock(OWNER, 3, stepTask);
  assert.ok(block.includes(F_A) && block.includes(F_C),
    '步骤型任务不许因为文本里有个路径就被收窄 —— 它要读的是主人说的那些');
  assert.ok(pathLine(block).indexOf('主人原话里的路径') >= 0);
});

