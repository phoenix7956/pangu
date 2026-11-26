// 2026-10-16 —— 汇报契约强制写的那一栏「③ 未做」不许再当认罪书
//
// 现场 lt-after-222442 (云端 minimax-m3.1-flash, 一刀一个文件改造的连带动):
//   3×离 各读完自己那一个文件并如实汇报 → 兑只读汇报 → 兑判 PASS → 乾合成。
//   stderr 里连着 7 次:
//     [j2-auto-resume] 上一轮续跑无实质进展 (done 0→0, files 0→0), 直接收口
//     [j2-auto-resume] 上限到达且无实质进展 (4/3, done=0, files=0)
//   每个离 4~9 轮 (本刀只要 1 轮: read_file + exec_command + task_done 36s 收工),
//   白烧的每一轮都是一次约 20s 的 LLM 调用。
//
// 链条:
//   汇报契约 (session_container.REPORT_CONTRACT) 强制写「③ 未做: <没做到/跳过/存疑;
//   没有就写"无">」→ lexicalIsPartial 的 _GENERIC_PARTIAL_RE 里就有 未做/未读/剩余
//   → 划了界的诚实披露被判 partial → task_done 被判"部分交付"
//   → _tryAutoResume('partial_task_done') 接管 → 白烧 3~4 轮。
//
// 两个坑, 都是这次现场测出来的, 不是想出来的:
//   ① **词法这条路是热路径不是兜底**: _judgeSummaryCompletion 开头就是
//      `if (... || _steps.length === 0) return _lex;` —— 分析类刀没有 plan 步,
//      LLM 判官压根不跑。所以只改判官提示词等于没改。
//   ② 两个半机制叠在一栏上会互相咬, 而且往危险的方向咬: 逐句剥离把划界句摘掉,
//      而同栏后面的真缺口 (`t2.txt 还没建`) 又不在 _GENERIC_PARTIAL_RE 词表里
//      → 真缺口被漏判成 completed。T11 钉死这个混合场景。
//
// 这道护栏的重点不是"放过划界", 是**真缺口一步都不许松** (T7~T10)。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('fs');

const { lexicalIsPartial } = require('../modules/summary_completion');
const SRC = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// ---- 现场原话 (lt-after-222442 三个离的「③ 未做」栏逐字抄的) ----------------
const LIVE_1 = '③ 未做: 未读 checkpoint.js / handoff.js（按指令不扩展）';
const LIVE_2 = '③ 未做: 未打开 plan_state.js/task_ledger.js（受"不得读另外三个文件"约束）；未做运行时验证';
const LIVE_3 = '③ 未做: 未验证 estimateMessagesTokens（超出本刀范围）';

test('T1 现场原话三条都不再被判 partial —— 白烧轮次的源头掐掉', () => {
  for (const [txt, name] of [[LIVE_1, '原话1 按指令不扩展'], [LIVE_2, '原话2 受约束'], [LIVE_3, '原话3 超出本刀范围']]) {
    assert.strictEqual(lexicalIsPartial(txt), false, `${name} 不该判 partial`);
  }
});

test('T2 契约的空栏豁免没被破坏', () => {
  assert.strictEqual(lexicalIsPartial('③ 未做: 无'), false);
  assert.strictEqual(lexicalIsPartial('① 完成: 分析了 a.js\n③ 未做: 无\n④ 交接: 没了'), false);
});

test('T3 「本就不该跑/本刀不涉及」这类划界说法也认', () => {
  assert.strictEqual(lexicalIsPartial('③ 未做: 未执行 compaction 相关测试用例验证结论（本就不该跑）'), false);
  assert.strictEqual(lexicalIsPartial('③ 未做: 本刀不涉及运行测试'), false);
});

// ---- 以下是这道修正最危险的边界: 真缺口一个都不许被放过 ----------------------

test('T4 本刀范围内的真缺口照判 partial', () => {
  assert.strictEqual(lexicalIsPartial('③ 未做: 本刀范围内还有 2 项没做，等下一轮'), true);
});

test('T5 没划界词的真剩余照判 partial', () => {
  assert.strictEqual(lexicalIsPartial('① 完成: 建了 t1.txt\n③ 未做: t2.txt 还没建'), true);
  assert.strictEqual(lexicalIsPartial('③ 未做: 剩余 3 个文件待处理'), true);
  assert.strictEqual(lexicalIsPartial('① 完成: 建了 t1.txt\n④ 交接: 还有 2 个文件要写，下一轮继续'), true,
    '续作意图必须仍然触发续跑');
});

test('T6 「本刀范围」不带「外/之外」时不许被当成划界词', () => {
  // 词表里是 本刀范围外 / 本刀范围之外 / 超出本刀, 不是裸的 本刀范围 ——
// 裸词会把「本刀范围还有 2 项没做」这种真缺口也摘掉, 那这道修正就成了漏斗。
  assert.strictEqual(lexicalIsPartial('③ 未做: 本刀范围还没做完'), true);
});

test('T7 混合场景: 一栏里既有划界又有真缺口 → 整栏判 partial, 不许只摘划界那句', () => {
  assert.strictEqual(
    lexicalIsPartial('③ 未做: 未读 a.js（按指令不扩展）；但 t2.txt 还没建'), true,
    '这一条是 T11 那次翻车的现场: 逐句剥离把划界句摘了, 同栏的真缺口跟着漏掉');
});

// ---- 机制层: 不许靠"两个半机制叠着"蒙对 -------------------------------

test('T8 词法这条路是热路径 —— 只改判官提示词等于没改', () => {
  //
  // 2026-10-17 这条断言本身被推翻了, 而且它一直红着没人看见 ——
  // test:chain 是 && 串联, 上游 role-gate-wiring W14 报假红 (已修) 把后面全堵死了,
  // 所以 35b6bf2 带着一条**和它自己矛盾**的护栏就提交了, 链上根本没跑到这里。
  //
  // 旧断言要求: "没有 plan 步时判官不跑, 词法说了算 —— 这条不许被改掉"。
  // 现场证据把它推翻了 (session lt3-1792176406069#sub-0-analyzer 的 ledger):
  //   lessons=[] steps=[] —— 判官**一条记录都没写**, 一次都没被调用过。
  // 分析类子 agent 根本没有 plan 步 (整个活就是"读这个文件给 3 个要点"),
  // 于是 2026-09-16 起往判官提示词里加的划界规则 A/B 全部是死代码 ——
  // 2026-10-16 那次"③ 未做不当认罪书"的修复也就跟着修在了死路上, 线上纹丝不动。
  //
  // 所以现在钉的是**真正的不变量**: 判官不可用才回落词法。
  // 「没有 plan 步」不是判官不可用的理由 —— 恰恰相反, 剩下的计划为空
  // 正是最该问"这一刀该做的做完了没有"的场合。
  //
  // 扫之前先剥注释 —— 2026-10-17 又栽一次: summary_completion.js 顶上那行注释
  // 正是**引用被删掉的那句旧代码** (在解释为什么删), 断言原样扫全文就撞上自己的注释,
  // 报出一个代码明明没有的"又回来了"。
  const _codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .filter(l => !/^\s*\/\//.test(l)).join('\n');
  const src = SRC('modules/j2_agent_loop.js');
  // 2026-10-23 (第 59 批): 兜底值从裸布尔 `_lex` 换成结构化的进度判局
  //   (summary_completion.lexicalProgressShape)。兜底**行为没变**,
  //   变的只是兜底值长什么样 —— 所以这条断言跟着改字面量。
  assert.match(src, /if \(!_deps \|\| !_deps\._callLLMForAgent\) return _fallback;/,
    '只有判官不可用才回落词法');
  assert.doesNotMatch(_codeOnly(src), /_steps\.length === 0\) return _fallback;/,
    '"没有 plan 步就不跑判官" 这条短路又回来了 —— 那是判官从未被调用的根因 '
    + '(ledger lessons=[] steps=[] 就是它留下的), 不许复活');

  const sc = SRC('modules/summary_completion.js');
  assert.match(sc, /if \(!o\.callLLM\) return fallback\.isPartial;/,
    '两份拷贝口径必须一致: 只有判官不可用才回落词法');
  assert.doesNotMatch(_codeOnly(sc), /o\.planSteps\.length === 0\) return fallback/,
    'summary_completion 这份拷贝里也不许有"没有 plan 步就不跑判官"的短路 '
    + '(两份拷贝历史上就是各写一遍, 漂过)');
});

test('T9 两份判官提示词都带上了划界规则, 不许只改一处', () => {
  // 2026-10-23 (第 59 批): 判官**搬家**了 —— 提示词、JSON 解析、判局映射
  //   全部收进 modules/summary_completion.js (唯一真源), j2_agent_loop.js 只留
  //   传输层(预算/超时/兜底)。之前两处各写一份, 划界规则的信号词表**已经漂了**。
  //
  // 所以这条断言从"扫两个文件里有没有那句话"改成
  //   **"真正发出去的那条提示词"里有没有那句话** ——
  // 它比原来更强: 原来只保证「文件里写着」, 现在保证「模型收到的是这句」。
  // 而且它天生免疫"搬家"这类改动 —— 提示词挪到哪儿都行, 挪走了就红。
  const sc = require(path.join(__dirname, '..', 'modules', 'summary_completion.js'));
  const prompt = sc.buildProgressJudgePrompt('① 完成: 写了 3 个文件\n③ 未做: 无', []);
  assert.match(prompt, /划界规则/, '真正发出去的判官提示词必须有划界规则');
  assert.match(prompt, /兄弟刀该干的活/, '真正发出去的提示词必须点名"别人的活不算缺口"');
  // 划界规则 B 的信号词不许被改漏 —— 这一版词表是按**现场真话**收的,
  // 不是按想象收(2026-10-16 补过一次, 10-17 又漏一批, 两次都是同一个教训)。
  for (const kw of ['按指令不扩展', '不在我这一刀', '本刀范围', '已交给下一棒', '未修改(本就不该改)']) {
    assert.ok(prompt.includes(kw),
      `真正发出去的提示词丢了划界信号词「${kw}」—— 补的时候要照现场原话收, 不是照想象收`);
  }
  // 新契约: 让模型只列条目、不下结论。
  assert.match(prompt, /不许自己下结论/, '判官必须交代"你只列条目, 结论由内核算"');
  assert.doesNotMatch(prompt, /"completed":\s*true\|false/,
    '判官还在问布尔 —— 那是第 59 批要换掉的东西');
});

test('T10 差异性质: 否决词表真在起作用 —— 抽掉它, 混合场景当场翻车', () => {
  // 不反查 git HEAD (会被 rebase / 换基线骗过), 也不写一条自说自话的"抽掉还得成立"。
  // 做法: 拿"否决词表清空"的副本跑**同一个**判据, 必须从 true 掉到 false ——
  // 掉不下去就说明这层修正没接线, T7 是假阳性。
  const src = SRC('modules/summary_completion.js');
  const noVeto = src.replace(/_REAL_REMAINING_RE = \/[^;]*;/, '_REAL_REMAINING_RE = /(?!)/;');
  assert.notStrictEqual(noVeto, src, '否决词表没匹配上, 差异性质这测等于没测');
  const p = path.join(__dirname, '.tmp-veto-probe.js');
  fs.writeFileSync(p, noVeto);
  try {
    delete require.cache[require.resolve('../modules/summary_completion')];
    const withVeto = require('../modules/summary_completion');
    const withoutVeto = require(p);
    const MIXED = '③ 未做: 未读 a.js（按指令不扩展）；但 t2.txt 还没建';
    assert.strictEqual(withVeto.lexicalIsPartial(MIXED), true);
    assert.strictEqual(withoutVeto.lexicalIsPartial(MIXED), false,
      '抽掉否决词表后混合场景应当漏判 —— 这证明该词表确实是拦真缺口的那道闸');
  } finally {
    try { fs.unlinkSync(p); } catch (_) {}
    delete require.cache[require.resolve('../modules/summary_completion')];
  }
});

test('T11 这道护栏自己必须接进 test:chain —— 没人跑的护栏等于装饰', () => {
  // 现场教训: 上一轮的 subagent-no-sibling-reread 写完 14 条断言全绿, 但
  // package.json 的 test:chain 是一份**显式文件清单**, 新文件没被加进去 ——
  // 于是 chain 跑出来的 1151 项跟加护栏之前一模一样, 护栏从没被执行过。
  // "注释 ≠ 隔离" 的同一个坑, 这次落在测试自己身上。
  // 2026-10-31 第 180 批: 段落表搬到了 scripts['test:chain:segments'] ⇒ 走统一读法。
  const chain = require('./helpers/chain_cmd').chainCommand();
  assert.ok(chain.length > 0, 'test:chain 必须存在');
  for (const f of [
    'tests/scoped-notdone-not-partial-20261016.test.js',
    'tests/subagent-no-sibling-reread-20261016.test.js',
  ]) {
    assert.ok(chain.includes(f), `${f} 必须出现在 test:chain 里, 否则它永远不会被执行`);
  }
});
