const test = require('node:test');
const assert = require('node:assert/strict');

const { _answerAdmitsIncomplete } = require('../modules/j2_dispatcher');

// ─────────────────────────────────────────────────────────────────────────────
// 实案 sustained-01-20261012。主人要一张 122 个 .js 文件的首行索引表, 盘古 7 秒就放弃了,
// 而且更糟 —— 它当着老板的面说没干完, 徽章却亮绿的:
//
//   答复: "当前仅成功读取并排序了部分 .js 文件…索引文件 /tmp/x.md 也未生成。
//          结论：本次任务未完成，不能报告为全量索引。"
//   done: {"status": "completed", "success": true}
//
// 旧判据 _FFFailed 只查**子 agent 的 summary**, 老板实际看到的 finalText 从来没进过判据;
// 而且正则只有 /未通过|未核验|请重试|熔断|无法完成|不通过/, 认不出"尚未生成/未完成"这类
// 最常见的自认没做完。徽章撒谎比慢一点严重得多, 所以这条判据只往"宁可 partial"偏。
// ─────────────────────────────────────────────────────────────────────────────

test('答复自认没做完 → 必须判为未完成', () => {
  // 全部是本轮真实出现过的答复原文
  const admits = [
    '当前仅成功读取并排序了部分 .js 文件，输出在 memory_helpers.js 处截断，未证明覆盖全部文件；索引文件 /tmp/module_firstline_20261012.md 也未生成。',
    '结论：本次任务未完成，不能报告为全量索引。',
    '当前八字排盘未成功，工具返回 MISSING_DATE，因此没有生成可核验的四柱。',
    '已核实目录存在 .js 文件。但当前工具权限仅允许只读，未能写入 /tmp/x.md，因此索引表尚未生成。',
    '该文件未落地，无法完成后续步骤。',
    '报告未写出，无法交付。',
  ];
  for (const t of admits) {
    assert.equal(_answerAdmitsIncomplete(t), true, `应判未完成: ${t.slice(0, 40)}`);
  }
});

test('正常交付不能被误伤成未完成 (反向保护)', () => {
  // 全部是本轮真实出现过的**成功**答复原文 —— 误伤它们会把正常交付打成 partial
  const done = [
    '已递归列出 **122 个 .js 文件**，清单：/tmp/longtask_js_files_20261012.txt。',
    '已完成并交付： .js 文件 122 个 / 总行数 37,847 行 / 报告已写入并核验：/tmp/longtask_report_20261012.md / task_done 已交付',
    '记住了，主人：你叫**孙七**，生日是**1986年3月15日**。',
    '你叫孙七。   生日是1986年3月15日',
    '限制：第 4 步仅完整取得 tools/index.js 前 30 行；其余两份未取得逐行原文，报告已如实标注。',
    '已核实四柱前三柱：**丙寅年、辛卯月、戊午日**。因未提供出生时辰，时柱无法确定。',
    '今日贵州茅台收 1680.20 元，涨 1.2%。建议观望。',
  ];
  for (const t of done) {
    assert.equal(_answerAdmitsIncomplete(t), false, `被误伤: ${t.slice(0, 40)}`);
  }
});

test('"未取得逐行原文"这种如实标注的限制说明不算自认未完成', () => {
  // 长任务交付里最常见的收尾句: 诚实标注局限, 但主任务确实做完了。
  assert.equal(_answerAdmitsIncomplete('其余两份未取得逐行原文，报告已如实标注。'), false);
  assert.equal(_answerAdmitsIncomplete('未提供出生时辰，时柱无法确定。'), false);
});

test('旧正则的失败措辞继续认 (不重复维护两份口径)', () => {
  for (const t of ['验收未通过', '子任务熔断了', '请重试', '结论不通过']) {
    assert.equal(_answerAdmitsIncomplete(t), true, `旧口径应继续生效: ${t}`);
  }
});

test('空 / 非字符串不炸, 也不算未完成', () => {
  for (const v of ['', null, undefined, 0, {}]) {
    assert.equal(_answerAdmitsIncomplete(v), false);
  }
});

test('所有交付答复的收口路径都必须接上自认未完成判据', () => {
  const src = require('node:fs').readFileSync(require.resolve('../modules/j2_dispatcher.js'), 'utf8');
  // 2026-10-23(第 65 批): 交付收口收成**唯一出口** `_closeOut` 之后,
  // 「交付答复的收口路径」= `_closeOut({...})` 里 status 由判据合出来的那几个调用点。
  //
  // 为什么必须跟着换: 旧写法扫的是 `resDone({...result: finalText...})`, 而现在
  // dispatcher 里**一个直接 resDone 都没有**(那正是第 65 批要的)。
  // 判据不换的话, 它会扫到 0 条 —— 然后 `>= 4` 应当报警的, 反而变成"扫到 0 条所以算了"。
  // **判据扫不到东西时静默放过, 比扫错了更坏。**
  //
  // 顺带把覆盖范围补齐: 旧写法只扫 `result: finalText`, 漏了直答那条(result: _daText);
  // 现在按 status 三元式筛, 直答 / fixed_flow / 关键词兜底 / 主路径 **四条都在**。
  // 空输入早退 / 配额 fast-fail 那种本来就带 status:'failed' (不是三元式), 仍然扫不进来。
  const { parseJs, callSites } = require('./helpers/js_ast');
  const tree = parseJs(src);
  const calls = callSites(tree, '_closeOut')
    .filter((s) => /status:\s*[A-Za-z_$][\w$]*\s*\?/.test(s.args[0] ? s.args[0].text : ''))
    .map((s) => s.args[0].text);
  assert.ok(calls.length >= 4,
    `fixed_flow + dispatcher + keyword_fallback + 直答 都该在这, 实际只找到 ${calls.length} 条交付收口`);

  const statusVars = new Set();
  for (const call of calls) {
    const m = call.match(/status:\s*([A-Za-z_$][\w$]*)\s*\?\s*'partial'/);
    assert.ok(m, `交付收口没有按判据给 status (徽章会亮绿): ${call.slice(0, 150)}`);
    statusVars.add(m[1]);
    assert.match(call, /success:\s*!/, `交付收口没带 success 字段: ${call.slice(0, 150)}`);
  }
  // 每个 status 变量都必须是由"自认未完成"判据 (直接或间接) 合出来的
  for (const v of statusVars) {
    const decl = src.match(new RegExp(`const ${v} = [^;]*;`));
    assert.ok(decl, `找不到 ${v} 的定义`);
    assert.match(decl[0], /_answerAdmitsIncomplete|_ffAdmits|_kAdmits|_admits|_childFailed/,
      `${v} 的定义没接自认未完成判据: ${decl[0].slice(0, 150)}`);
  }
});
