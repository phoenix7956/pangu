'use strict';
/**
 * 第 93 批 —— 「排除自己」从来就没生效过 (拿原始 sid 比清洗过的文件名)
 *
 * ## 现场 (2026-10-25, 读码 + 实跑取证)
 *
 * `modules/prior_session.js` 挑「最近 N 个别的会话」往提示词里灌。
 * 它排除自己的那行是:
 *
 *     if (excludeSessionId && f.startsWith(excludeSessionId + '_r')) continue;
 *
 * `excludeSessionId` 传的是**原始 sid**, 而 checkpoint 落盘的文件名是**清洗过的**:
 *
 *     sid 'parent#sub-0-li'  →  落盘名 'parent_sub-0-li_r3.json'   ('#' → '_')
 *
 * ⇒ `startsWith('parent#sub-0-li_r')` 对 'parent_sub-0-li_r3.json' **永远不成立**
 * ⇒ **排除自己从来没生效过** ⇒ 子 agent 会把**自己上一手的 checkpoint**
 *   当成「跨会话上下文」整份灌进自己的提示词
 *   (既白烧 token, 又把「上一手」错标成「别的手」; 兄弟排除靠的是
 *    excludeSessionPrefix 取父会话 id, 那条是好的 —— 所以现场没暴露出来)。
 *
 * ## 修法
 *
 * 用 `modules/session_key.js` 唯一真源算出**这个 sid 真正的落盘前缀**
 * (`resolveSessionKeyPrefix(dir, sid, {sep:'_r'})`),
 * 而不是自己拿原始 sid 去猜文件名。
 *
 * ## 判据
 *
 * A. **前提确认**: 同一份 fixture 上, 老算法 (原始 sid) **排除不掉自己**
 *    —— 证明这份 fixture 复现了真实现场形状, 不是造出来的假形状。
 * B. 修好后: 排除自己 ⇒ **自己不在**结果里; 兄弟在; 别的会话在。
 * C. 按父会话前缀排除 ⇒ 自己跟兄弟都没了, 别的会话还在 (跨会话连续性不许被削)。
 * D. 干净 sid 的排除**不许被搞坏** (这是这个模块存在的理由: 新会话要接得上上文)。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CORE = path.join(__dirname, '..');
const PRIOR = path.join(CORE, 'modules', 'prior_session.js');
const SK = path.join(CORE, 'modules', 'session_key.js');
const sk = require(SK);

const PARENT = 'parent-e2e-20261025';
const SELF = `${PARENT}#sub-0-li`;          // 自己 (子 agent)
const SIBLING = `${PARENT}#sub-0-checker`;  // 兄弟 (子 agent)
const OTHER = 'other-session-20261025';     // 无关的另一个会话

// 落盘名 = 清洗后的 (真实现场形状): '#' → '_'。
// 2026-10-16 那个既有测试用的 fixture 是**原始 sid 直接当文件名**
// (e2e-scope-20261016#sub-0-analyzer_r0.json) —— 那不是生产上会出现的形状,
// 所以它测不出这个 bug。本批的 fixture 用**真形状**。
const FILE_SELF = `${sk.sessionKey(SELF)}_r3.json`;
const FILE_SIBLING = `${sk.sessionKey(SIBLING)}_r3.json`;
const FILE_OTHER = `${sk.sessionKey(OTHER)}_r0.json`;

// 在**子进程**里加载模块 —— CHECKPOINT_DIR 在 require 时就从环境变量读死了。
function loadInChild(opts, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-prior-'));
  const now = Date.now();
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(Object.assign({ ts: now }, body)));
  }
  const script = `
    const ps = require(${JSON.stringify(PRIOR)});
    const out = ps.loadRecentSessionContext(${JSON.stringify(opts)});
    process.stdout.write(JSON.stringify(out.map(x => x.session_id)));
  `;
  const res = spawnSync(process.execPath, ['-e', script], {
    env: Object.assign({}, process.env, { PANGU_CHECKPOINT_DIR: dir }),
    encoding: 'utf8',
  });
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  assert.strictEqual(res.status, 0, '子进程加载失败: ' + (res.stderr || '').slice(0, 300));
  return JSON.parse(res.stdout || '[]');
}

const FIXTURES = {
  [FILE_SELF]: { session_id: SELF, task_input: '自己的活', messages: [] },
  [FILE_SIBLING]: { session_id: SIBLING, task_input: '兄弟的活', messages: [] },
  [FILE_OTHER]: { session_id: OTHER, task_input: '别的会话的活', messages: [] },
};

test('第93批 A: 前提确认 —— 老算法 (原始 sid) 在真形状 fixture 上排除不掉自己', () => {
  // 老算法: f.startsWith(excludeSessionId + '_r')
  const oldAlgorithmExcludesSelf = Object.keys(FIXTURES)
    .some(f => f.startsWith(SELF + '_r'));
  assert.strictEqual(
    oldAlgorithmExcludesSelf,
    false,
    '前提不成立: 这份 fixture 上老算法**居然**能排除自己 ⇒ fixture 不是真实现场形状, '
    + '后面的判据就证明不了任何东西',
  );
  // 而清洗后的名字才是真实现场落盘名。
  assert.ok(
    Object.keys(FIXTURES).some(f => f.startsWith(sk.sessionKey(SELF) + '_r')),
    '前提不成立: 清洗后的文件名不在 fixture 里',
  );
});

test('第93批 B: 排除自己 ⇒ 自己不在结果里, 兄弟跟别的会话还在', () => {
  const got = loadInChild({ excludeSessionId: SELF, limit: 5 }, FIXTURES);
  assert.ok(!got.includes(SELF), `★ 自己还在结果里: ${JSON.stringify(got)} —— 「排除自己」没生效`);
  assert.ok(got.includes(SIBLING), `兄弟被误伤了: ${JSON.stringify(got)}`);
  assert.ok(got.includes(OTHER), `别的会话被误伤了: ${JSON.stringify(got)}`);
});

test('第93批 C: 按父会话前缀排除 ⇒ 自己跟兄弟都没了, 别的会话还在', () => {
  const got = loadInChild(
    { excludeSessionId: SELF, excludeSessionPrefix: PARENT, limit: 5 },
    FIXTURES,
  );
  assert.ok(!got.includes(SELF), `自己还在: ${JSON.stringify(got)}`);
  assert.ok(!got.includes(SIBLING), `兄弟还在: ${JSON.stringify(got)}`);
  assert.ok(got.includes(OTHER), `别的会话被误伤 (跨会话连续性被削了): ${JSON.stringify(got)}`);
});

test('第93批 D: 干净 sid 的排除不许被搞坏', () => {
  // 这是这个模块存在的理由: 新会话要接得上上一手。
  const got = loadInChild({ excludeSessionId: OTHER, limit: 5 }, FIXTURES);
  assert.ok(!got.includes(OTHER), `干净 sid 排除失效: ${JSON.stringify(got)}`);
  assert.ok(got.includes(SELF), `干净 sid 排除把别的会话也误伤了: ${JSON.stringify(got)}`);
  assert.ok(got.includes(SIBLING), `干净 sid 排除把别的会话也误伤了: ${JSON.stringify(got)}`);
});
