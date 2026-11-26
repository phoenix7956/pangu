'use strict';
/**
 * 第 63 批变异体检 —— 验「tests/synth-prompt-single-20261023.test.js」的判据真能咬住。
 *
 * ## 铁律: 打空枪的变异比没有变异更坏
 *
 * 它给你「验过了」的假安全感。所以本 harness 的判据是:
 *   **每个变异都必须让目标测试 FAIL。跑完还是 PASS = 空枪 = 本批判据无效, 必须重做。**
 * 空枪不计入成功数, 单独报出来, 退出码非 0。
 *
 * ## 变异从哪来
 *
 * 不是随手编的, 是**照着本批真实可能发生的错**编的:
 *   · 把真源里的某条规则删掉 / 改回 10-21 之前的口径
 *   · 让 dispatcher 的某一条路径不传真源 (改内联 / 改参数 / 把调用挪出 system)
 *   · 新加一条综合路径却忘了走真源
 *   · 把真源与规则 #19 打架
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CORE = path.join(__dirname, '..', '..');
const DISPATCHER = path.join(CORE, 'modules', 'j2_dispatcher.js');
const SYNTH = path.join(CORE, 'modules', 'synth_prompt.js');
const RULES_MOD = path.join(CORE, 'modules', 'global_agent_rules.js');
const GT_TEST = path.join('tests', 'synthesis-ground-truth.test.js');
const LABEL_TEST = path.join('tests', 'subagent-activity-passthrough-20261016.test.js');
const TESTS = [
  path.join('tests', 'synth-prompt-single-20261023.test.js'),
  //
  // 第 63 批改了两条老测试的判据(都是「从数抄本份数」改成「钉机制」),
  // 所以变异必须**连它们一起跑** —— 改判据的人得给自己上枷锁,
  // 不然就是自己给自己放水。
  GT_TEST,
  LABEL_TEST,
];

function runTest() {
  for (const t of TESTS) {
    try {
      execFileSync('node', ['--test', t], { cwd: CORE, stdio: 'pipe' });
    } catch (e) {
      return { pass: false, out: String(e.stdout || '') + String(e.stderr || '') };
    }
  }
  return { pass: true };
}

/**
 * 变异后的文件**必须还能被 node 解析**。
 *
 * 为什么这条是硬要求: 语法错误的变异照样会让测试 FAIL, harness 会兴高采烈地
 * 记成「咬住了」—— 那是**假咬住**。测试失败的原因必须是本文件的判据,
 * 不是「文件根本加载不了」。
 * (2026-10-23 本批真踩: M12 往数组字面量中间插了个 const 声明, 文件语法坏了。)
 */
function syntaxOk(files) {
  for (const f of files) {
    try {
      execFileSync('node', ['--check', f], { stdio: 'pipe' });
    } catch (e) {
      return { ok: false, detail: String(e.stderr || e.stdout || e.message).split('\n').slice(0, 3).join(' ') };
    }
  }
  return { ok: true };
}

/**
 * 锚点替换。正则锚点要求**恰好命中 1 次** —— 0 次说明变异没打上(锚点过期),
 * >1 次说明锚点太松(改了一堆不相干的地方)。两种都当场抛, 不许空跑。
 */
function rep(src, find, to) {
  const re = find instanceof RegExp ? find : new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 's');
  const hits = src.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
  const n = hits ? hits.length : 0;
  if (n !== 1) {
    throw new Error(`锚点命中 ${n} 次 (要 1 次): ${String(find).slice(0, 70)}`);
  }
  return src.replace(re, to);
}

/**
 * 按「起标记 → 止标记」整段替换。
 *
 * 为什么需要它: 这些变异要动的是**多行拼接的整条规则**,
 * 而规则文案里全是中文标点和 `)` `'` —— 写成正则就得逐个转义,
 * 转错了不报错, 只是命中 0 次, 然后你花半小时以为是判据没咬住。
 * (2026-10-23 本批真踩: M1 因为一个没转义的 `)` 静默失配, 报成「锚点失效」。)
 * 用纯字符串做标记就没有这个坑。
 */
function repBetween(src, from, to, replacement) {
  const a = src.indexOf(from);
  if (a < 0) throw new Error(`起标记没找到: ${from.slice(0, 50)}`);
  if (src.indexOf(from, a + 1) >= 0) throw new Error(`起标记不唯一: ${from.slice(0, 50)}`);
  const b = src.indexOf(to, a + from.length);
  if (b < 0) throw new Error(`止标记没找到: ${to.slice(0, 50)}`);
  if (src.indexOf(to, b + 1) >= 0 && src.indexOf(to, b + 1) < a + from.length + 4000) {
    throw new Error(`止标记在本段内不唯一: ${to.slice(0, 50)}`);
  }
  const end = b + to.length;
  return src.slice(0, a) + replacement + src.slice(end);
}

const MUTANTS = [
  // ---- 真源层: 删/改规则 ----
  {
    name: 'M1 真源把 ORDER_RULE 整条换回「卦先定调」(复现 10-21 投诉)',
    files: [[SYNTH, s => repBetween(s, 'const ORDER_RULE =', "就说没拿到)。';",
      "const ORDER_RULE = '【铁律】主人问题开头若有【盘古起卦】块：最终答案必须先以卦象定调 (引真卦辞/爻辞断方向)，再展开现实策略。';")]],
    why: '最坏的那种回归: 顺序规则退回去, 三条路径直接开始让模型拿卦象开篇',
  },
  {
    name: 'M2 真源把「事实在前」只改措辞成「卦象定调」(连接不断)',
    files: [[SYNTH, s => rep(s, '**第一段先给已核实的事实/结论** ', '**第一段先给卦象定调** ')]],
    why: '光查「没有禁止词」不够 —— 得有一条断言要求它真的写明事实在前',
  },
  {
    name: 'M3 真源删掉 LENGTH_RULE (四条路径一起失去 ≤300 字)',
    files: [[SYNTH, s => rep(s, /const LENGTH_RULE =[\s\S]*?时才可长。';/, "const LENGTH_RULE = '';")]],
    why: '长度硬约束原本四条路径里三条有一份没有; 真源删了它四份一起丢',
  },
  {
    name: 'M4 真源删掉 NO_TOOL_RULE',
    files: [[SYNTH, s => rep(s, /const NO_TOOL_RULE =[\s\S]*?需要新证据就如实说还缺什么。';/, "const NO_TOOL_RULE = '';")]],
    why: '这条规则原本只在 L373 一份, 收口后成为四份共有',
  },
  {
    name: 'M5 真源删掉 TIMING_RULE',
    files: [[SYNTH, s => rep(s, /const TIMING_RULE =[\s\S]*?不许再当现状说。';/, "const TIMING_RULE = '';")]],
    why: '同上',
  },
  {
    name: 'M6 真源删掉「卦块必须在」(只留「事实在前」, 把用卦丢了)',
    files: [[SYNTH, s => rep(s,
      "'**用卦 ≠ 用卦开头** —— 卦块必须在、真卦辞爻辞必须引，但不许拿卦象开篇，'",
      "'**用卦 ≠ 用卦开头** —— 但不许拿卦象开篇，'")]],
    why: '收口最容易丢的一半: 10-09 裁定是「用卦 + 事实在前」, 不是只要事实在前',
  },
  {
    name: 'M7 真源无视 noRoleLabel 参数 (输出形态段永远加不上)',
    files: [[SYNTH, s => rep(s, "const label = opts.noRoleLabel;", "const label = ''; // 变异: 无视参数")]],
    why: 'L1597/L1848/L2019 原来靠这个参数把禁令拼进同一条消息',
  },
  {
    name: 'M8 规则还在, 但忘了往产物里拼 (数组少两项)',
    files: [[SYNTH, s => rep(s,
      // 第 89 批: 锚点跟着真源改过 —— 第 87 批把 LENGTH_RULE 换成了三元
      //   `(opts.breadthDemand ? LENGTH_RULE_BREADTH : LENGTH_RULE)`,
      //   原来那个「BASE_LEAD + 5 条常量」的数组字面量已经不存在了。
      //   现在用**唯一**的那行三元当锚 (RULES 导出块里也有 RECONCILE/NO_TOOL/TIMING 三行,
      //   只用后半截会命中两次 ⇒ rep 直接抛, 那是它该做的)。
      '    (opts.breadthDemand ? LENGTH_RULE_BREADTH : LENGTH_RULE),\n    ORDER_RULE,\n    RECONCILE_RULE,\n    NO_TOOL_RULE,\n    TIMING_RULE,',
      '    (opts.breadthDemand ? LENGTH_RULE_BREADTH : LENGTH_RULE),\n    ORDER_RULE,')]],
    why: '修法不是删规则而是漏拼 —— 同样得被咬住',
  },
  {
    name: 'M9 真源删掉「主人 2026-08-02 拍」的出处标注',
    files: [[SYNTH, s => rep(s, " (主人 2026-08-02 拍: 非常啰嗦)", "")]],
    why: '数字被悄悄改掉 / 来源被抹掉时要有东西发现',
  },

  // ---- 接线层: 让某条路径不传真源 ----
  //
  // 第 89 批 (2026-10-25): 锚点全部**重写**过了。
  //
  // 为什么必须重写: 旧锚点指着「三处内联调用」(每处各拼一条 system 消息),
  //   第 89 批把综合的 system 消息收成**唯一拼装点** `_synthesisSystemMessages`
  //   之后, 那三行代码**不存在了** ⇒ 旧锚点命中 0 次 ⇒ harness 报「锚点失效」。
  //   而「锚点失效」被记成空枪 = 退出码非 0 = 整批变异体检作废。
  //   ⇒ 锚点必须跟着**它守的那个机制**一起换, 否则这套体检守的是一个已经不存在的形状。
  //
  // 新锚点一律用**唯一拼装点里独有的那几行** (提示词那条 + 禁令那条 + 两个展开调用),
  // 靠缩进区分主路 (4 空格) 与关键词兜底路 (6 空格) —— 每一处都天然只命中一次。
  {
    name: 'M10 唯一拼装点里的真源调用被换成内联抄本 (文案抄回 dispatcher)',
    files: [[DISPATCHER, s => rep(s,
      "    { role: 'system', content: buildSynthesisSystemPrompt({ breadthDemand: _breadthDemand(userInput) }) },",
      "    { role: 'system', content: '你是 Pangu，以易经为核心推理的谋断 agent。' },")]],
    why: '这正是 10-21 之前的现场形态: 有人顺手把文案抄回去',
  },
  {
    name: 'M11 关键词兜底路不再走拼装点, 自己拼 system 消息 (挂法分叉)',
    files: [[DISPATCHER, s => rep(s,
      "      ..._synthesisSystemMessages(userInput),",
      "      { role: 'system', content: '你是 Pangu，请综合各子 agent 的结果。' },")]],
    why: '回归方向反过来: 有人把兜底路拆出去自己拼 —— 挂法分叉, 而且这条路的禁令会落空',
  },
  {
    name: 'M12 新增第 5 条综合路径却没走拼装点 (新债)',
    files: [[DISPATCHER, s => rep(s,
      // 插在 `const summaryMessages = [` **之前** —— 插进数组字面量中间会让文件语法坏掉,
      //   而语法坏的变异照样让测试 FAIL, harness 会兴高采烈记成「咬住了」= 假咬住。
      //   (踩坑日志 2026-10-23 就为这件事记了一条: 假咬住比空枪更坏。)
      // 锚在 `const toolHistorySummaries = ...` 那一行 —— 它跟
      //   `const summaryMessages = [` 之间隔着第 89 批加的注释, 锚不进去。
      "    const toolHistorySummaries = _buildFallbackSummaries(resultsRef, _fbBudget.per);",
      "    const summaryMessages5 = [\n"
      + "      { role: 'system', content: '你是 Pangu，以易经为核心推理的谋断 agent。' + _SYNTH_NO_ROLE_LABEL },\n"
      + "    ];\n    void summaryMessages5;\n"
      + "    const toolHistorySummaries = _buildFallbackSummaries(resultsRef, _fbBudget.per);")]],
    why: '人数守恒类: 只查「已有 4 条都接了」会漏掉「新加的第 5 条没接」',
  },
  {
    name: 'M13 拼装点里的真源调用被挪出 system 消息 (挪进一个没人用的变量)',
    files: [[DISPATCHER, s => rep(s,
      "    { role: 'system', content: buildSynthesisSystemPrompt({ breadthDemand: _breadthDemand(userInput) }) },",
      // 用逗号表达式而不是 const 声明 —— 声明会插进数组字面量中间 ⇒ 语法坏 ⇒ 假咬住。
      // 逗号表达式: 先算真源 (调用还在, 调用次数还是 1), 再把它**挪出 content 位**。
      "    { role: 'system', content: (void buildSynthesisSystemPrompt({ breadthDemand: _breadthDemand(userInput) }), '你是 Pangu，请综合。') },")]],
    why: '调用次数还是 1, 但线上已经不是真源了 —— T7 专门为它写',
  },

  // ---- 一致性层 ----
  {
    name: 'M14 global_agent_rules 规则 19 被改口径 (真源与它失去同一把尺子)',
    files: [[RULES_MOD, s => rep(s, "第一段先给已核实的事实/结论", "先说卦象再补事实")]],
    why: 'T4 是双向锁: 规则文件被改也要有人发现',
  },
  {
    name: 'M15 真源删掉对账铁律里的「真写盘」三个字 (2026-10-13 整轮误判的防线)',
    files: [[SYNTH, s => rep(s, '只以"本轮真写盘文件"清单为准', '以你说的为准')]],
    why: '本批改了 synthesis-ground-truth 的判据, 必须证明新判据真的会红 —— '
      + '改判据的人最容易顺手把判据改弱',
  },
  {
    name: 'M16 主路 (_buildSynthesisMessages) 少接一条 —— 自己拼 system 消息',
    files: [[DISPATCHER, s => rep(s,
      // 锚点带上**换行**: 4 空格的版本是 6 空格版本的子串, 不用换行前缀会命中两次。
      "\n    ..._synthesisSystemMessages(userInput),",
      // 替换串也带**前置换行**: 锚点里的换行被吃掉了, 不补回来
      //   上一行的 `//` 注释会把新代码整行注释掉 ⇒ 语法坏 ⇒ 假咬住。
      "\n    { role: 'system', content: buildSynthesisSystemPrompt({ breadthDemand: _breadthDemand(userInput) }) },\n"
      + "    { role: 'system', content: _SYNTH_NO_ROLE_LABEL },")]],
    why: '验证「四条路径都走拼装点」这条判据不是恒真 —— 少接一条必须有人发现',
  },
  {
    name: 'M17 真源把禁令挂法改成「内联拼 label」之外的怪形状 (验挂法判据)',
    files: [[SYNTH, s => rep(s,
      'if (typeof label === \'string\' && label) parts.push(label);',
      'void label; // 变异: 禁令挂不上')]],
    why: 'T10 新加的「每处引用挂法要对」不是恒真 —— 禁令挂不上时必须有人发现',
  },
  {
    name: 'M18 dispatcher 多加一处 _SYNTH_NO_ROLE_LABEL 引用 (验剥注释后数引用处)',
    files: [[DISPATCHER, s => rep(s,
      "  + '答复开头第一句必须是直接回答主人问题的话。';",
      "  + '答复开头第一句必须是直接回答主人问题的话。';\n"
      + "const _labelCopy = _SYNTH_NO_ROLE_LABEL;\nvoid _labelCopy; // 变异: 多一处引用")]],
    why: '旧判据数引用时被注释行骗过 —— 新判据必须剥注释且仍能咬住真引用',
  },
];

function main() {
  const files = [...new Set(MUTANTS.flatMap(m => m.files.map(x => x[0])))];
  const orig = new Map();
  for (const f of files) {
    const s = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
    if (s == null) { console.error(`✗ 基线文件不存在: ${f}`); process.exit(2); }
    orig.set(f, s);
  }
  const restore = () => { for (const [f, s] of orig) fs.writeFileSync(f, s); };

  const base = runTest();
  if (!base.pass) {
    console.error('✗ 基线测试本就不绿 —— 变异体检无从谈起, 先修测试');
    process.exit(2);
  }
  console.log(`✓ 基线绿 (${MUTANTS.length} 个变异待验)\n`);

  let live = 0;
  const blanks = [];
  for (const m of MUTANTS) {
    restore();
    let applied = true;
    let note = '';
    try {
      for (const [f, fn] of m.files) fs.writeFileSync(f, fn(fs.readFileSync(f, 'utf8')));
    } catch (e) { applied = false; note = e.message; }

    let r = { pass: true, out: '' };
    let syn = { ok: true };
    if (applied) syn = syntaxOk(m.files.map(x => x[0]));
    if (applied && !syn.ok) { applied = false; note = '变异后语法坏了(假咬住): ' + syn.detail; }
    if (applied) r = runTest();

    if (!applied) {
      console.log(`⚠ ${m.name}\n    ${note}`);
      blanks.push(m.name + ' [锚点失效]');
    } else if (r.pass) {
      console.log(`✗ 空枪! ${m.name}\n    测试仍然 PASS —— 判据没咬住 (${m.why})`);
      blanks.push(m.name);
    } else {
      const firstFail = (r.out.match(/not ok \d+ - ([^\n]+)/) || [])[1] || '(未知)';
      console.log(`✓ 咬住 ${m.name}\n    失败于: ${firstFail.trim()}`);
      live++;
    }
  }
  restore();

  console.log(`\n咬住 ${live} / ${MUTANTS.length}`);
  if (blanks.length) {
    console.log(`空枪/失效 ${blanks.length} 个 —— 打空枪比没有变异更坏, 必须重做:\n  ` + blanks.join('\n  '));
    process.exit(1);
  }
  console.log('0 空枪 OK');
}

main();
