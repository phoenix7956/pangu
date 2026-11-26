// 2026-10-16 长任务 2190s 正确产出被整轮判死 (现场 lt3)
//
// 实机 (本地 qwen3.8-27b, 5 步任务: 建 5 文件 → 写 u1 三行 → 统计行数到 u2 →
// 复制 u1 到 u3 → 读回验证):
//   2190s = 36.5 分钟, 46+ 次 LLM 调用, 两刀 executor 全对 ——
//   u2.txt = "3"、u1 与 u3 diff 一致、artifacts 都在盘上。
//   最后一层 checker 撞上 read ECONNRESET。
//   老判据 "本层全部死于 额度已耗尽|端点连不上 → 整轮 quota fast-fail" 分不清两种局面:
//     ① 第一层就死 (后面还没花钱, 中止确实省钱)
//     ② 最后一层验收时端点抖了一下 (上游活已落盘, 中止是把产出扔了)
//   盘古按 ① 处理 → 主人收到「本轮未形成与原问题匹配的可核验答案, 请重试。」
//
// 这才是"长任务无法执行"最伤的一种形态: 不是慢到不能忍, 是跑完了还没法信。
// 慢用户会等; 让人去重试一件已经做完的事, 用户不会再用第二次。
//
// 这组测试锁三件事: ① 有产出就不许整轮判死 ② 死掉的验收刀不许被记成 PASS
// ③ 三处判据共用一个定义 (历史上抄多份, 上次只改一处、实机走的是另一处)。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const M = (p) => require(path.join(__dirname, '..', p));
const D = () => M('modules/j2_dispatcher.js');

const dead = (summary, extra) => Object.assign({ agent: 'checker', task: 't', result: { summary } }, extra || {});
const ok = (agent, summary, artifacts) => ({
  agent, task: 't',
  result: Object.assign({ summary, artifacts: artifacts || [] }, {}),
});

// ===== 1. 核心: 已有产出落盘 → 不许整轮 fast-fail =====

test('A1 lt3 现场: 末层 checker 死在 ECONNRESET, 上游已落盘 → 不 fast-fail', () => {
  const { _shouldFastFail } = D();
  const upstream = [ok('executor', '5 步全部执行完毕, diff 一致',
    [{ path: '/tmp/pangu_lt3_test/u1.txt', bytes: 17 }])];
  const layer = [dead('⚠️ 模型 qwen3.8-27b-mlx 端点连不上: read ECONNRESET — 已重试 2 次仍失败。')];
  assert.strictEqual(_shouldFastFail(layer, upstream), false,
    '上游 artifacts 已在盘上, 中止不是省钱是扔产出 —— 2190s 的正确结果不许丢');
});

test('A2 老判据的本意不许丢: 第一层全挂且无任何产出 → 仍 fast-fail (省后续的钱)', () => {
  const { _shouldFastFail } = D();
  const layer = [
    dead('⚠️ 模型 x 额度已耗尽 (HTTP 429)。'),
    dead('⚠️ 模型 x 额度已耗尽 (HTTP 429)。'),
  ];
  assert.strictEqual(_shouldFastFail(layer, []), true,
    '啥都没干成的时候还烧后面的层和综合 LLM, 那才是真浪费钱');
});

test('A3 活干完了、只是交汇报那次调用死了 → 同样不许判死 (它属于已完成)', () => {
  const { _shouldFastFail } = D();
  const layer = [dead('⚠️ 端点连不上: read ECONNRESET',
    { result: { summary: '⚠️ 端点连不上: read ECONNRESET', artifacts: [{ path: '/tmp/a/u3.txt' }] } })];
  assert.strictEqual(_shouldFastFail(layer, layer), false,
    'artifacts 在盘上就说明这刀干完了, 它只是没能把结论说出来');
});

test('A4 有产出但这一层没全挂 → 本来就不该 fast-fail (原行为不变)', () => {
  const { _shouldFastFail } = D();
  const layer = [dead('端点连不上: ECONNRESET'), ok('executor', '写完了 u4')];
  assert.strictEqual(_shouldFastFail(layer, []), false);
});

test('A5 空层不炸', () => {
  const { _shouldFastFail } = D();
  assert.strictEqual(_shouldFastFail([], []), false);
  assert.strictEqual(_shouldFastFail(null, null), false);
});

// ===== 2. 死掉的验收刀不许被记成 PASS =====

test('B1 checker 死在端点报错上 → unknown, 不是 pass', () => {
  const { _verdictOfChecker } = D();
  const s = '⚠️ 模型 qwen3.8-27b-mlx 端点连不上: read ECONNRESET — 已重试 2 次仍失败。请检查网络/DNS。';
  assert.strictEqual(_verdictOfChecker(s), 'unknown',
    '这刀一个字都没验。老码兜底扫不到失败词就 return pass, 于是"没验"被记成"验过了"');
});

test('B2 熔断/超时的死法同样不算 pass', () => {
  const { _verdictOfChecker } = D();
  for (const s of [
    '⚠️ LLM_SOCKET_TIMEOUT_300s 模型无响应',
    '⚠️ STREAM_IDLE_TIMEOUT_90s 流式空闲',
    '⚠️ ETIMEDOUT 连接超时',
  ]) {
    assert.strictEqual(_verdictOfChecker(s), 'unknown', s);
  }
});

test('B3 真 PASS / 真 FAIL 一律不许被这次改动带偏', () => {
  const { _verdictOfChecker } = D();
  assert.strictEqual(_verdictOfChecker('**最终验收结论: PASS** — 5 个文件全部核对一致'), 'pass');
  assert.strictEqual(_verdictOfChecker('**结论: FAIL** — u2.txt 内容是 4 不是 3'), 'fail');
  assert.strictEqual(_verdictOfChecker('3 个文件通过, 2 个未通过'), 'fail');
  assert.strictEqual(_verdictOfChecker('**最终验收结论: FAIL**'), 'fail');
});

test('B4 端点报错里若混着 PASS 字样, 仍按 unknown (死刀的自述不算数)', () => {
  const { _verdictOfChecker } = D();
  assert.strictEqual(
    _verdictOfChecker('验收 PASS ✅ 然后收尾时 ECONNRESET'),
    'unknown',
    '模型在死之前写的 PASS 不是验收结论, 它没机会真的验完');
});

// ===== 2b. PASS 的壳不许被判成 FAIL (白烧 4 次 LLM 调用) =====

test('B5 checker 说 PASS 的两种常见壳不许被判成 FAIL', () => {
  const { _verdictOfChecker } = D();
  // 老码当失败词扫到 → 判 FAIL → 白触发最多 2 轮补救 (executor 重做 + checker 复验),
  // 本地 27B 每次 ~60s, 一次误判就是 4 次白烧的钱和 4 分钟
  for (const s of [
    '无未通过项, 全部一致',
    '没有发现差异',
    '不存在不通过的情况',
    '未发现问题',
    '0 处错误',
  ]) {
    assert.strictEqual(_verdictOfChecker(s), 'pass', s);
  }
});

test('B6 摘掉否定壳不许顺手把真失败也摘掉', () => {
  const { _verdictOfChecker } = D();
  for (const s of [
    '无未通过项, 但步骤 3 未通过',
    '没有发现差异, 复验第 2 轮不通过',
    '验收 FAIL',
    '**最终验收结论: FAIL** — u1 与 u3 不一致',
  ]) {
    assert.strictEqual(_verdictOfChecker(s), 'fail', s);
  }
});

test('B7 多数通过 + 少数未通过 = 没过 (老码按第一个词定夺, 判成 pass)', () => {
  const { _verdictOfChecker } = D();
  for (const s of [
    '3 个文件通过, 2 个未通过',
    '步骤 1/2/3 通过, 步骤 4 不通过',
    '4 项合格, 其中 1 项失败',
  ]) {
    assert.strictEqual(_verdictOfChecker(s), 'fail',
      '少数未通过被多数通过盖住 = 验收白做 = 收口虚报 completed: ' + s);
  }
});

test('B8 明确标签的 PASS 不受 B7 影响 (自洽表述不许被翻)', () => {
  const { _verdictOfChecker } = D();
  for (const s of [
    '**最终验收结论: PASS**',
    '验收结论: PASS (第 2 轮复验, 上一轮未通过)',
  ]) {
    assert.strictEqual(_verdictOfChecker(s), 'pass', s);
  }
});

// ===== 3. 死法识别 =====

test('C1 死法认得全 (配额 / 端点 / 超时三类都算死)', () => {
  const { _sliceIsDead } = D();
  const deadOnes = [
    '⚠️ 模型 x 额度已耗尽 (HTTP 429)。',
    '⚠️ 模型 x 端点连不上: read ECONNRESET',
    '⚠️ 模型 x 端点连不上: connect ECONNREFUSED 127.0.0.1:12345',
    '⚠️ LLM_SOCKET_TIMEOUT_300s',
    '⚠️ STREAM_IDLE_TIMEOUT_90s',
    'socket hang up ETIMEDOUT',
  ];
  for (const s of deadOnes) assert.strictEqual(_sliceIsDead({ result: { summary: s } }), true, s);
  // 正常交汇报不许被误判成死
  for (const s of ['5 步全部执行完毕, diff 一致', '已写入 3 行', '验收 PASS']) {
    assert.strictEqual(_sliceIsDead({ result: { summary: s } }), false, s);
  }
});

// ===== 4. 结构性不变量: 判据只有一处定义, 三处 site 全走它 =====

test('D1 三处 fast-fail site 不许各写各的判据', () => {
  // 2026-10-17: 派发引擎搬进 subagent_runner, 于是三个 site 从"都在 dispatcher"
  // 变成"fixed_flow 一个 + DAG/并行两个在 runner"。**判据仍然只有一处定义**
  // (dispatcher 的 _shouldFastFail), runner 只是回调它 —— 这正是 D1 要守的形状,
  // 所以两个文件都得读, 而且"定义 1 + 三处 site"这个计数一分不减。
  const src = ['j2_dispatcher.js', 'subagent_runner.js']
    .map((f) => require('fs').readFileSync(path.join(__dirname, '..', 'modules', f), 'utf8'))
    .join('\n');
  // 历史上这个判据抄在三处 (fixed_flow / DAG 分层 / 全并行), 只改一处、实机走另一处
  const inline = src.match(/every\(\s*r\s*=>\s*\/额度已耗尽/g) || [];
  assert.strictEqual(inline.length, 0, '还有 site 在内联抄判据: ' + inline.length);
  const sites = src.match(/_shouldFastFail\(/g) || [];
  assert.ok(sites.length >= 4, '定义 1 + 三处 site 调用, 实际 ' + sites.length);
});

test('D2 验收刀没结论时收口必须 partial, 且死因要摆给主人看', () => {
  const src = require('fs').readFileSync(
    path.join(__dirname, '..', 'modules', 'j2_dispatcher.js'), 'utf8');
  // 2026-10-16 (lt-after-221727 一刀一文件改造的连带修正): 中间那个 disjunct 换成了
  // 过验收闸的 _admitsFinal —— 验收刀 PASS 时, 子 agent 按汇报契约诚实写下的
  // 「③ 未做: 未读兄弟的文件」不再有资格把整轮判成 partial。
  // **本测试的原意一字未动**: 验收刀没跑出结论 (_unknownAcceptance) 必须仍然挡在
  // completed 前面, 一个字都不许放宽。所以这里断言三段 disjunct 仍在, 而不是绑死变量名。
  assert.ok(/_notComplete = _acceptanceFailed \|\| _admits\w* \|\| _unknownAcceptance/.test(src),
    '没验成不许收 completed —— _unknownAcceptance 必须仍是三段 disjunct 之一');
  assert.ok(!/_notComplete = _acceptanceFailed \|\| _admits \|\| _unknownAcceptance/.test(src),
    '裸的 _admits 不许直接进收口判定 —— 那样子 agent 的诚实免责条款会一直判死长任务');
  assert.ok(/最后一步的独立复核没跑成/.test(src),
    '死因必须写进答复 —— 主人分不清"活没干成"(该重做) 和 "验收没跑成"(该修端点), 弄反就白等 36 分钟');
});
