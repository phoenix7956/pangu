'use strict';
// 启动完整性守卫 (2026-10-23)
//
// 实测踩到的坑 (不是这批引入的, 是老 bug, 10-22 就在日志里):
//   server.listen(...) 的回调是 async 且没有总闸。回调里读 `_config.llm`
//   一抛, 整个回调中断 => 后面 inlineRouter / httpServer / j2AgentLoop /
//   j2Dispatcher / initAgentStream 全部静默跳过。
//   而进程已经 listen 了, /health 照回 200 => 从外面看「服务正常」。
//   真正的后果: init 没跑 => pangu_agent_stream._deps === null =>
//   每个带 body 的 POST 都在 body guard 里 TypeError, 请求永不结束
//   (实测 HTTP=000, 挂死 60s 超时)。
//
// 病根是三层的, 缺一层就复发:
//   (1) 顶头那个 catch 静默 —— 抛了不吭声, 没人知道发生过
//   (2) 热路径没有降级 —— _deps/_config 为 null 时直接抛
//   (3) 没有启动自检 —— 「进程活着」被当成「初始化完了」
//
// 判据都在负例里验证过: 逐条把修复拆掉, 断言必须变红。
//   绿灯是结果, 咬人是证据。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CORE = path.join(__dirname, '..');
const singleSrc = fs.readFileSync(path.join(CORE, 'pangu-single.js'), 'utf8');
const helpersSrc = fs.readFileSync(path.join(CORE, 'modules', 'pangu_helpers.js'), 'utf8');
const streamSrc = fs.readFileSync(path.join(CORE, 'modules', 'pangu_agent_stream.js'), 'utf8');

// 守卫(3)抽成谓词: 同一把尺子, 分别量「现在的代码」和「变异后的代码」,
// 变异文本必须被判不合格 —— 否则这条负例就是空枪。
function bodyGuardHolds(src) {
  const noBareRead = !/bytes\s*>\s*_deps\.MAX_BODY_BYTES/.test(src);
  const hasFallback = /\(\s*_\w+\s*&&\s*_\w+\.MAX_BODY_BYTES\s*\)\s*\|\|\s*panguHelpers\.MAX_BODY_BYTES/.test(src);
  return noBareRead && hasFallback;
}

test('(1) 顶头配置初始化的 catch 不是静默的 —— 抛错必须留下痕迹', () => {
  const catchBlock = singleSrc.match(
    /catch\s*\(e\)\s*\{\s*(?:\/\/[^\n]*\n\s*)*console\.error\(\s*'\[config-init\][\s\S]{0,400}?_config\s*=\s*\{\s*llm/
  );
  assert.ok(
    catchBlock,
    'pangu-single.js 顶层配置 catch 里没有 [config-init] 日志 —— '
    + '这正是 10-22 那次静默降级: 抛错没人知道, _config 变空壳, helpers 拿到 null'
  );
});

test('(2) pangu_helpers 的 _config 初值是可用空壳, 不是 null', () => {
  // null 意味着「init 没跑到」和「配置真的空」是同一个状态, 无法区分,
  // 而 getCurrentModel() 会直接 TypeError —— 它在 listen 回调里被调。
  assert.match(
    helpersSrc,
    /let\s+_config\s*=\s*\{\s*llm\s*:/,
    'pangu_helpers._config 初值又是 null 了 —— init 没跑到时整模块埋雷'
  );
  assert.doesNotMatch(helpersSrc, /let\s+_config\s*=\s*null\s*;/);
});

test('(3) body guard 不再硬读 _deps —— 上限有真源兜底', () => {
  // 护栏的职责是 DoS 防护, 不能因为依赖没注进来就整条失效。
  assert.ok(
    bodyGuardHolds(streamSrc),
    'body guard 还在裸读 _deps.MAX_BODY_BYTES (null 时每个 POST 都挂死), '
    + '或上限没落到 panguHelpers.MAX_BODY_BYTES 真源上'
  );
});

test('(4) 注入就绪状态可被外部查询 (_isInitDone)', () => {
  const streamMod = require(path.join(CORE, 'modules', 'pangu_agent_stream.js'));
  assert.equal(
    typeof streamMod._isInitDone,
    'function',
    '缺 _isInitDone —— 启动自检没法把「进程活着」和「注入完了」分成两件事'
  );
  // 未 init 的模块实例必须报 false (而不是抛), 自检才有意义。
  assert.equal(streamMod._isInitDone(), false, '本测试没调 init, 就绪探针却报 true —— 探针是假的');
});

test('(5) 启动末尾有自检, 且它查的正是就绪探针', () => {
  assert.match(
    singleSrc,
    /boot-selfcheck/,
    'listen 回调末尾没有启动自检 —— 注入没跑到时只能靠读日志碰运气'
  );
  assert.match(
    singleSrc,
    /setImmediate\(\(\)\s*=>\s*\{[\s\S]{0,1500}?_isInitDone\(\)/,
    '启动自检没查 pangu_agent_stream 的就绪状态'
  );
});

test('(6) 装饰性日志做 null 安全, 不排在依赖注入之前', () => {
  // 这行日志读 _config.llm.models, 它抛过一次就把后面所有 init 带走了。
  assert.doesNotMatch(
    singleSrc,
    /\$\{_config\.llm\.models\.length\}/,
    '「模型池」这行又变回裸读 _config.llm —— 它在 init 之前, 抛一次全哑'
  );
  assert.match(singleSrc, /_config\?\.llm\?\.models/);
});

// 负例: 拆掉修复, 断言必须变红。绿灯不可信, 咬人才算证据。
test('负例: 把 _config 初值改回 null, 守卫(2)必须报出来', () => {
  const broken = helpersSrc.replace(
    /let\s+_config\s*=\s*\{\s*llm\s*:\s*\{[^}]*\}\s*\};/,
    'let _config = null;'
  );
  assert.notEqual(broken, helpersSrc, '变异没生效 —— 替换目标对不上, 这条负例是空枪');
  assert.doesNotMatch(
    broken,
    /let\s+_config\s*=\s*\{\s*llm\s*:/,
    '守卫没咬住: _config 已是 null 它还放行'
  );
});

test('负例: 去掉 body guard 兜底, 守卫(3)必须报出来', () => {
  // 还原成病发时的原样: 裸读 _deps, 没有真源兜底。
  const broken = streamSrc
    .replace(
      /const\s+_\w+\s*=\s*\(\s*_\w+\s*&&\s*_\w+\.MAX_BODY_BYTES\s*\)\s*\|\|\s*panguHelpers\.MAX_BODY_BYTES;/,
      'const _limit = _deps.MAX_BODY_BYTES;'
    )
    .replace(/bytes\s*>\s*_\w+\)/, 'bytes > _deps.MAX_BODY_BYTES)');
  assert.notEqual(broken, streamSrc, '变异没生效 —— 替换目标对不上, 这条负例是空枪');
  assert.match(broken, /bytes\s*>\s*_deps\.MAX_BODY_BYTES/, '变异没生效: 比较没换回去');
  assert.equal(
    bodyGuardHolds(broken),
    false,
    '守卫没咬住: 兜底被拆了它还放行 —— 这条守卫等于没有'
  );
});

test('负例: 把顶头 catch 的日志删掉, 守卫(1)必须报出来', () => {
  const broken = singleSrc.replace(
    /console\.error\(\s*'\[config-init\][\s\S]{0,400}?\);\s*\n/,
    ''
  );
  assert.notEqual(broken, singleSrc, '变异没生效 —— 替换目标对不上, 这条负例是空枪');
  assert.doesNotMatch(
    broken,
    /catch\s*\(e\)\s*\{\s*(?:\/\/[^\n]*\n\s*)*console\.error\(\s*'\[config-init\]/,
    '守卫没咬住: catch 里的日志被删了它还放行'
  );
});
