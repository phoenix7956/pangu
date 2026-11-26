'use strict';

// 2026-10-19: 交付真实性 —— 「干过」这两个字在盘古的账本上必须是真的。
//
// 起因是老板一句「站在用户的角度, 看什么? 是看拆还是看子agent干过?」。
// 答: 看干过。**那这条账本就不许有假**。这一轮在真实数据里挖出四条:
//
//   L1  model 字段被写成对象 —— subagent-runs.jsonl 里 900/3799 条, 按模型聚合静默失效
//   L2  艮·gen 报假账         —— 两行 record() 中间什么都没写, 却记「已记录任务经验至长期记忆」
//   L3  86 组 start 永不收口   —— 界面上永远「在跑」, 其实早就炸了
//   L4  完整正确的答复被判 partial —— 判分器只认 'completed', 而运行时只产出 'done'
//   G1  「读一个文件」花 145s 决定拆不拆 —— 单目标快路
//
// 两条经验照旧写在这儿, 因为这一轮又踩了:
//   ① **注释会骗过文本断言**。修复说明里写着被判死的代码原文, 扫源码前必须先剥注释,
//      否则守卫红给自己看 (E5 第一版就这么栽过)。
//   ② **改了没接线的地方等于没改**。G1 第一版把 reasoning_effort 写进 opts,
//      而 j2_agent_loop 全程不读 opts.reasoning_effort —— 真正认的是 useModel.reasoning_effort。
//      静态断言没查这一层, 跑出来 145s 和改之前一样。这里改成**跑真函数**验。

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const MODULES = path.join(ROOT, 'modules');
const { wantsSingleTargetRead } = require(path.join(MODULES, 'j2_loop_shared'));
const { classifyRuntimeVerdict } = require(path.join(MODULES, 'runtime_verdict.js'));
// 剥卦块用**生产那一份**。判据自己拿 /【[^】]*】/ 剥是剥不干净的 ——
// 方括号只包住第一行, 后面还跟着 ~150 字卦辞/爻辞/五行/六亲正文。
// 测试自己剥一遍 = 测的是测试自己那份更差的实现 (S1 撞过, 这里不重复)。
const { _stripGuaBlockForRouting } = require(path.join(MODULES, 'j2_dispatcher'));

const DISP_SRC = fs.readFileSync(path.join(MODULES, 'j2_dispatcher.js'), 'utf8');
const SHARED_SRC = fs.readFileSync(path.join(MODULES, 'j2_loop_shared.js'), 'utf8');

// 剥掉行注释和块注释。**任何**扫源码正文的断言都必须先过这一道 ——
// 修复说明里引用的原文会把自己判死 (2026-10-19 E5 第一版)。
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1 ');
}
const DISP_CODE = stripComments(DISP_SRC);
const SHARED_CODE = stripComments(SHARED_SRC);

// 2026-10-21: 夹具改成**从生产格式化函数现取** (modules/gua_block.js = 唯一真源)。
// 原来这里手抄了一份块正文 —— 生产那份 2026-10-21 改了措辞, 手抄这份没跟上,
// 剥离认不出收尾 → 残留把 70 字的问句顶出闸门 → 测试红, 而生产其实是好的。
// **抄生产文本 = 给自己埋雷** (S1 撞过一次, 这里又撞一次)。
const { formatGuaFirstBlock } = require(path.join(__dirname, '..', 'modules', 'gua_block'));
const GUA = formatGuaFirstBlock({
  gua_name: '明夷', symbol: '䷣', upper_trigram: '坤', lower_trigram: '离',
  gua_ci: '明夷，利艰贞。', yao_name: '九三',
  moving_yao_ci: '九三：明夷于南狩，得其大首，不可疾贞',
  zhi_gua: { name: '复', symbol: '䷗', gua_ci: '复，亨。出入无疾，朋来无咎。反复其道，七日来复，利有攸往。' },
  wuxing: '土', yao_wuxing: '金', wuxing_rel: '土生金', liu_qin: '子孙', position_nature: '变机',
}).replace(/\n\n主人问题: $/, '\n');   // 去掉"主人问题:"标记 (留换行!) → 走"没标记"那条剥路径

test('L1 model 落盘只许是字符串 —— 对象会被写成 JSON, 按模型聚合静默失效', () => {
  // 现场: 3799 条里 900 条 model 是 {"id":"qwen/qwen3.8-27b",...}
  // 7 处调用点传的是 model 对象而不是 .id, 其余 20 处传 .id —— 同一个变量名, 看代码分不出。
  //
  // 2026-10-19 (这一条测试自己踩了坑, 记在这儿):
  //   第一版直接在测试进程里 require subagent_runs 然后调 record()。
  //   而 record() 是**真往 ~/.pangu/subagent-runs.jsonl 追加**的, RUNS_FILE 在
  //   require 时就按 os.homedir() 算死了 —— 于是跑一次测试就往生产账本里灌几行假记录,
  //   而且灌的偏偏是 `kind:'start'` **没有配对的 done**: 我自己造出了这轮要修的
  //   「start 永不收口 → 界面上永久在跑」(实测污染 16 行)。
  //   它还顺手改了模块级 _activeCounts, 让同批并发的别的测试 (main-agent-dispatch /
  //   slice-death) 时绿时红 —— 一度被我误判成"我改坏了"。
  //
  // 所以: 凡是要验 record() 落盘形状, 一律**子进程 + 假 HOME**。
  // 测试不许碰生产数据 —— 这是「不装能」在测试层的同一条规矩。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-guard-l1-'));
  const script = `
    const runs = require(${JSON.stringify(path.join(MODULES, 'subagent_runs.js'))});
    const obj = runs.record({ kind: 'start', code: 'kan', task: 't',
      model: { id: 'qwen/qwen3.8-27b', api_model: 'qwen/qwen3.8-27b', provider: 'lmstudio' },
      sessionId: 'guard-l1' });
    const str = runs.record({ kind: 'start', code: 'li', task: 't', model: 'kimi/k2', sessionId: 'g' });
    const nul = runs.record({ kind: 'start', code: 'kun', task: 't', sessionId: 'g' });
    process.stdout.write(JSON.stringify([obj.model, str.model, nul.model]));
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });
  const [fromObj, fromStr, fromEmpty] = JSON.parse(out.trim().split('\n').pop());
  assert.equal(typeof fromObj, 'string', '对象必须被归一成 id 字符串');
  assert.equal(fromObj, 'qwen/qwen3.8-27b');
  // 字符串原样、空值原样 —— 归一不能反过来把正常调用弄坏
  assert.equal(fromStr, 'kimi/k2');
  assert.equal(fromEmpty, null);

  // 收口: record() 是**唯一**写盘出口, 归一必须落在这里, 不能只靠调用点自觉
  assert.ok(/model:\s*_modelId\(/.test(fs.readFileSync(path.join(MODULES, 'subagent_runs.js'), 'utf8')),
    'record() 必须真的调用了归一函数');

  // 收尾: 假 HOME 下的账本也要顺手清掉, 别留在 /tmp 里误导下一个人
  try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
});

test('L2 艮·gen 不许再报假账 —— 没写进记忆就不能记 done', () => {
  // 原码: 两行 record() 之间什么都没有, 却写死 summary「已记录任务经验至长期记忆」。
  // 458 次「干过」, 实际落盘 0 条 —— 老板要看的恰恰是"干过"。
  assert.ok(!/summary:\s*'已记录任务经验至长期记忆'/.test(DISP_CODE),
    '那行硬编码的成功文案必须删掉 —— 它就是假账本身');
  assert.ok(/memory[\s\S]{0,80}\.write\(/.test(DISP_CODE),
    '必须真的调 memory.write');
  // 写失败要如实记 error, 不许当没发生过
  assert.ok(/kind:\s*'error',\s*code:\s*'gen'/.test(DISP_CODE),
    '写失败必须记 error, 而不是悄悄吞掉');
});

test('L3 planner 炸了要收口 —— start 没有配对的 error 就是界面上永久的"在跑"', () => {
  // 现场: 86 组 start 悬空共 119 次, kan 占 54 (最多的一个)。
  // 代价不是账本脏, 是坎·拆 在界面上永远显示"在跑", 而它其实早就炸了。
  assert.ok(/catch\s*\(e\)\s*\{\s*\n?\s*(?:[^\n]*\n){0,3}?\s*record\(\{\s*kind:\s*'error',\s*code:\s*'kan'/.test(DISP_CODE)
    || /kind:\s*'error',\s*code:\s*'kan'/.test(DISP_CODE),
    'planner 的 catch 分支必须记 error');
});

test("L4 子 agent 说 done 就是干成了 —— 判分器只认 'completed' 会把全系统判成 partial", () => {
  // sub-agent.js 的 runtimeStatus 只会产出 'done' / 'failed', 'completed' 运行时不存在。
  // 于是 has_verified_execution 恒 false, 每一个子 agent 交付的答复都被标 partial。
  // 实测: 「读 pangu_dogfood.js 列出串联了几个将灵」→ li 读了 4 次文件、答案完整正确,
  // 收口 status=partial success=false。
  const tools = ['read_file', 'read_file', 'file_grep', 'read_file'];
  const base = {
    real_tool_calls_total: tools.length,
    final_text: '文件实际串联了 7 个将灵: xun / zhen / kan / kun / dui / gen / qian。文件未做任何修改。',
    alignment_blocked: undefined, task_done_status: undefined, task_done_accepted: undefined,
    user_input: '读 apps/core/modules/pangu_dogfood.js 回答：这个文件实际串联了几个将灵？',
  };
  // 'done' 是运行时**唯一**的成功值 → 必须判 completed
  assert.equal(
    classifyRuntimeVerdict({ ...base, has_verified_execution: ['done'].includes('completed') || ['done'].includes('done') }).status,
    'completed');
  // 真失败仍然不许蒙混过关
  assert.equal(
    classifyRuntimeVerdict({ ...base, final_text: '未能完成该任务', has_verified_execution: false }).success,
    false);

  // 收口: resDone 里那行必须认 done, 且和下面 fixed_flow 分支用同一套判定
  assert.ok(/childStatuses\.some\(c\s*=>\s*c\s*===\s*'completed'\s*\|\|\s*c\s*===\s*'done'\)/.test(DISP_CODE),
    "has_verified_execution 必须接受 'done'");
  assert.ok(/c\s*===\s*'completed'\s*\|\|\s*c\s*===\s*'done'/.test(DISP_CODE),
    'fixed_flow 分支本来就认 done —— 两处判定必须一致');
});

test('G1 单目标阅读命中快路 —— 省掉那一刀 145 秒只为回答"拆不拆"', () => {
  // 四次同题实测: 拆解刀 106s/6030tok、377s/9690tok、120s/8828tok, 产出 **0 刀**。
  const shouldRun = [
    ['读 apps/core/modules/pangu_dogfood.js，回答：这个文件实际串联了几个将灵？逐个列出 code。不许改文件。', '本次现场原题'],
    ['读 apps/core/agents/agents.json，这个文件列了几个将灵', '短变体'],
    ['看一下 /Users/you/Desktop/pangu/apps/core/modules/subagent_runs.js 干什么用的', '绝对路径'],
  ];
  for (const [q, why] of shouldRun) {
    assert.equal(wantsSingleTargetRead(q), true, `应命中单目标 (${why}): ${q}`);
    // 卦块是服务端拼的 ~200 字上下文, 不是主人的工作量 —— 判据拿到的必须是剥完的
    assert.equal(wantsSingleTargetRead(_stripGuaBlockForRouting(GUA + q)), true,
      `带卦块也应命中 (卦块不是主人的工作量): ${q}`);
  }
});

test('G2 真任务一个都不许放行 —— 误放行 = 没人拆 = 事故', () => {
  const mustPlan = [
    ['分别分析这三个文件，每个给3个要点：1) j2_loop_shared.js 2) model_cost.js 3) checkpoint.js', '三个落点=真三刀 (现场 e2e-agent-20261016)'],
    ['修一下 apps/core/agents/qian.js 里的配置兜底路径 bug', '写操作'],
    ['读 a.js 然后改 b.js', '多步有依赖'],
    ['读 a.js 和 b.js 分别说明', '两个落点'],
    ['这个项目是干什么的', '没有落点'],
    ['把 apps/core/modules/subagent_runs.js 重构成支持按卦名查询', '重命名+重构'],
    ['读 package.json 列出全部依赖，并写进 requirements.txt', '读完还要写'],
  ];
  for (const [q, why] of mustPlan) {
    assert.equal(wantsSingleTargetRead(q), false, `必须老实走拆解 (${why}): ${q}`);
  }

  // 隔离用例: **不带任何"分别/每个/然后"字样**的多落点。
  // 上面那些即使把「路径数恰好 1 个」放宽成「至少 1 个」也照样拦得住 ——
  // 它们是被 _MULTI_DELIVER_RE 顺手救下的, 根本没验到路径计数那条规则。
  // 守卫被别的规则顺手救下 = 这条规则其实没被钉住, 改了它测试还是绿的 (2026-10-19 实测)。
  for (const [q, why] of [
    ['对比 apps/core/a.js 和 apps/core/b.js 有什么不同', '两个落点, 无并列词'],
    ['读 apps/core/a.js 与 apps/core/b.js 的差异', '两个落点, 无并列词'],
  ]) {
    assert.equal(wantsSingleTargetRead(q), false, `路径计数必须独立拦住 (${why}): ${q}`);
  }
});

test('G3 否定要剥掉 —— 「不许改文件」是只读声明, 不是写操作', () => {
  // 主人最常说的一句恰恰带否定。不剥的话它会被 _WRITE_VERB_RE 的「改」命中,
  // 而带否定的那一刀是**更该**走只读快路, 不是更不该。
  assert.equal(wantsSingleTargetRead('读 apps/core/agents/li.js 解释一下职责，不要改任何文件'), true);
  assert.equal(wantsSingleTargetRead('读 apps/core/agents/li.js 解释一下职责，别动它'), true);
  // 反面: 否定剥完仍然是真写操作 → 照拦
  assert.equal(wantsSingleTargetRead('读 apps/core/agents/li.js 然后创建新文件'), false);
});

test('G4 拆解刀必须真的拿到推理预算 —— 只写进 opts 等于没改', () => {
  // 踩过的坑: 第一版把 reasoning_effort 写进 opts, 但 j2_agent_loop 全程不读
  // opts.reasoning_effort; llm_caller 认的是 useModel.reasoning_effort。
  // 静态断言没查这一层, 跑出来 145s 和改之前一样。
  // 所以这里断言**合并进 model** 这件事, 而且是剥过注释的正文。
  assert.ok(/_planModel\s*=\s*\(model\s*&&\s*typeof\s+model\s*===\s*'object'\)\s*\?\s*\{[^}]*reasoning_effort:\s*_planEffort/.test(DISP_CODE),
    '预算必须合并进传给主循环的 model 对象');
  assert.ok(/_runAgentLoopLegacyStream\(\s*_planMessages\s*,\s*_planModel/.test(DISP_CODE),
    '必须把合并后的 model 传下去, 不是把原 model 传下去');
  // 兜底档必须是 low —— 这一刀产出的是"是/否", 不是需要权衡的判断。
  //
  // 2026-10-19 修正: 原来这条锁的是**写法** `... || 'low'`。但 UI 的推理强度选择器
  // 把「自动」写成 'auto' 并原样下发 (ChatRoom.jsx:1223), `||` 挡不住它 ——
  // 'auto' 是非空字符串, 于是被当成有效值合并进 model, llm_caller 原样上线,
  // LM Studio 直接 400 ("Invalid 'reasoning_effort' value: 'auto'"), 整轮死掉。
  //
  // 所以改成**白名单**: 只认 OpenAI 规范六档, 'auto'/空/乱值一律落 low。
  // 这里锁两件事: 白名单真的在, 且兜底还是 low。写法可以变, 行为不能变。
  assert.ok(/_planEffortRaw\s*=\s*\(opts\.reqBody\s*&&\s*opts\.reqBody\.reasoning_effort\)\s*\|\|\s*''/.test(DISP_CODE),
    '必须先取原始值再判白名单 —— 直接 `|| low` 挡不住 \'auto\'');
  assert.ok(/\['none',\s*'minimal',\s*'low',\s*'medium',\s*'high',\s*'xhigh'\]\s*\.includes\(_planEffortRaw\)/.test(DISP_CODE),
    '必须用白名单过滤 —— \'auto\' 是界面占位符, 不是 API 值');
  assert.ok(/\?\s*_planEffortRaw\s*\n?\s*:\s*'low'/.test(DISP_CODE),
    '主人没指定 (或指定 \'auto\') 时拆解刀必须落 low 档');
});

test('G5 单目标通道不许拿到"优先不调工具" —— 那会让读文件变成零工具空答', () => {
  // directAnswer 会注入"优先不调工具"。单目标阅读要的恰恰是它去 read_file 真读。
  // 跟 855fa63 修的那个 bug 同一个出口, 所以钉死。
  assert.ok(/directAnswer:\s*!_oneShotTurn/.test(DISP_CODE),
    '单目标阅读必须走 directAnswer:false');
  assert.ok(/_oneShotTurn\s*=\s*_singleShotTurn\s*\|\|\s*_singleTargetTurn/.test(DISP_CODE),
    '单刀直查与单目标阅读必须合流成同一条通道');
});
