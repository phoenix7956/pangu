'use strict';

// 2026-10-26 (第 105 批): 纯闲聊白起一卦 —— 主人问「你到底是谁」, 盘古给他算了一卦
//
// ─────────────────────────────────────────────────────────────────────────
// 现场 (2026-10-26 生产 :18901 实测, 不是推测):
//
//   主人问「你到底是谁」→ 响应里带 `event: gua`, 真起了「否」卦 (动爻九四),
//   最终答复尾巴上还挂着「卦照否之观, 九四有命无咎」。
//   **主人问「你是谁」, 盘古给他算了一卦。**
//   对照组「你是谁」→ 不起卦, 正常直答。
//
//   32 句纯闲聊里 **22 句**会白起一卦。
//
// ─────────────────────────────────────────────────────────────────────────
// 真因: 白名单是**字面词表**, 判定是 `text.includes(k)`
//
//   PURE_CHAT_KWS = ['你好','在吗','你是谁','你叫什么','介绍一下自己', …]
//   ⇒ 「你到底是谁」不包含 '你是谁' ⇒ 掉出白名单
//   ⇒ 兜底规则 (「都不像 → 起卦」, 守 2026-08-02「卦先于人」原意) 把它吃掉
//   ⇒ **纯闲聊白起一卦**。
//
//   病根是**判据不是概念**: 白名单列的是「主人**恰好会说的那一句**」,
//   插一个字就掉出去。这跟第 104 批治的「自我介绍识别插字就漏」是**同一个病**。
//
// ─────────────────────────────────────────────────────────────────────────
// 修法 (换判据, 不是往词表里加字 —— 加不完):
//   ① 「你 + 身份/能力动词」那一族 → 复用 answer_alignment.isSelfIntroAsk (单一真源)
//   ② 招呼/在线/模型/时间/收尾 → 整句锚定的概念正则
//   ③ 主人明说要卦 ⇒ 不是纯闲聊 (规则 19(a)) —— 顺带修掉「你好, 算一卦」被 '你好' 压掉
//
// ⚠ 概念层是**整句锚定**的 ⇒ 「你好, 帮我查一下成交量」这种真活匹配不上
//   ⇒ 落回取数/执行档 ⇒ 仍然不起卦 ✓ (本文件 105-3 钉住)
// ⚠ 字面白名单的 includes 口径**逐位保留** —— 它同时压着「介绍一下这个项目」这类真活,
//   改成整句反而会把它们推进兜底起卦 (本文件 105-2 钉住)

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const { shouldCastGua, shouldUseDispatcher } = require('./helpers/gua_gate_load.js');
const GATE = require(path.join(ROOT, 'modules', 'gua_gate_kws.js'));

/**
 * 纯闲聊语料 (第 105 批现场 + 审计 agent 实测)。
 * 这些句子**全都不该起卦**, 也**全都不该进 dispatcher 编排**。
 */
const CHAT_UTTERANCES = [
  '你是谁', '你到底是谁', '你究竟是谁', '你本质上是什么',
  '在不在', '在么', '说说你自己', '你是什么', '你叫什么',
  '你能做什么', '你现在能做什么', '你都能做什么', '你有什么能力',
  '你有哪些功能', '你负责什么', '盘古是谁',
  '你好', '您好', '嗨', 'hi', 'hello', '早上好',
  '你是什么模型', '版本是多少', '现在几点了', '今天几号',
  '介绍一下自己', '自我介绍',
  '改天', '回头再说', '下次吧', '先这样',
];

test('105-1: 纯闲聊不许起卦 (现场: 「你到底是谁」白起了一卦「否」)', () => {
  const cast = shouldCastGua();
  const dispatch = shouldUseDispatcher();
  for (const s of CHAT_UTTERANCES) {
    assert.equal(cast(s), false, `纯闲聊却起了卦: 「${s}」`);
    assert.equal(dispatch(s), false, `纯闲聊却进了 dispatcher 编排: 「${s}」`);
  }
});

test('105-2: 意图不许变 —— 谋断/占问/取数/执行/兜底 逐位保持', () => {
  const cast = shouldCastGua();
  const CASES = [
    // 谋断 → 起卦 (老板 2026-08-02「卦先于人」的核心场景, 不得被削掉)
    ['这个项目该不该继续做', true],
    ['帮我分析下风险', true],
    ['该怎么做这个决策', true],
    ['这条路值不值得走', true],
    ['建议保留还是砍掉', true],
    ['这个项目该不该继续做，做的话帮我写成方案', true],
    // 明说要卦 → 起卦 (规则 19(a))
    ['算一卦', true],
    ['起个卦看看', true],
    ['给我算一卦', true],
    // 取数 / 执行 → 不起卦 (2026-10-09 老板定的方向, 不得回归)
    ['帮我查一下成交量', false],
    ['看看桌面有哪些文件', false],
    ['写一份周报', false],
    ['运行一下这个脚本', false],
    // 兜底 → 仍起卦 (白名单永远漏词, 漏了要往「起卦」那边倒)
    ['随便聊聊', true],
    ['随便说点什么', true],
    // 空输入
    ['', false],
  ];
  for (const [input, expect] of CASES) {
    assert.equal(cast(input), expect, `起卦判定变了: 「${input}」期望 ${expect}`);
  }
});

test('105-3: 概念层不许把真活判成闲聊 (判据不许开太大)', () => {
  // ① 真活不许被**概念层**误判成闲聊 (概念层是这一批新加的, 最容易开太大)
  for (const s of [
    '现在几点开始开会',        // 时间 + 真活
    '你能帮我分析磁盘空间吗',  // 能力 + 任务
    '帮我写一份周报',
    '帮我查一下成交量',
    '这个项目该不该继续做',    // 谋断
    '你好，能帮我起一卦看看吗', // 招呼 + 明说要卦
  ]) {
    assert.equal(GATE.isPureChat(s), false, `真活被当成纯闲聊了: 「${s}」`);
  }
  // ② 这些整句仍然必须**不起卦** (取数/执行类; 2026-10-09 老板定的方向)
  const cast = shouldCastGua();
  for (const s of [
    '帮我查一下成交量',
    '写一份周报',
    '运行一下这个脚本',
    '介绍一下这个项目',        // 旧白名单含 '介绍一下' ⇒ 不起卦 (includes 口径保留)
    '你好，帮我查一下成交量',  // 招呼 + 真活 ⇒ 仍然不起卦
  ]) {
    assert.equal(cast(s), false, `真活却起了卦: 「${s}」`);
  }
});

test('105-4: 主人明说要卦必调 (规则 19(a)) —— 招呼不许压掉它', () => {
  const cast = shouldCastGua();
  for (const s of ['你好，算一卦', '你好，能帮我起一卦看看吗', '在吗，给我算一卦']) {
    assert.equal(cast(s), true, `明说要卦却没起卦: 「${s}」`);
  }
});

test('105-5: 单一真源 —— 两门共用同一个判据函数, 且不许有第二份副本', () => {
  const single = fs.readFileSync(path.join(ROOT, 'pangu-single.js'), 'utf8');
  // ① 两门都调模块真源的 _isPureChat
  const castBody = single.slice(
    single.indexOf('function _shouldCastGua'),
    single.indexOf('function _shouldUseDispatcher'));
  const dispBody = single.slice(single.indexOf('function _shouldUseDispatcher'));
  assert.match(castBody, /_isPureChat\(/, '起卦门没走 _isPureChat');
  assert.match(dispBody, /_isPureChat\(/, 'dispatcher 门没走 _isPureChat');
  assert.match(single, /isPureChat: _isPureChat/, '_isPureChat 不是从唯一真源接回来的');
  // ② pangu-single.js 里不许再有本地副本的闲聊判定
  assert.doesNotMatch(castBody, /_PURE_CHAT_KWS\.some\(/,
    '起卦门又用回字面 includes 白名单了');
  assert.doesNotMatch(dispBody, /PURE_CHAT\.some\(/,
    'dispatcher 门又用回字面 includes 白名单了');
  // ③ 「身份/能力询问」的真源在 answer_alignment, gua_gate_kws 里**不许另抄一份**
  const gateSrc = fs.readFileSync(path.join(ROOT, 'modules', 'gua_gate_kws.js'), 'utf8');
  assert.match(gateSrc, /isSelfIntroAsk/, 'gua_gate_kws 没有复用 answer_alignment 的真源');
  assert.match(gateSrc, /require\('\.\/answer_alignment'\)/,
    'gua_gate_kws 没有从 answer_alignment 取 isSelfIntroAsk');
  // ④ 两门对同一句话的闲聊判断必须逐位一致
  const cast = shouldCastGua();
  const dispatch = shouldUseDispatcher();
  for (const s of CHAT_UTTERANCES) {
    assert.equal(cast(s), dispatch(s),
      `两门对「${s}」的判断不一致 —— 同一个判据函数不该出现这种偏差`);
  }
});

test('105-6: 变异体检 —— 把三处修法各改回旧行为 ⇒ 守卫必须真报红', () => {
  // 没验证过的守卫只是「看起来像守卫」。三条修法各改回一次, 必须都咬住。
  const _MUT_SUFFIX = '.pangu-mut-backup-105';
  const _mutationGuard = require(path.join(__dirname, 'helpers', 'mutation_guard'));

  function _runGuardExpectingRed() {
    const childEnv = Object.assign({}, process.env, { PANGU_PURECHAT_105_MUTATION_CHILD: '1' });
    delete childEnv.NODE_TEST_CONTEXT;
    childEnv.PANGU_REGISTRY_PATH = path.join(require('node:os').tmpdir(),
      'pangu-registry-mut105-' + process.pid + '.json');
    try {
      execFileSync(process.execPath, ['--test', __filename], {
        cwd: ROOT, stdio: 'pipe', timeout: 120000, env: childEnv,
      });
      return null;   // 全绿 = 守卫没咬 = 失败
    } catch (e) {
      return String(e.stdout || '') + String(e.stderr || '');
    }
  }

  const isChild = !!process.env.PANGU_PURECHAT_105_MUTATION_CHILD;
  if (isChild) return;

  // 变异 1: 概念层整层拿掉 (退回「只认字面白名单」)
  _mutationGuard.mutateAndExpectRed({
    root: ROOT,
    file: 'modules/gua_gate_kws.js',
    from: '  return PURE_CHAT_CONCEPT_RES.some((re) => re.test(t));',
    to: '  return false;',
    suffix: _MUT_SUFFIX,
    runGuard: _runGuardExpectingRed,
  });

  // 变异 2: 不复用 answer_alignment 的真源 (身份询问这一族漏掉)
  _mutationGuard.mutateAndExpectRed({
    root: ROOT,
    file: 'modules/gua_gate_kws.js',
    from: '  if (isSelfIntroAsk(t)) return true;',
    to: '  // 变异: 不复用真源',
    suffix: _MUT_SUFFIX,
    runGuard: _runGuardExpectingRed,
  });

  // 变异 3: 明说要卦不再压过闲聊白名单 (「你好, 算一卦」被 '你好' 吃掉)
  _mutationGuard.mutateAndExpectRed({
    root: ROOT,
    file: 'modules/gua_gate_kws.js',
    from: '  if (isGuaCastRequest(t)) return false;',
    to: '  // 变异: 明说要卦不再优先',
    suffix: _MUT_SUFFIX,
    runGuard: _runGuardExpectingRed,
  });
});

