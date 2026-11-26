const test = require('node:test');
const assert = require('node:assert/strict');

const { wantsDirectAnswer } = require('../modules/j2_loop_shared');

// 2026-10-12 现场证据 (probe-ctx-20261012-1):
//   主人: "我刚才说我叫什么？生日是哪天？只回答这两个，不要调用任何工具。"
//   盘古: 照样调了 system_info ×2 —— native 路径无条件注入 "≥1 工具" 硬规则。
test('主人显式说了不要工具 / 直接答 → 判定为直答模式', () => {
  const yes = [
    '只回答这两个，不要调用任何工具',
    '2+2 等于几？直接答。',
    '我叫什么，生日是哪天？只答这两项。',
    '别调用工具，直接说结论',
    '不用查了，你直接回答我',
  ];
  for (const text of yes) {
    assert.equal(wantsDirectAnswer(text), true, `应判为直答: ${text}`);
  }
});

test('正常干活类请求不能被误判成直答', () => {
  const no = [
    '统计 ~/Desktop/pangu/apps/core/modules 下每个 .js 的行数',
    '帮我把这个 bug 修掉',
    '查一下贵州茅台今天的股价',
    '把这三个文件的内容读给我看',
  ];
  for (const text of no) {
    assert.equal(wantsDirectAnswer(text), false, `不应判为直答: ${text}`);
  }
});

test('空输入 / 非字符串不炸, 也不判直答', () => {
  for (const v of ['', null, undefined, 0, {}]) {
    assert.equal(wantsDirectAnswer(v), false);
  }
});

test('native 路径真的按判定切换硬规则, 而不是两套都注入', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../modules/j2_agent_loop.js'), 'utf8');
  assert.match(src, /const _nativeHardRule = _wantsDirectAnswer/, '硬规则必须由判定结果二选一');
  assert.match(src, /\? _directHint/, '直答时注入直答提示');
  // 原来的无条件版本不能再出现
  assert.doesNotMatch(
    src,
    /const _nativeHardRule = `\\n\\n\[!!! HARD RULE/,
    '"≥1 工具"硬规则不能再无条件注入'
  );
});

// ---------------------------------------------------------------------------
// 2026-10-12 现场证据 (probe-direct-2131, SSE 全量 dump):
//   主人: "我叫王铁柱,只回答我的名字,不要调用任何工具"
//   盘古: 99 秒 / 起 planner→analyzer+executor+checker→synthesis 综合, 21 次工具调用。
//   ① 主人明说"不要调用任何工具", analyzer/executor 照样调了 21 次工具 —— 直答意图完全失效;
//   ② checker 的 task 是空壳"验证结果"(主人只问名字, 根本没有"结果"可验),
//      无锚点 checker 只好自己找活干 → 去审计整个 git 工作区,
//      把一份关于 ledger-lessons.test.js 的代码审计报告当 FAIL 结论产出;
//   ③ 该 checker 脚手架整段泄漏给主人 —— 问个名字收到一份代码审计报告。
//   根因: wantsDirectAnswer 只喂给 runtimeStatus 判分(不让它自报失败),
//         完全没参与派工决策 → dispatcher 照旧起 analyzer + checker + 综合。
//   本组钉住: 直答轮走单 agent 直答路径, 砍掉 planner/子agent编排/综合;
//            同时防误伤 —— 需要真实数据才能答的"直接答"仍保留工具能力。
// ---------------------------------------------------------------------------
const fs = fs_mod();
function fs_mod() { return require('node:fs'); }

// 2026-10-17 (单刀直查那刀): 直答分支的条件从 `if (_directAnswerTurn)` 变成
//   `if (_directAnswerTurn || _singleShotTurn)` —— 四处锚点各写一遍, 改一处漏三处,
//   这正是踩坑日志 2026-10-16「同一份东西抄四遍 = 迟早只改其中一份」那条。
// 更糟的是漏掉的那两处**不会红**: indexOf 找不到就返回 -1, slice(-1, N) 从末尾切起,
// branch 成了空壳 → doesNotMatch 恒真 → 护栏"在岗但什么也没查"。
// 所以这里收成唯一锚点, 谁都用它。
const DIRECT_BRANCH_ANCHOR = 'if (_directAnswerTurn || _singleShotTurn)';
function directBranch(src) {
  const i = src.indexOf(DIRECT_BRANCH_ANCHOR);
  assert.ok(i > 0, '必须存在直答分支 (锚点: ' + DIRECT_BRANCH_ANCHOR + ')');
  const end = src.indexOf('const skipResult =', i);
  // end 找不到时不能退回 i+6000 硬猜 —— 那是让"锚点失配"伪装成"检查通过"的元凶。
  // 这里宁可断言失败。
  assert.ok(end > i, '直答分支的结束锚点 (const skipResult =) 必须能在分支之后找到');
  return src.slice(i, end);
}

test('直答轮 dispatcher 必须短路成单 agent 直答路径, 不起 planner/子agent/综合', () => {
  const src = fs.readFileSync(require.resolve('../modules/j2_dispatcher.js'), 'utf8');
  // 直答判定必须真正参与编排决策(不只是判分)
  // 2026-10-19: `_oneShotTurn` = 单刀直查 || 单目标阅读 —— 两条"一件事就完"的
  // 触发合流成一条通道, 因为运行语义完全相同。行为没变, 变量名从一种触发变成两种。
  assert.match(
    src,
    /if\s*\(\s*_directAnswerTurn\s*\|\|\s*_oneShotTurn\s*\)/,
    'dispatcher 必须按 _directAnswerTurn 走独立直答分支, 而非只用于判分'
  );
  // 直答分支必须是单 agent 坤 kun。
  // 2026-10-17: 这条分支后来又接了第二种触发 (_singleShotTurn, 一件短事实查询 →
  // 离 li 单刀直查, 见 tests/single-shot-lookup-20261017.test.js), 所以这里
  // 不再靠 `mode: 'kun'` 字面量定位, 改钉"角色由 _daMode 决定、且直答落到 kun"。
  // 2026-10-18: 角色名统一成拼音, 这两处字面量跟着换 (executor→kun, analyzer→li)。
  const _dBranch = directBranch(src);
  assert.match(
    _dBranch,
    /_daMode\s*=\s*_oneShotTurn\s*\?\s*'li'\s*:\s*'kun'/,
    '直答路径应由单个 kun 直接作答; 只有单刀直查那条才用 li'
  );
  assert.match(
    _dBranch,
    /mode:\s*_daMode/,
    '直答分支的子 agent 角色必须由 _daMode 决定'
  );
  // 两种触发都**不得**起 dui / kan / 综合 —— 那是"少几刀"的全部要害。
  // li 只允许出现在 _singleShotTurn 那一侧 (单刀直查), 那不是编排。
  assert.doesNotMatch(
    _dBranch,
    /mode:\s*'dui'|mode:\s*'kan'/,
    '直答/单刀路径都不得起 dui/kan 子agent'
  );
  // 直答轮不得进入 fixed_flow(skip_planner) 派工:
  // 必须在算 skipResult 之前就 return 掉(提前返回比改 skipResult 更彻底)
  const _skipIdx = src.indexOf('const skipResult =');
  assert.ok(_skipIdx > 0, 'dispatcher 必须有 skipResult 派工点');
  assert.ok(
    src.indexOf(DIRECT_BRANCH_ANCHOR) < _skipIdx,
    '直答分支必须排在 fixed_flow(skip_planner) 派工之前并提前 return'
  );
  // 直答分支体末尾必须 return, 保证不落到下面 planner/synthesis
  assert.match(
    _dBranch,
    /res\.end\(\)[\s\S]{0,40}?return;/,
    '直答分支作答后必须 res.end()+return, 不落回 planner/综合'
  );
});

test('直答分支不调 synthesis 综合 LLM, 直接把单 agent 答复上屏', () => {
  const src = fs.readFileSync(require.resolve('../modules/j2_dispatcher.js'), 'utf8');
  const branch = directBranch(src);
  assert.doesNotMatch(
    branch,
    /stage:\s*'synthesis'/,
    '直答轮不得再起 synthesis 综合(白烧一次 LLM)'
  );
});

test('需要真实数据才能答的"直接答"不能被误砍成禁工具', () => {
  const src = fs.readFileSync(require.resolve('../modules/j2_dispatcher.js'), 'utf8');
  const branch = directBranch(src);
  // executor 白名单保留工具 = "今天股价多少,直接答"仍能取数
  assert.match(
    branch,
    /toolsAllowed[\s\S]{0,200}?executor|_roleModelFor|executor/,
    '直答仍由 executor 承担并保留工具能力(能查数据)'
  );
});

test('直答判定沿用 wantsDirectAnswer, 不新增第二套正则', () => {
  const src = fs.readFileSync(require.resolve('../modules/j2_dispatcher.js'), 'utf8');
  // _directAnswerTurn 必须来自 wantsDirectAnswer(单一真源)
  assert.match(src, /_directAnswerTurn = \(\(\) => \{[\s\S]{0,160}?wantsDirectAnswer\(userInput\)/);
});
