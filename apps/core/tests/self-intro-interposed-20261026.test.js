'use strict';

// 2026-10-26 (第 104 批): 「用一句话说明你现在能做什么」被判跑题 —— 主人看到拒答
//
// ─────────────────────────────────────────────────────────────────────────
// 现场 (2026-10-26 实跑, 生产服务 :18901, 非测试环境):
//
//   curl -X POST :18901/api/chat -d '{"messages":[{"role":"user",
//         "content":"用一句话说明你现在能做什么。"}]}'
//   → {"ok":true,"choices":[{"message":{"role":"assistant","content":
//      "本轮未形成与原问题匹配的可核验答案，请重试。"}}]}
//
// 而**本地模型答得完全正确** (直打 LM Studio :1234 核对原文):
//   「我可以帮你解答问题、整理信息、分析思路、写作创作, 并处理许多日常和学习工作中的任务。」
//
// ⇒ 拦的是**正确答案**, 不是跑题。主人问盘古「你能做什么」, 盘古答「我不会」。
//
// ─────────────────────────────────────────────────────────────────────────
// 真因: 两层, 缺一不可 (这正是它长期没被发现的原因 —— 单看哪层都「有道理」)
//
//   ① **问题侧**: SELF_INTRO_ASK 正则要求「你」**紧跟**能力动词
//      `你(?:能|会|可以)(?:做什么|干什么|干些什么)`
//      ⇒ 「你**现在**能做什么」(「现在」夹在中间) / 「你**到底**能做什么」
//        / 「你**其实**会干什么」 全部漏掉。
//      漏掉 ⇒ 走不进 isSelfIntroAsk 分流 ⇒ 掉进**词法对齐门**。
//
//   ② **答案侧**: isSelfIntroAnswer 只认「盘古/易经/agent」这类**实体名**,
//      或「我就是/我是/我叫」这种**自我介绍句**。
//      而中文里答「你能做什么」最自然的答法是**第一人称讲能力**
//      (「我可以帮你解答问题…」) —— 既没出现「盘古」, 也不是「我是…」⇒ 判 false。
//
//   两层**各自都判 false**, 而 isAligned 里 `isSelfIntroAsk` 是**短路返回**
//   (`if (isSelfIntroAsk(question)) return isSelfIntroAnswer(answer);`)
//   ⇒ 问题侧一漏, 答案侧根本没有机会被正确评价。
//
// ─────────────────────────────────────────────────────────────────────────
// 修法: 两层各修一处, 但**只放宽这一个搭配**, 不泛化:
//   ① SELF_INTRO_ASK: 「你」与能力动词之间允许插入语气/时间副词 + 可选情态动词
//      + 可选「帮我」; 但能力动词后**必须紧跟**「做什么/干什么」这类疑问词组
//      ⇒ 「你能帮我**分析磁盘空间**吗」(任务请求) 仍然不匹配。
//   ② isSelfIntroAnswer: 接受「第一人称 + 能力/职责动词」作为「在讲自己」
//      (我(能|会|可以|负责|擅长|主要)…)。
//      仍然拦得住: 天气闲聊 / 超短回答 / 复述问题词 —— 它们没有第一人称能力陈述。
//
// ⚠ 这道守卫的**原始目的**不能被破坏: 拦「主人问 A, 盘古答一整篇自我介绍」的灌水
//   (老板 2026-10-18 原话)。所以本文件同时钉住**反面**用例:
//   放水了就必须红。

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const aa = require(path.join(ROOT, 'modules', 'answer_alignment.js'));

// 现场原话 (本地 qwen3.8-27b 的真实回答, 直打 :1234 核对过)
const REAL_ANSWER = '我可以帮你解答问题、整理信息、分析思路、写作创作，'
  + '并处理许多日常和学习工作中的任务。';

test('104-1: 「用一句话说明你现在能做什么」⇒ 正确的第一人称回答必须放行', () => {
  assert.equal(aa.isSelfIntroAsk('用一句话说明你现在能做什么。'), true,
    '「你」和「能」中间插了「现在」就漏 ⇒ 掉进词法对齐门 ⇒ 正确答案被判跑题');
  assert.equal(aa.isAligned('用一句话说明你现在能做什么。', REAL_ANSWER), true,
    '本地模型答得完全对题, 却被判跑题 —— 主人看到的是「本轮未形成与原问题匹配的可核验答案」');
  const g = aa.guardAnswer('用一句话说明你现在能做什么。', REAL_ANSWER, '');
  assert.ok(!g.blocked, '守卫不许拦这条正确回答');
  assert.equal(g.text, REAL_ANSWER, '放行时必须把原答案原样交出去');
});

test('104-2: 同一意思的各种说法都要认出来 (插字就漏 = 同一个病)', () => {
  const should = [
    '你能做什么？',
    '用一句话说明你现在能做什么。',
    '现在你能做什么',
    '你到底能做什么',
    '你究竟会做什么',
    '你其实能干什么',
    '你通常能做什么',
    '你能帮我干什么',
    '你负责什么',
    '介绍一下你自己',
    '说说你是谁',
    '你有什么能力',
    '你有哪些功能',
    '你的职责是什么',
  ];
  for (const q of should) {
    assert.equal(aa.isSelfIntroAsk(q), true, '这问法漏了: ' + q);
  }
});

test('104-3: 任务请求 / 事实问句不许被当成自我介绍 (判据不许开太大)', () => {
  const shouldNot = [
    '你能帮我分析磁盘空间吗',        // 任务请求, 不是问「你能做什么」
    '帮我看看磁盘空间够不够',
    '哪些工具调用失败了',
    '什么是易经纳甲',
    '你说的那些工具是干什么的',      // 「干什么」在句尾, 主语不是「你」
    '今天天气怎么样',
    '请帮我读一下 /tmp/x.txt',
    '你什么时候有空',
    '磁盘还剩多少',
    '全面分析下你自己',              // 走源码取证那条路, 不是自我介绍
  ];
  for (const q of shouldNot) {
    assert.equal(aa.isSelfIntroAsk(q), false, '不该当成自我介绍问: ' + q);
  }
});

test('104-4: 灌水守卫不许被放水 (主人没问, 却答一整篇自我介绍 ⇒ 照拦)', () => {
  // 这道守卫的**原始目的** (老板 2026-10-18): 问 A 答一整篇自我介绍 ⇒ 拦。
  // 修了 104-1 之后, 这里最容易顺手一起放掉 —— 必须钉死。
  assert.equal(
    aa.isAligned('排盘页面为什么没有详情',
      '排盘页面没有详情，是因为工具矩阵里缺了四柱渲染这一环，架构 3 层设计和三层记忆链路都要过一遍。'),
    false,
    '没问却灌水自我介绍 ⇒ 必须照拦 (词法门 + 灌水守卫都在)');
  assert.equal(
    aa.isAligned('router 为什么会问非所问',
      'router 问非所答的根因在答案对齐层: 守卫只有一道，工具矩阵和三层记忆都可能漏。'),
    false, '同上');
  // 问了但答非所问 ⇒ 仍然拦
  for (const bad of ['今天北京天气晴，适合出门', '好的', '2']) {
    assert.equal(aa.isAligned('用两句话说明你是什么', bad), false,
      '问的是自我介绍, 答的却不是 ⇒ 必须拦: ' + bad);
  }
});

test('104-5: 变异体检 —— 把两处放宽改回旧行为 ⇒ 守卫必须真报红', () => {
  // 没验证过的守卫只是「看起来像守卫」。两条修法各改回一次, 必须都咬住。
  const _MUT_SUFFIX = '.pangu-mut-backup-104';
  const _mutationGuard = require(path.join(__dirname, 'helpers', 'mutation_guard'));

  function _runGuardExpectingRed() {
    const childEnv = Object.assign({}, process.env, { PANGU_SELFINTRO_104_MUTATION_CHILD: '1' });
    delete childEnv.NODE_TEST_CONTEXT;
    childEnv.PANGU_REGISTRY_PATH = path.join(require('node:os').tmpdir(),
      'pangu-registry-mut104-' + process.pid + '.json');
    try {
      execFileSync(process.execPath, ['--test', __filename], {
        cwd: ROOT, stdio: 'pipe', timeout: 120000, env: childEnv,
      });
      return null;   // 全绿 = 守卫没咬 = 失败
    } catch (e) {
      return String(e.stdout || '') + String(e.stderr || '');
    }
  }

  const isChild = !!process.env.PANGU_SELFINTRO_104_MUTATION_CHILD;
  if (isChild) return;

  // 变异 1: 问题侧改回「你必须紧跟能力动词」
  _mutationGuard.mutateAndExpectRed({
    root: ROOT,
    file: 'modules/answer_alignment.js',
    from: "  + '|你' + _SELF_INTRO_ADV + _SELF_INTRO_MODAL + _SELF_INTRO_POLITE + '(?:做|干)(?:什么|啥|些什么)'",
    to: "  + '|你(?:能|会|可以)(?:做|干)(?:什么|啥|些什么)'",
    suffix: _MUT_SUFFIX,
    runGuard: _runGuardExpectingRed,
  });

  // 变异 2: 答案侧改回「只认实体名」
  _mutationGuard.mutateAndExpectRed({
    root: ROOT,
    file: 'modules/answer_alignment.js',
    from: "    || /我(?:能|会|可以|能够|擅长|主要|负责)(?:帮|为|做|回答|解答|处理|提供|协助|搞定|处理这些|做这些|做的事|负责)/i.test(text)\n    || /我(?:能|会|可以|能够|擅长|主要|负责)[^。！？\\n]{0,40}(?:工作|任务|事情|问题|活儿|事儿|需求)/i.test(text);",
    to: "    ;",
    suffix: _MUT_SUFFIX,
    runGuard: _runGuardExpectingRed,
  });
});
