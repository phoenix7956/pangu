'use strict';

// 2026-10-17: 子 agent 不知道模型池配置在哪 → 拿搜索当摸路, 一次任务多烧十几秒。
//
// 现场 (session tl-1792194031729, 老板那道「查清楚模型池」长任务):
//   analyzer 的工具构成 (修复前 → 修复后那类"摸路"占比):
//     exec_command 14, read_file 5            ← 全靠 shell 到处 grep
//   → search_files 7, file_grep 2, list_directory 1, exec_command 5
//   也就是 **10 次纯摸路的搜索往返**, 而答案只要 read_file 一次 models.json。
//
// 根因不是模型笨, 是盘古没告诉它路在哪:
//   llm_caller 里那块「自身源码地图」(含仓库根 / 64i / tools/index.js) 是
//   `_push(msg, false)` —— **keepForWorker=false, worker 根本拿不到**。
//   而全局铁律又写着「禁止凭印象, 必须查证」—— 只给了"不许猜", 没给"去哪查",
//   模型只能 search_files / find 摸过去。这正是「禁止凭印象」这条铁律的执行缺口:
//   禁止猜却又不指路, 结果就是用搜索代替凭印象。
//
// K1/K2 是动态的: 真调 _buildSystemMessages, 看主 agent 和 worker 是不是都拿到了。
//   只查源码里有没有这段字是不够的 —— 今天栽过"字段写了没被用掉"。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const lc = require(path.join(ROOT, 'modules', 'llm_caller.js'));

const CHEATSHEET = '关键路径速查';

test('K1 worker 必须拿到关键路径速查 —— 那块「自身源码地图」是 main 专属', () => {
  const worker = lc._buildSystemMessages({}, 'worker');
  assert.ok(Array.isArray(worker) && worker.length > 0, '要能拿到 worker 档系统消息');
  assert.ok(worker.some((m) => String(m.content || '').includes(CHEATSHEET)),
    'worker 没拿到关键路径速查 —— 子 agent 会退回 search_files 摸路 '
    + '(现场一次任务多烧 10 次搜索往返)');
});

test('K2 主 agent 同样要拿到, 且路径必须指向真实存在的文件', () => {
  // 只给 worker 是把主 agent 排除在外了; 而主 agent 是先拆刀的那个, 它更需要知道
  // 哪个文件是权威源, 才能在 task 里直接告诉子 agent "读这个"。
  const main = lc._buildSystemMessages({}, 'main');
  const block = (main.find((m) => String(m.content || '').includes(CHEATSHEET)) || {}).content;
  assert.ok(block, '主 agent 也必须拿到关键路径速查');

  // 路径写错比不写更坏 —— 「禁止凭印象」这把刀会反过来割自己。
  // 现场就栽在这: 地图把仓库根写死成 `~/pangu/`, 而真仓库在 ~/Desktop/pangu,
  // 模型照着读必然失败, 失败后退回 search_files 摸路 (一次任务多烧 10 次搜索往返)。
  // 所以这里不只查"写了这条路径", 还要查**写的那条在磁盘上真的存在**。
  const repo = path.resolve(ROOT, '..', '..');
  const home = process.env.HOME || '';
  const asShown = (abs) => (home && abs.startsWith(home))
    ? '~' + abs.slice(home.length)
    : abs;
  // 两类路径, 判据**不一样**:
  //   mustExist   —— 仓里就有的 (克隆下来必然存在)。写错这条 = 模型照着读必然失败。
  //   runtimeOnly —— 运行时才有的 (router 模型池缓存 / ~/.pangu 下的登记与配置)。
  //                  它们在**跑起来之后**才生成, 干净克隆和 CI 上本来就不存在 ——
  //                  所以只钉「速查表里写的路径字符串没写错」, 不钉「文件此刻在不在」。
  //                  (2026-10-28: router/models.json 改成运行时文件, 不入库 ——
  //                   以前这条断言在 CI 上就是红的, 只是没人跑。)
  const mustExist = [
    path.join(repo, 'apps/core/modules'),
    require(path.join(repo, 'apps', 'core', 'config', 'node_config')).resolveNodeConfigPathOrExample(),
  ];
  const runtimeOnly = [
    path.join(repo, 'apps/core/modules/router/models.json'),
    path.join(home, '.pangu/config.json'),
    path.join(home, '.pangu/models-registry.json'),
  ];
  for (const p of mustExist) {
    assert.ok(fs.existsSync(p), '速查表里的路径必须真实存在: ' + p
      + ' —— 写一条不存在的路径比不写更坏, 「禁止凭印象」会反过来割自己');
    const shown = asShown(p);
    assert.ok(block.includes(shown),
      '速查表必须写出这个路径: ' + shown + ' (实际 ' + p + ')');
  }
  for (const p of runtimeOnly) {
    const shown = asShown(p);
    assert.ok(block.includes(shown),
      '速查表必须写出这个路径: ' + shown + ' (实际 ' + p + ')');
  }
  assert.ok(!block.includes('~/pangu/'),
    '速查表里不许再出现 `~/pangu/` —— 这个目录在这台机器上不存在, '
    + '模型照着读必然失败然后退回 search_files 摸路');
});

test('K3 速查表不许膨胀成目录树 —— 它只买"别摸路", 不是完整地图', () => {
  const worker = lc._buildSystemMessages({}, 'worker');
  const block = (worker.find((m) => String(m.content || '').includes(CHEATSHEET)) || {}).content || '';
  assert.ok(block.length > 0, '要拿到那块文本');
  assert.ok(block.length < 1200,
    `速查表 ${block.length} 字符, 超过 1200 就该砍 —— 它是静态块, 每轮 prefill 都付钱, `
    + '定位"别摸路"就够了, 完整地图该去 search_files');
  assert.ok(!block.includes('64i/'),
    'K3: 「自身源码地图」已经有 64i 了, 不许在速查表里重复 —— 同一份东西抄两遍迟早对不上');
});

