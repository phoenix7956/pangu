'use strict';
// 2026-10-13 现场 (longwork-1791848076, 40 文件长任务):
//   账本真值: outcome artifacts_count=40, 三个 executor 分记 15/15/10,
//             checker 实测 PASS, 字节级细节(f00-f09=57B, f10-f39=58B, f38=61B)与磁盘吻合。
//   最终答案开头却是 analyzer **最早**那句快照:
//     "目录完全空(0 个条目)… f00–f39 **全部不存在** … ls f*.txt 无任何输出"
//   综合 LLM 把子 agent 自述原样背了回来(连 prompt 里的 --- 分隔符都一起背),
//   丢掉了喂给它的本轮真写盘清单, 并把最陈旧那段放在最前面。
//
//   既有守卫 _answerAdmitsIncomplete 只认"未创建/没有创建", 实测本答案的措辞全部漏网,
//   于是这个与账本**事实相反**的答案被当成正常答案送上了屏。
//
// 修法不是补措辞 (那是打地鼠), 是**对账**: 账本说本轮写了 N>0 个文件,
// 答案却说一个都没产出 —— 这是宣布, 不是措辞。直接以账本为准纠正。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-contrad-'));
process.env.PANGU_HOME = TMP;
// 2026-10-26 第 100 批: 账本目录走唯一真源 (modules/state_paths.js),
// 解析顺序 PANGU_LEDGER_DIR > PANGU_HOME/state/ledger > 生产默认。
// 只设 PANGU_HOME 会被链沙箱里的 PANGU_LEDGER_DIR 抢在前面 ⇒ 账本落到共享沙箱目录,
// 本测试的隔离意图 (自己的 TMP) 就没了。
process.env.PANGU_LEDGER_DIR = path.join(TMP, 'state', 'ledger');
process.env.PANGU_TASK_DIR = path.join(TMP, 'tasks');

const ledger = require('../modules/task_ledger');
const D = require('../modules/j2_dispatcher');

let n = 0;
function writeFiles(sid, count, ts) {
  for (let i = 0; i < count; i++) {
    ledger.recordToolResult(sid + '#sub-' + i + '-executor', 'write_file',
      { path: `/tmp/pangu_long/f${String(i).padStart(2, '0')}.txt`, content: '第 ' + i + ' 号专属文本-正文' },
      { ok: true, data: { ts } });
  }
}

// 现场答案原句 (截取)
const REAL_ANSWER = [
  '**核验结论（事实）**',
  '- `/tmp/pangu_long/` **存在**，创建于 Oct 13 07:34，当前**完全空目录**（0 个条目）。',
  '- 目标范围 `f00.txt`–`f39.txt`（40 个文件）：**全部不存在**。抽样 `f00/f01/f39` 均为 MISSING，`ls f*.txt` 无任何输出。',
  '---',
  '**PASS — 40/40 全部通过** 事实证据（两次 exec_command 实测）：`ls -1 f*.txt | wc -l` = 40。',
].join('\n');

test('现场答案形态: 账本 40 个文件, 答案说全不存在 → 必须检出', () => {
  const sid = 'contra-1';
  writeFiles(sid, 40, Date.now());
  const c = D._answerContradictsLedger(REAL_ANSWER, sid);
  assert.ok(c, '与账本相反的答案必须被拦下');
  assert.equal(c.written, 40);
});

test('各种"什么都没产出"措辞都要覆盖 (现场全出现过)', () => {
  const sid = 'contra-2';
  writeFiles(sid, 5, Date.now());
  const phrases = ['全部不存在', '均不存在', '无任何输出', '0 个条目', '完全空目录',
    '一个都没写', '没有创建文件', '未写入任何内容', '没有任何产出',
    '0 个文件', '一个都没有写出来', '无任何文件', '没有任何文件被创建',
    '目录为空', '是空目录', '本轮未创建任何文件'];
  for (const p of phrases) {
    const c = D._answerContradictsLedger('核验结论：' + p, sid);
    assert.ok(c, `漏掉了现场措辞「${p}」`);
  }
});

test('本轮账本为空时绝不能报警 (答案说"没创建"是诚实的)', () => {
  const sid = 'contra-empty';
  assert.equal(D._answerContradictsLedger('结论：没有创建任何文件，本轮无产出。', sid), null,
    '没写盘时说没写是实话, 报警就是逼人撒谎');
});

test('长会话防护: 本轮之前写的文件不算本轮产出, 不得误报', () => {
  const sid = 'contra-turn';
  const t0 = Date.now();
  writeFiles(sid, 5, t0);                       // 上一轮写的
  const turnStart = Date.now() + 1000;
  const c = D._answerContradictsLedger('本轮没有创建任何文件', sid, turnStart);
  assert.equal(c, null,
    '账本是全会话累计的, 不按本轮起点过滤就会把上一轮的产出算到本轮头上, 逼答案改口');
});

test('本轮确实写了盘时, sinceTs 过滤后仍要检出', () => {
  const sid = 'contra-turn2';
  writeFiles(sid, 3, Date.now() - 100000);      // 旧的
  writeFiles(sid, 7, Date.now());               // 本轮的
  const c = D._answerContradictsLedger('全部不存在', sid, Date.now() - 5000);
  assert.ok(c && c.written === 7, '本轮写的 7 个要算数: ' + JSON.stringify(c));
});

test('诚实完成的答案不得误报 (别把修诚实修成找茬)', () => {
  const sid = 'contra-ok';
  writeFiles(sid, 40, Date.now());
  const honest = [
    '**核验结论（事实）**',
    '- 已真实写入 40 个文件 f00.txt–f39.txt，逐个 `-s` 非空检查全部通过。',
    '- 大小：f00–f09 = 57B，f10–f39 = 58B，f38 = 61B，与内容量自洽。',
    '- checker 实测 PASS：`ls -1 f*.txt | wc -l` = 40。',
  ].join('\n');
  assert.equal(D._answerContradictsLedger(honest, sid), null, '诚实答案被报警就成了噪声');
});

test('纠正文案必须给出账本真数字与样例路径', () => {
  const sid = 'contra-fix';
  writeFiles(sid, 40, Date.now());
  const c = D._answerContradictsLedger(REAL_ANSWER, sid);
  const fix = D._groundTruthCorrection(c);
  assert.match(fix, /40/, '必须说清账本记了多少: ' + fix);
  assert.match(fix, /f00\.txt/, '要给样例路径: ' + fix);
  assert.match(fix, /以账本为准/, fix);
});

test('纠正文案本身不得含"自认未完成"措辞 (否则反过来触发 partial 守卫)', () => {
  const sid = 'contra-fix2';
  writeFiles(sid, 40, Date.now());
  const c = D._answerContradictsLedger(REAL_ANSWER, sid);
  const fix = D._groundTruthCorrection(c);
  assert.equal(require('../modules/j2_dispatcher')._answerAdmitsIncomplete(fix), false,
    '纠正文案触发自认守卫 → 已完成的任务被误判 partial: ' + fix);
});

test('接线: 出门前必须对账, 且矛盾时不得再走"自认未完成"判定', () => {
  const raw = fs.readFileSync(path.join(__dirname, '../modules/j2_dispatcher.js'), 'utf8');
  const src = raw.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  assert.match(src, /_reconcileWithLedger\(finalText, sessionId, _turnStartTs\)/,
    '送 final 之前必须对账');
  assert.match(src, /_recon\.contradiction \? false : _answerAdmitsIncomplete\(finalText\)/,
    '账本有产出时, 不能再用答案的自认把它判成 partial');
  assert.match(src, /text: _groundTruthCorrection\(c\) \+ /,
    '必须把账本真相当着用户的眼睛摆到前面');
});

// 顺序是这里的要害, 不是排版: 对账必须在**收口剥离之后、chunk 写出之前**。
//   放在收口之前 → 空答复会被回落成子 agent 自述(本 bug 的原材料), 检出不了;
//   放在 chunk 之后 → 主人已经看见假答案了, 纠正只是补一句。
// 另外 synthesis-leak-20261012 有条结构守卫要求收口剥离紧挨 chunk 写出, 所以这段
// 必须收进 _reconcileWithLedger —— 一旦有人把它内联回来, 那条用例会红。
test('接线顺序: 收口剥离 → 对账 → chunk 写出', () => {
  const src = fs.readFileSync(path.join(__dirname, '../modules/j2_dispatcher.js'), 'utf8');
  const lines = src.split('\n');
  const at = re => lines.findIndex(l => re.test(l));
  // 2026-10-23(第 65 批): 收口剥离(`_finalizeAnswerText`)从「各写一遍」收进了
  //   `_synthesizeAndFinalize` 一处, 所以「主路径那次剥离」现在表现为
  //   「主路径那最后一次 `= await _synthesizeAndFinalize(`」——
  //   **顺序的意图一个字没变**: 收口剥离 → 对账 → chunk 写出。
  const finalize = lines.map((l, i) => [l, i])
    .filter(([l]) => l.includes('= await _synthesizeAndFinalize(')).pop();
  assert.ok(finalize, '找不到收口剥离调用');
  // 剥离确实在那一个实现里(不是「有实现就算」)
  assert.ok(/_ft = _finalizeAnswerText\(_ft, _childConclusions\(resultsRef\)\)/.test(src),
    '统一实现里必须有收口剥离 —— 顺序判据说的就是它');
  const recon = at(/_reconcileWithLedger\(finalText, sessionId, _turnStartTs\)/);
  // 必须取**对账之后**的那个 chunk 写出点: 全文件有 4 处同样的写出,
  // findIndex 会命中 1002 行那条直答路径, 顺序断言会被它带偏。
  const chunk = lines.findIndex((l, i) => i > recon &&
    /safeResWrite\(res,\s*'chunk',\s*\{\s*delta:\s*finalText\s*\}\)/.test(l));
  assert.ok(recon > 0 && chunk > 0, '对账调用点与 chunk 写出点都必须存在');
  assert.ok(finalize[1] < recon, `收口剥离(第${finalize[1] + 1}行)必须在对账(第${recon + 1}行)之前`);
  assert.ok(recon < chunk, `对账(第${recon + 1}行)必须在 chunk 写出(第${chunk + 1}行)之前`);
  assert.ok(chunk - finalize[1] <= 6,
    `收口剥离到 chunk 写出被撑到 ${chunk - finalize[1]} 行, 超出 synthesis-leak 守卫的 6 行窗口`);
});

test('_reconcileWithLedger 返回纠正文本与矛盾标记', () => {
  const sid = 'contra-recon';
  writeFiles(sid, 40, Date.now());
  const bad = D._reconcileWithLedger(REAL_ANSWER, sid);
  assert.ok(bad.contradiction, '矛盾时必须带上标记(下游据此不判 partial)');
  assert.match(bad.text, /^⚠️ \*\*对账纠正\*\*/, '纠正必须在最前面: ' + bad.text.slice(0, 40));
  assert.ok(bad.text.includes('完全空目录'), '原答案保留在后面, 不改写模型原话');
  const ok = D._reconcileWithLedger('已写入 40 个文件，全部存在。', sid);
  assert.equal(ok.contradiction, null, '不矛盾时原样返回');
  assert.equal(ok.text, '已写入 40 个文件，全部存在。');
});

// 反向防线: "写了 N 个文件" 恰恰是最常见的**诚实**答案形态。每收紧一次正则, 都在把它往
// "什么都没产出" 的方向推。这组用例是防**过度收紧**的, 别删。
test('诚实答案的常见形态绝不能被当成"什么都没产出" (防过度收紧)', () => {
  const sid = 'contra-nofalse';
  writeFiles(sid, 40, Date.now());
  const honest = [
    '已真实写入 40 个文件，逐个检查全部通过。',      // "40 个" 里的 0 曾被 0\s*个文件 命中
    '40 个文件全部存在，无未通过项。',              // "全部存在" 曾被 不?存在 命中
    '本轮未修改任何内容。',                        // 否定 + 任意填充 曾被 [\s\S]{0,N} 通配命中
    '没有任何遗漏，也没有一个失败。',
    '一个都没落下，全部通过。',                    // "都没" 后跟的是肯定动词
    '已写入 120 个文件，f00-f39 与 f100-f119 均已落盘。',
  ];
  for (const line of honest) {
    assert.equal(D._answerContradictsLedger(line, sid), null,
      '把诚实答案当成"什么都没产出" = 对用户说假话: ' + line);
  }
});

// 这个 bug 是**静默**的: '0\s*个' 写在普通 JS 字符串里会退化成 '0s*个' —— 不报错、不抛异常,
// 只是分支永远不生效。所以除了行为断言, 还要直接断言正则源码本身。
test('正则源码里的转义不许被字符串字面量吞掉 (String.raw 防线)', () => {
  const src = D._NOTHING_PRODUCED_RE.source;
  assert.ok(src.includes(String.raw`0\s*个`),
    '正则源码里必须是 0\\s*个; 被吞成 0s*个 时该分支静默失效: ' + src);
  assert.ok(!src.includes(String.raw`0s*个`), '不能出现退化形态 0s*个: ' + src);
  const file = fs.readFileSync(path.join(__dirname, '../modules/j2_dispatcher.js'), 'utf8');
  assert.match(file, /String\.raw`/, '构造该正则的数组必须用 String.raw');
});
