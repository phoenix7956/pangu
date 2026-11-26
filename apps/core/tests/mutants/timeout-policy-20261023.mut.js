'use strict';
/**
 * 第 64 批变异体检 —— 验「tests/timeout-policy-20261023.test.js」与
 * 「tests/session-persist-regression.test.js」的判据真能咬住。
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
 *   · 把真源里的某条超时从清单里删掉 (少认一种 = 那一刀被当成有产出)
 *   · 让分类退回「不认超时」 (就是本批那个洞本身)
 *   · 让「原地重试」的门不再显式排除超时 (只靠分支顺序不够)
 *   · 把超时分支挪到原地重试之后 (复原 2026-10-13 修过的同型病灶)
 *   · 续想时不把已想的留在上下文 (等于从头再来)
 *   · 续想时不收紧预算 (刹车没踩)
 *   · 续想不封顶 (无限烧)
 *   · 超时错误手工拼、不带 partial (已产出的东西全扔)
 *   · 消费者又抄一份超时清单 (两份同义分类必然漂)
 *   · 假的「legacy 降级」又回来 (useNative 是 const, 那条路不存在)
 *   · 思考被当成正文交出去
 *   · 文案丢「超时收口」标签 / 出现「失败」字样
 *   · 预算缩放的地板掉回 30s (比 prefill 还短 = 刹车踩成自杀)
 *   · 落盘点挪出 finally (本批顺手改的那条判据: 老写法是 4000 字符魔数窗口)
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CORE = path.join(__dirname, '..', '..');
const TP_MOD = path.join(CORE, 'modules', 'timeout_policy.js');
const SHARED = path.join(CORE, 'modules', 'j2_loop_shared.js');
const SLICE = path.join(CORE, 'modules', 'slice_death.js');
const LLM = path.join(CORE, 'modules', 'llm_caller.js');
const LOOP = path.join(CORE, 'modules', 'j2_agent_loop.js');

const TESTS = [
  path.join('tests', 'timeout-policy-20261023.test.js'),
  //
  // 本批把 session-persist-regression 的判据从「4000 字符魔数窗口」
  // 换成了「按 AST 节点取 finally 块」——
  // 改判据的人必须给自己上枷锁, 所以它也得一起跑。
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
 * 为什么需要它: 有些变异要动的是**多行拼接的整块代码**,
 * 而代码里全是中文标点和 `)` `'` —— 写成正则就得逐个转义,
 * 转错了不报错, 只是命中 0 次, 然后你花半小时以为是判据没咬住。
 * 用纯字符串做标记就没有这个坑。
 */
function repBetween(src, from, to, replacement) {
  const a = src.indexOf(from);
  if (a < 0) throw new Error(`起标记没找到: ${from.slice(0, 60)}`);
  if (src.indexOf(from, a + 1) >= 0) throw new Error(`起标记不唯一: ${from.slice(0, 60)}`);
  const b = src.indexOf(to, a + from.length);
  if (b < 0) throw new Error(`止标记没找到: ${to.slice(0, 60)}`);
  const end = b + to.length;
  return src.slice(0, a) + replacement + src.slice(end);
}

const MUTANTS = [
  // ---- 真源层: 超时清单与分类 ----
  {
    name: 'M1 真源把 STREAM_TOTAL_TIMEOUT 从清单里删掉 (最常撞的那种超时瞎了)',
    files: [[TP_MOD, s => rep(s, "  'STREAM_TOTAL_TIMEOUT',    // llm_caller: 总时长熔断 (本地默认 390s)\n", '')]],
    why: '少认一种 = 那一刀被当成「有产出」, 整轮 slice 不放弃, 接着再撞一次',
  },
  {
    name: 'M2 分类退回「不认超时」(本批那个洞本身)',
    files: [[SHARED, s => rep(s,
      '|| _timeout_policy.isTimeoutError(msg) || _timeout_policy.isConnectionError(msg);',
      '|| /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up/i.test(String(msg || \'\'));')]],
    why: '超时不是「基础设施错误」 ⇒ 掉进那句根本不存在的 legacy 降级 ⇒ 烧 390s 什么都不交',
  },
  {
    name: 'M18 超时被算成连接类瞬断 (混在一起 = 同 prompt 原样重试)',
    files: [[TP_MOD, s => rep(s,
      'function isConnectionError(msg) {\n  return new RegExp(CONNECTION_ERROR_PATTERN, \'i\').test(String(msg || \'\'));',
      'function isConnectionError(msg) {\n  if (isTimeoutError(msg)) return true;\n  return new RegExp(CONNECTION_ERROR_PATTERN, \'i\').test(String(msg || \'\'));')]],
    why: '超时 ≠ 瞬断: 超时去走原地重试, 必然再撞同一堵墙',
  },
  {
    name: 'M10 消费者又抄一份超时清单 (j2_loop_shared 内联 6 个名字)',
    files: [[SHARED, s => rep(s,
      '|| _timeout_policy.isTimeoutError(msg) || _timeout_policy.isConnectionError(msg);',
      '|| /STREAM_TOTAL_TIMEOUT|STREAM_IDLE_TIMEOUT|STREAM_PREFILL_TIMEOUT|LLM_SOCKET_TIMEOUT|LLM_FETCH_TIMEOUT|LLM_ROUND_TIMEOUT/.test(String(msg || \'\'))\n    || _timeout_policy.isConnectionError(msg);')]],
    why: '两份同义分类必然漂 —— 上一次就是 slice_death 认 3 种、shared 认 0 种',
  },
  {
    name: 'M8 slice_death 退回只认 3 种超时 (本批那半边)',
    files: [[SLICE, s => rep(s,
      'const SLICE_DEAD_RE = _buildTimeoutDeadRe(\n  \'额度已耗尽|端点连不上|\' + _CONN_RE);',
      'const SLICE_DEAD_RE = /额度已耗尽|端点连不上|ECONNRESET|ECONNRESET|ECONNREFUSED|LLM_SOCKET_TIMEOUT|STREAM_IDLE_TIMEOUT|STREAM_PREFILL_TIMEOUT/;')]],
    why: 'STREAM_TOTAL_TIMEOUT 恰恰是最常撞的那一种, 漏了它整轮 slice 不放弃',
  },

  // ---- 抢救层: 已产出的东西不许跟着超时一起扔 ----
  {
    name: 'M7 llm_caller 手工拼超时错误名, 不带 partial (总时长那一处)',
    files: [[LLM, s => repBetween(s,
      "          reject(_timeoutError('STREAM_TOTAL_TIMEOUT', _totalMs, {",
      "          }));",
      "          reject(new Error('STREAM_TOTAL_TIMEOUT_' + Math.round(_totalMs / 1000) + 's'));\n        ")]],
    why: '上层拿到的只有一个错误名 ⇒ 已流出来的内容/工具调用全扔 ⇒ 整轮从零重来',
  },
  {
    name: 'M9 _timeoutError 不挂 partial (工厂本身不传)',
    files: [[LLM, s => rep(s, '  err.partial = partial || null;', '  err.partial = null;')]],
    why: '同上: 分类对了, 但产物还是没带上',
  },
  {
    name: 'M12 splitThinkText 把思考当正文 (思考交出去 = 把模型的内心戏当答案)',
    files: [[TP_MOD, s => rep(s,
      "  const re = /<think>([\\s\\S]*?)(?:<\\/think>|$)/g;",
      "  const re = /$^/g;")]],
    why: '分了才谈得上「把已想的留下来」; 不分就等于既没留下思考、又污染了正文',
  },

  // ---- 处置层: 超时必须先于原地重试被处理 ----
  {
    name: 'M4 超时分支不再是最先处理的那一扇门 (复原 10-13 修过的同型病灶)',
    files: [[LOOP, s => rep(s,
      'if (_isTimeoutError(e.message)) {',
      'if (_isTimeoutError(e.message) && false) {')]],
    why: '超时落进 else = 原地重试 = 同一个 prompt 再来一次 = 必然再撞同一堵墙',
  },
  {
    name: 'M3 native 原地重试的门不再显式排除超时',
    files: [[LOOP, s => rep(s,
      'if (_isInfraError(e.message) && !_isTimeoutError(e.message) && _preferSameLocalRetry(model, _state)) {',
      'if (_isInfraError(e.message) && _preferSameLocalRetry(model, _state)) {')]],
    why: '光靠「分支排在前面」不够: 哪天有人把分支挪下去, 行为悄悄变了没人会发现',
  },
  {
    name: 'M19 legacy 流式原地重试的门不再显式排除超时 (第二扇门)',
    files: [[LOOP, s => rep(s,
      '        const _streamRetrySameLocal = _isInfraError(streamErr.message)\n          && !_isTimeoutError(streamErr.message)\n          && _preferSameLocalRetry(model, _state);',
      '        const _streamRetrySameLocal = _isInfraError(streamErr.message)\n          && _preferSameLocalRetry(model, _state);')]],
    why: '顺序那条判据只认 native 那一扇门, legacy 这扇必须另有行为层保证',
  },
  {
    name: 'M5 续想时先把已想的留在上下文这一步没了 (等于从头再来)',
    files: [[LOOP, s => rep(s,
      "              messages.push({ role: 'assistant', content: '<think>' + _tp.reasoning + '</think>' });\n",
      '')]],
    why: '那 2980 字白想, 而且必然再撞同一堵墙',
  },
  {
    name: 'M6 续想那轮不收紧预算 (刹车没踩)',
    files: [[LOOP, s => rep(s, '              _nextRoundStreamScale = 0.35;', '              _nextRoundStreamScale = 1;')]],
    why: '「走一步判断一步」得有点刚性: 不收紧 = 还能接着空想',
  },
  {
    name: 'M15 续想不封顶 (认账收口那条没了)',
    files: [[LOOP, s => rep(s,
      '} else if (_tp.reasoning && _timeoutResumeCount < 1) {',
      '} else if (_tp.reasoning && _timeoutResumeCount < 99) {')]],
    why: '续想是「逼它动一步」, 不是「给它无限时间」',
  },
  {
    name: 'M11 假的「legacy 降级」又回来 (useNative 是 const, 那条路根本不存在)',
    files: [[LOOP, s => rep(s,
      "            console.warn('[j2-native] 非基础设施错误, 收口: ' + e.message.slice(0, 120));",
      "            console.warn('[j2-native] fallback to legacy J2 XML path');")]],
    why: '注释写着「降级」而代码是「静默死掉」—— 注释 ≠ 隔离',
  },

  // ---- 措辞层: 正面式标签, 不装成失败 ----
  {
    name: 'M13 文案丢了「超时收口」这个正面式标签',
    files: [[TP_MOD, s => rep(s,
      "  const head = '【超时收口】' + kind + '在' + budget + '没算完。';",
      "  const head = '【超时】' + kind + '在' + budget + '没算完。';")]],
    why: '标签是给用户看的第一眼; 丢了就变成一句没头没尾的说明',
  },
  {
    name: 'M16 文案里出现「失败」两个字 (超时不是失败)',
    files: [[TP_MOD, s => rep(s,
      "  const head = '【超时收口】' + kind + '在' + budget + '没算完。';",
      "  const head = '【超时收口】' + kind + '在' + budget + '没算完(失败)。';")]],
    why: '超时是「这一轮算不完」, 说成失败会把它跟真挂掉混成一类',
  },
  {
    name: 'M14 预算缩放的地板掉回 30s (比 prefill 实际耗时还短 = 刹车踩成自杀)',
    files: [[TP_MOD, s => rep(s,
      'const MIN_SCALED_STREAM_TOTAL_MS = 120000;',
      'const MIN_SCALED_STREAM_TOTAL_MS = 30000;')]],
    why: '本地大 prompt 首字节就要 45~90s, 预算缩到比它还短必然又是一次超时',
  },

  // ---- 顺手改的那条判据: finally 落盘点 ----
  {
    name: 'M17 落盘点挪出 finally (本批把 4000 字符魔数窗口换成了 AST 取块)',
    files: [[LOOP, s => {
      let out = s;
      out = rep(out, [
        '      _persistSession(_sessionId, messages, {',
        '        round: rounds,',
        '        state: userAborted ? \'aborted\' : (taskDoneAccepted ? \'completed\' : \'active\'),',
        '        task_input: userInput,',
        '        plan_state: _state.planState || null,',
        '        final: true,',
        '      });',
        '',
      ].join('\n'), '');
      out = rep(out, [
        '    }',
        '  }',
        '',
        '// §0.56 修: task_done / abort 后清 _state',
      ].join('\n'), [
        '    }',
        '  }',
        '  _persistSession(_sessionId, messages, {',
        '    round: rounds,',
        '    state: userAborted ? \'aborted\' : (taskDoneAccepted ? \'completed\' : \'active\'),',
        '    task_input: userInput,',
        '    plan_state: _state.planState || null,',
        '    final: true,',
        '  });',
        '',
        '// §0.56 修: task_done / abort 后清 _state',
      ].join('\n'));
      return out;
    }]],
    why: '纯文本收尾的对话整轮丢失 —— 老写法是魔数窗口, 顶破了也不知道是判据过期还是真坏了',
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
    console.error(base.out.split('\n').filter(l => /not ok|error:/.test(l)).slice(0, 6).join('\n'));
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
