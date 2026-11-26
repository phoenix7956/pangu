'use strict';
/**
 * 第 67 批变异体检 —— 验「tests/final-answer-disk-truth-20261023.test.js」
 * 与「tests/r80-plan-guard.test.js」的判据真能咬住。
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
 *   · 空计划判据退回「词表版」(现场 b66 那次误判的老形状)
 *   · 空计划判据少一道「完成体」检查 (把「读取了…」也当待办)
 *   · 落盘顺序退回第 67 批之前 (finally 无条件落盘 + 末尾不落盘)
 *   · 落盘「追加一条」而不是「改写最后一条」(自己连说两遍)
 *   · summary 的内部脚手架又回到 messages (主人从没说过的 user 轮)
 *   · 屏上原文记成模型原话 (think 标签没剥就落盘)
 *   · 落盘取 finalText 而不是屏上原文 (改写之后就不是屏上那段了)
 *   · finally 收口里的兜底落盘被删 (主循环抛异常时整轮对话蒸发)
 *   · helper 名字对了但函数体里不落盘 (判据被磨成「只要提到就算」的空话)
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CORE = path.join(__dirname, '..', '..');
const AGENT_LOOP = path.join(CORE, 'modules', 'j2_agent_loop.js');
const LOOP_SHARED = path.join(CORE, 'modules', 'j2_loop_shared.js');

const TESTS = [
  path.join('tests', 'final-answer-disk-truth-20261023.test.js'),
  // 老判据也一起跑: 第 67 批把它的**判据**换了(词表 → 结构), 意图没放松。
  // 改判据的人必须给自己上枷锁。
  path.join('tests', 'r80-plan-guard.test.js'),
  // 第 67 批把 finally 收口的落盘抽成了 helper, 老判据(session-persist-regression)
  // 因此从「块内字面 _persistSession」改成「块内 → helper → _persistSession」两跳。
  // 判据改了就得让它继续能咬: M10/M11 是给它上的枷锁。
  path.join('tests', 'session-persist-regression.test.js'),
];

function runTest() {
  // 归因: 哪个**文件**挂了要记下来。
  //   为什么: harness 一口气跑好几个测试文件, 只报「第一个 not ok」的话,
  //   一个变异在 A 文件里挂了就永远看不到它在 B 文件里挂没挂 ——
  //   于是「B 文件那条判据到底还能不能咬住」就没人验得了 (第 67 批 M11 就吃过这个亏)。
  const failed = [];
  for (const t of TESTS) {
    try {
      execFileSync('node', ['--test', t], { cwd: CORE, stdio: 'pipe', timeout: 120000 });
    } catch (e) {
      failed.push({
        file: path.basename(t),
        out: String(e.stdout || '') + String(e.stderr || ''),
      });
    }
  }
  return {
    pass: failed.length === 0,
    out: failed.map((f) => f.out).join('\n'),
    failedFiles: failed.map((f) => f.file),
  };
}

/**
 * 变异后的文件**必须还能被 node 解析**。
 *
 * 为什么这条是硬要求: 语法错误的变异照样会让测试 FAIL, harness 会兴高采烈地
 * 记成「咬住了」—— 那是**假咬住**。测试失败的原因必须是本文件的判据,
 * 不是「文件根本加载不了」。
 */
function syntaxOk(files) {
  for (const f of files) {
    try {
      execFileSync('node', ['--check', f], { stdio: 'pipe' });
    } catch (e) {
      return {
        ok: false,
        detail: String(e.stderr || e.stdout || e.message).split('\n').slice(0, 3).join(' '),
      };
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

// 第 67 批之前的空计划判据 (词表版) —— 复原它就等于把 b66 那次误判装回去。
const OLD_EMPTY_PLAN = `function _looksLikeEmptyPlan(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length < 30) return false;
  const cnSteps = t.match(/第\\s*[一二三四五六七八九十\\d]+\\s*步/g) || [];
  if (cnSteps.length >= 2) return true;
  const numbered = t.match(/^\\s*(?:\\*\\*)?\\d+[\\.、\\)]/gm) || [];
  if (numbered.length >= 3 && /(读取|确认|检查|分析|查看|梳理)/.test(t)) return true;
  return false;
}`;

const MUTANTS = [
  {
    name: 'M1 空计划判据退回词表版 (复原 b66 那次误判)',
    files: [
      [
        LOOP_SHARED,
        (s) =>
          rep(
            s,
            /function _looksLikeEmptyPlan\(text\) \{[\s\S]*?\n\}/,
            () => OLD_EMPTY_PLAN
          ),
      ],
    ],
    why: '词表判据只要「正文任意位置」出现某个词 —— 正常答案也会命中',
  },
  {
    name: 'M2 空计划判据少一道「完成体」检查 (把「读取了…」也当待办)',
    files: [
      [
        LOOP_SHARED,
        (s) => rep(s, "  if (_PLAN_COMPLETED_RE.test(s)) return false;     // 已完成 / 有结果 ⇒ 不是待办\n", ""),
      ],
    ],
    why: '结构判据要钉「是不是只有步骤没有结论」—— 少了完成体这一半就退化成半个词表',
  },
  {
    name: 'M3 落盘顺序退回第 67 批之前 (finally 无条件落盘 + 末尾不落盘)',
    files: [
      [
        AGENT_LOOP,
        (s) =>
          rep(
            rep(
              s,
              "    if (!_loopBodyCompleted) {",
              "    if (true) {"
            ),
            "  await _persistFinalAnswer();\n  // 2026-08-02: 返回结果给 dispatcher 子任务路径",
            "  // 2026-08-02: 返回结果给 dispatcher 子任务路径"
          ),
      ],
    ],
    why: '落盘跑在答案定稿之前 ⇒ 盘上存的是重写前那一版 (现场: 屏上 415 / 盘上 723)',
  },
  {
    name: 'M4 落盘把最后一条(哪怕是 tool 结果)也改写成答复',
    files: [
      [
        AGENT_LOOP,
        (s) =>
          rep(
            s,
            "        if (_lm && _lm.role === 'assistant' && !_lm.tool_calls && !_lm.function_call) {",
            "        if (_lm && _lm.role !== 'system') {"
          ),
      ],
    ],
    why: '工具结果是**证据** —— 答复落盘时把它顶掉, 下一轮模型就只剩一句光话',
  },
  {
    name: 'M5 summary 的内部脚手架又回到 messages',
    files: [
      [
        AGENT_LOOP,
        (s) =>
          rep(
            s,
            /      const _sumMessages = messages\.concat\(\[\{ role: 'user', content: '已调工具:[\s\S]*?' \}\]\);/,
            "      messages.push({ role: 'user', content: '已调工具: ' + _usedNames });\n      const _sumMessages = messages;"
          ),
      ],
    ],
    why: '那段「已调工具…」不是主人说的话, 不该进历史',
  },
  {
    name: 'M6 屏上原文记成模型原话 (think 标签没剥就落盘)',
    files: [
      [
        AGENT_LOOP,
        (s) => rep(s, "      emittedFinalText = clean;", "      emittedFinalText = String(t);"),
      ],
    ],
    why: '落盘必须是「屏上发出去的那段」, 不是模型原话',
  },
  {
    name: 'M7 落盘取 finalText 而不是屏上原文',
    files: [
      [
        AGENT_LOOP,
        (s) =>
          rep(
            s,
            "      const _diskText = String(emittedFinalText || finalText || '').trim();",
            "      const _diskText = String(finalText || '').trim();"
          ),
      ],
    ],
    why: 'finalText 在发出去之后还会被改 —— 拿它落盘就是存了另一段话',
  },
  {
    name: 'M8 落盘只写最后一轮 (把带历史的整份 messages 截断)',
    files: [
      [
        AGENT_LOOP,
        (s) =>
          rep(
            s,
            "      await _persistSession(_sessionId, messages, {",
            "      await _persistSession(_sessionId, messages.slice(-3), {"
          ),
      ],
    ],
    why: '落盘是**整份覆盖** —— 少写一条就等于把上一轮抹掉, 而且再也回不来',
  },
  {
    name: 'M9 连续性注入把本轮问题整段删掉 (请求不带历史时)',
    files: [
      [
        AGENT_LOOP,
        (s) =>
          rep(
            s,
            "        if (!_curStillThere && userInput) {\n          messages.push({ role: 'user', content: userInput });\n        }\n",
            ""
          ),
      ],
    ],
    why: '模型看不见主人刚问什么 ⇒ 答的是上一轮的事; 盘上历史里也查不到主人这一句',
  },
  {
    name: 'M10 finally 收口里的兜底落盘被删 (主循环抛异常时整轮对话蒸发)',
    files: [
      [
        AGENT_LOOP,
        (s) =>
          rep(
            s,
            "    if (!_loopBodyCompleted) {\n      await _persistFinalAnswer();\n    }\n",
            ""
          ),
      ],
    ],
    why: '正常路径末尾有权威落盘, 但异常/中断路径走不到那儿 ⇒ 这轮对话在盘上不存在',
  },
  {
    name: 'M11 落盘写到别的 session (helper 名字对了但没落到本会话)',
    files: [
      [
        AGENT_LOOP,
        (s) =>
          rep(
            s,
            "      await _persistSession(_sessionId, messages, {",
            "      await _persistSession('__mutant_wrong_sid__', messages, {"
          ),
      ],
    ],
    why: '判据若只查「有没有提到落盘」就是空话 —— 落盘必须落到**这一轮这个会话**',
  },
];

function main() {
  const files = [...new Set(MUTANTS.flatMap((m) => m.files.map((x) => x[0])))];
  const orig = new Map();
  for (const f of files) {
    const s = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
    if (s == null) {
      console.error(`✗ 基线文件不存在: ${f}`);
      process.exit(2);
    }
    orig.set(f, s);
  }
  const restore = () => {
    for (const [f, s] of orig) fs.writeFileSync(f, s);
  };

  const base = runTest();
  if (!base.pass) {
    console.error('✗ 基线测试本就不绿 —— 变异体检无从谈起, 先修测试');
    console.error(base.out.split('\n').filter((l) => /not ok|error:/.test(l)).slice(0, 6).join('\n'));
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
    } catch (e) {
      applied = false;
      note = e.message;
    }

    let r = { pass: true, out: '' };
    let syn = { ok: true };
    if (applied) syn = syntaxOk(m.files.map((x) => x[0]));
    if (applied && !syn.ok) {
      applied = false;
      note = '变异后语法坏了(假咬住): ' + syn.detail;
    }
    if (applied) r = runTest();

    if (!applied) {
      console.log(`⚠ ${m.name}\n    ${note}`);
      blanks.push(m.name + ' [锚点失效]');
    } else if (r.pass) {
      console.log(`✗ 空枪! ${m.name}\n    测试仍然 PASS —— 判据没咬住 (${m.why})`);
      blanks.push(m.name);
    } else {
      const firstFail = (r.out.match(/not ok \d+ - ([^\n]+)/) || [])[1] || '(未知)';
      const where = (r.failedFiles || []).length ? ` [${r.failedFiles.join(', ')}]` : '';
      console.log(`✓ 咬住 ${m.name}\n    失败于${where}: ${firstFail.trim()}`);
      live++;
    }
  }
  restore();

  console.log(`\n咬住 ${live} / ${MUTANTS.length}`);
  if (blanks.length) {
    console.log(
      `空枪/失效 ${blanks.length} 个 —— 打空枪比没有变异更坏, 必须重做:\n  ` + blanks.join('\n  ')
    );
    process.exit(1);
  }
  console.log('0 空枪 OK');
}

main();
