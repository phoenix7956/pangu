'use strict';
/**
 * 第 65 批变异体检 —— 验「tests/dispatcher-closeout-single-20261023.test.js」
 * 与「tests/session-persist-regression.test.js」的判据真能咬住。
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
 *   · dispatcher 里恢复直接 resDone 调用 (回到「各处各自收口」的老形状)
 *   · dispatcher 里恢复直接 _persistParent 调用 (同上)
 *   · 落盘时传空字符串, 不落 result 原文 (上屏的是 A、落盘的是 B)
 *   · persist:false 又没写理由却不 warn (静默丢一轮)
 *   · 某个出口删掉落盘规格 (回到「靠记性」)
 *   · 某个出口把落盘状态抄错名字 ('done' 不是合法状态)
 *   · 关键词兜底那条出口改成 persist:false (复原 2026-10-16 那个事故)
 *   · 唯一出口接不上 _persistParent (接了个 null)
 *   · 又抄一份兜底摘要构造 (两份抄本必然各自漏掉同一个修复)
 *   · 兜底默认落盘状态从 completed 改成 active
 *   · resDone 调两次 (双收口)
 *   · 第二条关键词兜底路又自己收了一次口 (双落盘)
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CORE = path.join(__dirname, '..', '..');
const DISPATCHER = path.join(CORE, 'modules', 'j2_dispatcher.js');
const CLOSEOUT = path.join(CORE, 'modules', 'dispatcher_closeout.js');

const TESTS = [
  path.join('tests', 'dispatcher-closeout-single-20261023.test.js'),
  // 老判据也一起跑: 第 65 批把它的**量法**换了(数直接调用点 → 查唯一出口的接线),
  // 意图没放松。改判据的人必须给自己上枷锁。
  path.join('tests', 'session-persist-regression.test.js'),
];

function runTest() {
  for (const t of TESTS) {
    try {
      execFileSync('node', ['--test', t], { cwd: CORE, stdio: 'pipe', timeout: 120000 });
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

/**
 * 替换**第 n 次**出现的位置(0 起)。
 *
 * 为什么需要它: `rep` 要求恰好命中 1 次, 而本批有几处就是要改「第二处」
 * (比如两条关键词兜底路都调 `_keywordFallbackCloseOut`, 变异只想改后一条)。
 * 硬用 rep 会因为命中 2 次而抛 —— 那是锚点太松, 不是变异太毒。
 */
function repNth(src, find, to, nth) {
  const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gs');
  const hits = [...src.matchAll(re)];
  if (hits.length < nth + 1) {
    throw new Error(`出现次数不够: 要第 ${nth + 1} 次, 实际 ${hits.length}`);
  }
  const h = hits[nth];
  return src.slice(0, h.index) + to + src.slice(h.index + h[0].length);
}

const MUTANTS = [
  // ---- 接线层: 回到「各处各自收口」的老形状 ----
  {
    name: 'M1 dispatcher 里恢复直接 resDone 调用 (回到各处各自收口)',
    files: [
      [
        DISPATCHER,
        (s) =>
          rep(
            rep(
              s,
              "    _closeOut({\n      status: _kAdmits ? 'partial' : undefined,",
              "    resDone({\n      status: _kAdmits ? 'partial' : undefined,"
            ),
            "}, { persistState: _kAdmits ? 'partial' : 'completed' });",
            "});"
          ),
      ],
    ],
    why: '出口有 8 个, 只要有一个不落盘, 那一轮就消失 —— 靠记性守不住的',
  },
  {
    name: 'M2 dispatcher 里恢复直接 _persistParent 调用',
    files: [
      [
        DISPATCHER,
        (s) =>
          rep(
            s,
            "}, { persistState: _kAdmits ? 'partial' : 'completed' });",
            "}, { persistState: _kAdmits ? 'partial' : 'completed' });\n    _persistParent(finalText, 'completed');"
          ),
      ],
    ],
    why: '落盘绕开唯一出口 = 又回到「哪些出口记得落盘」靠人记',
  },
  {
    name: 'M7 唯一出口接不上 _persistParent (接了个 null)',
    files: [[DISPATCHER, (s) => rep(s, "    persistParent: _persistParent,", "    persistParent: null,")]],
    why: '结构对了但依赖断了 = 每次落盘都只 warn, 父会话照样没有',
  },

  // ---- 落盘内容层: 上屏的 A 和落盘的 B 不是一回事 ----
  {
    name: 'M3 落盘时传空字符串, 不落 result 原文',
    files: [[CLOSEOUT, (s) => rep(s, "const answer = String(o.result || '');", "const answer = '';")]],
    why: '下一轮读的是落盘那份 —— 落成空的, 上下文就断了',
  },
  {
    name: 'M9 兜底默认落盘状态从 completed 改成 active',
    files: [[CLOSEOUT, (s) => rep(s, "sp.persistState || 'completed'", "sp.persistState || 'active'")]],
    why: 'active = 这轮还没定 —— 父会话被当成半截, 续跑会拿它当断点',
  },
  {
    name: 'M10 resDone 被调了两次',
    files: [[CLOSEOUT, (s) => rep(s, "      resDone(o);", "      resDone(o);\n      resDone(o);")]],
    why: '双收口 = 双记账双断流, 事件流里出现两个终态',
  },

  // ---- 静默降级层: 不落盘又不写理由 ----
  {
    name: 'M4 persist:false 没写理由却不 warn (静默丢一轮)',
    files: [
      [
        CLOSEOUT,
        (s) =>
          rep(
            s,
            "      if (!why) {\n        log.warn('[dispatcher-closeout] 这个出口不落盘但没写理由 —— 父会话会丢这一轮');\n      } else {\n        log.log('[dispatcher-closeout] 本出口不落盘:', why);\n      }",
            "      log.log('[dispatcher-closeout] 本出口不落盘:', why);"
          ),
      ],
    ],
    why: '不落盘又不喊 = 这一轮的丢没了, 下次还会有人这么改',
  },

  // ---- 出口规格层: 靠记性填的那部分 ----
  {
    name: 'M5 某个出口删掉落盘规格 (回到「靠记性」)',
    files: [
      [
        DISPATCHER,
        (s) => rep(s, "          { persistState: 'failed' },\n        );", "        );"),
      ],
    ],
    why: '漏一个出口 = 那一轮刷新即消失, 而且没有任何报错',
  },
  {
    name: 'M12 某个出口把落盘状态抄错名字',
    files: [
      [
        DISPATCHER,
        (s) => rep(s, "          { persistState: 'failed' },\n        );", "          { persistState: 'done' },\n        );"),
      ],
    ],
    why: '合法状态只有四个 —— 抄错名字的落盘没人认, 父会话被当成半截',
  },
  {
    name: 'M6 关键词兜底那条出口改成 persist:false (复原 2026-10-16 那个事故)',
    files: [
      [
        DISPATCHER,
        (s) =>
          rep(
            s,
            "}, { persistState: _kAdmits ? 'partial' : 'completed' });",
            "}, { persist: false, persistWhy: '关键词兜底不落盘' });"
          ),
      ],
    ],
    why: '2026-10-16: 「Planner failed: LLM timeout 300s」→ 走兜底 → 答完了上屏了, 父会话没落盘',
  },
  {
    name: 'M8 又抄一份兜底摘要构造 (两份抄本必然各自漏掉同一个修复)',
    files: [
      [
        DISPATCHER,
        (s) =>
          rep(
            s,
            "    const toolHistorySummaries = _buildFallbackSummaries(resultsRef);",
            "    const toolHistorySummaries = _buildFallbackSummaries(resultsRef);\n    const _dupSummaries = _buildFallbackSummaries(resultsRef);"
          ),
      ],
    ],
    why: '抄一遍就多一处会漏的地方 —— 本批那份 3050/2918 字符的抄本就是这么漏的',
  },
  {
    name: 'M11 第二条关键词兜底路又自己收了一次口 (双落盘)',
    files: [
      [
        DISPATCHER,
        (s) =>
          repNth(
            s,
            "      await _keywordFallbackCloseOut(results);",
            "      await _keywordFallbackCloseOut(results);\n      _closeOut({ mode: 'keyword_fallback', result: finalText }, { persistState: 'completed' });",
            1
          ),
      ],
    ],
    why: '一条轮收两次 = 落盘两份、事件流两个终态, 读的人不知道哪份是真的',
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
      console.log(`✓ 咬住 ${m.name}\n    失败于: ${firstFail.trim()}`);
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

