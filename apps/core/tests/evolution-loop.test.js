'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function withL3State(state, fn) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-l3-')), 'l3.json');
  const previous = process.env.PANGU_L3_STATE_PATH;
  fs.writeFileSync(file, JSON.stringify(state));
  process.env.PANGU_L3_STATE_PATH = file;
  try { return fn(); }
  finally {
    if (previous === undefined) delete process.env.PANGU_L3_STATE_PATH;
    else process.env.PANGU_L3_STATE_PATH = previous;
  }
}

test('L3 learned weights and stable task mappings affect dispatcher routing', () => {
  withL3State({
    weights: { dui: 0.875 },
    taskToAgents: {
      // 2026-10-18: 磁盘上的 l3_state.json 已经迁成拼音 (实测键全是拼音), 写侧
      // 也只写拼音, 所以这里直接用拼音。原来的英文写法 + "运行时负责归一"
      // 整套删掉了 —— 那正是「还留着干嘛」指的那张表。
      code_review: { agents: ['dui', 'xun', 'kan'], stats: { count: 3 } },
    },
  }, () => {
    delete require.cache[require.resolve('../agents/qian')];
    const { AgentDispatcher } = require('../agents/qian');
    const dispatcher = new AgentDispatcher();
    const rolePrompt = dispatcher._buildRolePrompt('dui', { __classification: { complexity: 'standard' } });
    assert.match(rolePrompt, /L3 学习权重】dui=0\.875/,
      'L3 权重查不到 → 权重块整块消失, 学习闭环静默失效, 而 prompt 照样发得出去');
    assert.match(dispatcher._buildClassifyPrompt('检查 router bug'), /code_review/);

    const routed = dispatcher._applyL3Routing({
      taskType: 'review a pull request',
      subtasks: [
        { role: 'kan', goal: 'plan' },
        { role: 'dui', goal: 'check' },
        { role: 'kun', goal: 'execute' },
      ],
    });
    assert.equal(routed.l3Applied, true);
    assert.deepEqual(routed.subtasks.map(item => item.role), ['dui', 'xun', 'kan', 'kun']);
  });
});

test('L3 建议的 agent 组合必须全是真将灵 —— 认不出的名字不许漏过去', () => {
  // 这条盯的是 l3_dispatcher.suggestAgentsForTask 的过滤。
  //
  // 原来的过滤写成 `agents.map(a => resolveRole(a) || a).filter(...)`:
  // 认不出名字时**原样漏过去**, 只靠"不在可用名单里"才被顺手滤掉。
  // 只要调用方把同一个坏名字也放进 availableAgents, 它就会两边都通过 ——
  // 然后 _routeWithL3 拿它当 role 发出去, 下游 ROLES[role] 查不到,
  // 落到一个没有 system prompt 的空角色。症状是"派出去了但像没派"。
  //
  // 现在过滤只认拼音, 认不出就是丢掉 —— 不管调用方的名单里有没有它。
  // 断言写成"返回值恒为 GUA_CODES 的子集", 而不是逐个 case 比对:
  // 这样任何"把认不出的名字放行"的实现都会红, 不依赖具体措辞。
  const { suggestAgentsForTask } = require('../modules/l3_dispatcher');
  const { GUA_CODES } = require('../agents/gua-identity');
  withL3State({
    weights: {},
    taskToAgents: {
      // 坏名字既在 state 里, 又被调用方声明成"可用" —— 最容易漏的那种情况
      bogus_pattern: { agents: ['analyzer', 'kun'], stats: { count: 9, pass_rate: '1.0' } },
    },
  }, () => {
    const out = suggestAgentsForTask('bogus_pattern', ['analyzer', 'kun']);
    for (const a of (out || [])) {
      assert.ok(GUA_CODES.includes(a),
        'L3 建议里漏出了不存在的将灵 "' + a + '" —— 认不出的名字必须丢掉, '
        + '不能靠"调用方名单里恰好没有它"才被滤掉');
    }
    assert.ok(!out || !out.includes('analyzer'),
      '英文名 analyzer 被原样放行了 —— `|| a` 那种兜底又回来了');
  });
});

test('proposal patch validation rejects path traversal and missing source text', async () => {
  const evolution = require('../agents/self-evolution');
  const proposalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-proposal-'));
  const writeProposal = patch => {
    const file = path.join(proposalDir, `${Date.now()}-${Math.random()}.json`);
    fs.writeFileSync(file, JSON.stringify({ status: 'pending_review', patch }));
    return file;
  };

  await assert.rejects(
    evolution.approveAndApply(writeProposal({ file: '../outside.js', oldText: 'x', newText: 'y' })),
    /outside repo/,
  );

  // ⚠ 2026-10-26 第 107 批: 这一条原来直接打**真实仓库的 package.json**,
  //   于是它能不能走到「oldText 找不到」这一步, 取决于**当时工作区干不干净** ——
  //   approveAndApply 在 oldText 检查**之前**还有一道「patch target has uncommitted
  //   changes」(self-evolution.js:270), 工作区一脏就先撞那道门。
  //   本批改了根 package.json, 这条当场变红 —— 红了才知道它是**脆**的:
  //   它测的是「守卫顺序」, 却依赖「仓库状态」。
  //
  //   修法: 给它一个**自己的临时 git 仓库**当 repoRoot ——
  //   目标文件已提交 ⇒ porcelain 干净 ⇒ 一定走到 oldText 检查。
  //   这样这条断言的是**被测行为**（路径穿越 / 旧文本缺失要被拒）,
  //   不再断言「此刻工作区恰好是干净的」。
  const { execFileSync } = require('node:child_process');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-patch-repo-'));
  const git = (...args) => execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      GIT_AUTHOR_NAME: 'pangu-test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'pangu-test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    }),
  });
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'target.txt'), 'hello\n');
  git('add', 'target.txt');
  git('-c', 'user.name=pangu-test', '-c', 'user.email=test@example.invalid',
    'commit', '-q', '-m', 'init');

  const prevRepoRoot = evolution.repoRoot;
  evolution.repoRoot = repo;
  try {
    await assert.rejects(
      evolution.approveAndApply(writeProposal({ file: 'target.txt', oldText: '__missing__', newText: 'y' })),
      /oldText not found/,
      '目标文件已提交且工作区干净时, 必须走到 oldText 检查并报「找不到」',
    );
    // 回归: 目标文件**有未提交改动**时, 必须先被「工作区脏」那道门拦下 ——
    //   这道门是 2026-10-25 加的, 原测试根本没覆盖到它。
    fs.writeFileSync(path.join(repo, 'target.txt'), 'hello\ndirty\n');
    await assert.rejects(
      evolution.approveAndApply(writeProposal({ file: 'target.txt', oldText: 'hello', newText: 'y' })),
      /uncommitted changes/,
      '目标文件有未提交改动时, 必须拒绝改写 —— 不许在半途状态上打补丁',
    );
  } finally {
    evolution.repoRoot = prevRepoRoot;
  }
});

test('effect gate waits for post-change outcome sample', async () => {
  const evolution = require('../agents/self-evolution');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-effect-')), 'proposal.json');
  fs.writeFileSync(file, JSON.stringify({
    effect_baseline: { tasks_total: 100, completed_rate: 0.9, failed: 10 },
    effect_window_started_at: Date.now(),
    iteration: { result: { committed: 'not-used', rollback_target: 'not-used' } },
  }));
  const result = await evolution.evaluateAppliedProposal(file, { minTasks: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.pending, true);
});
