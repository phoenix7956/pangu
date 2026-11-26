'use strict';

// 2026-10-19 会话 59740796 现场:
//   [dispatcher] load config failed: ENOENT ... /.pangu/config/nodes/your-mac.json
//   [dispatcher] §0.22 违规: dui 返回 0 工具调用, 补 1 次重试
//   [dispatcher] §0.22 违规2次: dui 重试后仍 0 工具调用, 强制失败
//
// 三行日志是一条因果链, 而且**每一环都静默**:
//   qian.js execute() 的配置兜底路径拼成 ~/.pangu/config/nodes/,
//   那个目录树从来就不存在 (真源在仓库 apps/core/config/nodes/)
//     → loadConfig 吞成 null (只 console.warn, 不抛)
//       → getEnabledModel(null) = null
//         → llm 退回 'LLM 模拟响应: <role>' —— 8 将灵全部返回假数据
//           → 假数据里当然没有工具调用
//             → §0.22 判定"违规", 重试一次, 还是 0 工具, 强制失败
//
// 最毒的地方: §0.22 那两行看起来像"模型不听话",
// 而真因是**模型压根没被调用过**。查模型依从性查到头也查不出来。
//
// 所以这条守卫断言的是**文件真的存在 + 真能选出模型**,
// 不是断言源码里那个字符串长什么样 —— 后者正是上一轮 T13 漏掉英文身份的同款错。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CORE = path.join(__dirname, '..');

test('D1 execute() 的配置兜底路径必须真的指向磁盘上的真源', () => {
  const src = fs.readFileSync(path.join(CORE, 'agents', 'qian.js'), 'utf8');
  // ── 判据按**概念**写: 「兜底那条路径必须落在磁盘上真实存在的文件」 ──
  //   不按「源码里必须长得像 path.join(...)」写 —— 那是入口点判据,
  //   换一种写法(比如走 config/node_config.js 解析)就假红,
  //   而守卫真正的目的(别让兜底指向不存在的文件)反而没人守了。
  //   2026-10-26 第 108 批: 节点配置路径不再写死机器名, 改由
  //   config/node_config.js 解析 ⇒ 判据同步升级。
  const m = src.match(/context\.config_path\)\s*\n?\s*\|\|\s*\n?\s*(.+);/);
  assert.ok(m, 'execute() 里没有配置兜底了 —— 守卫得跟着改, 别让它悄悄变成另一条坏路径');

  let abs;
  if (/node_config/.test(m[1])) {
    abs = require(path.join(CORE, 'config', 'node_config')).resolveNodeConfigPathOrExample();
  } else {
    const j = m[1].match(/path\.join\(([^)]+)\)/);
    assert.ok(j, 'execute() 里的配置兜底路径写法变了 —— 守卫得跟着改, 别让它悄悄变成另一条坏路径');
    // __dirname 是源码里的标识符, 不是路径片段 —— 换成 qian.js 自己所在目录,
    // 否则 path.join 会把它当成相对目录名拼出一条假路径 (第一版守卫就栽在这)。
    const here = path.join(CORE, 'agents');
    const parts = j[1].split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .map((s) => (s === '__dirname' ? here : s));
    abs = path.resolve(...parts);
  }
  assert.ok(fs.existsSync(abs),
    '配置兜底路径指向一个不存在的文件: ' + abs
    + '\n真源在 apps/core/config/nodes/ 下 (由 config/node_config.js 解析)。'
    + '\n路径不存在 → loadConfig 返回 null → llm 退化成 mock → 8 将灵全返假数据 → '
    + '再被 §0.22 误判成"模型不调工具"。');
  assert.ok(!abs.startsWith(path.join(os.homedir(), '.pangu')),
    '兜底路径又指回 ~/.pangu 了 —— 那个目录树里从来没有过 nodes/。');
});

test('D2 走 execute() 那条兜底, 必须真的选得出模型 (不许静默退化成 mock)', async () => {
  const { getEnabledModel } = require(path.join(CORE, 'agents', 'qian.js'));
  const cfgPath = require(path.join(__dirname, '..', 'config', 'node_config')).resolveNodeConfigPathOrExample();
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const model = getEnabledModel(cfg);
  assert.ok(model && model.id,
    '配置读得到却选不出模型 —— 那 getEnabledModel 一旦拿到 null 就静默退化成 mock, '
    + '8 将灵开始编数据, 现场一条日志都不会报。');
  assert.strictEqual(model.enabled !== false, true, '兜底选出来的模型是 disabled 的');
});

test('D3 报错文案不许推荐配置里不存在的模型名 (手抄的名字一定会漂)', () => {
  const cfg = JSON.parse(fs.readFileSync(require(path.join(__dirname, '..', 'config', 'node_config')).resolveNodeConfigPathOrExample(), 'utf8'));
  const real = new Set((cfg.llm.models || []).map((m) => m.id));
  // 直接问**渲染出来**的那句话, 不扫源码 —— 源码里这句话被字符串拼接切成了
  // 好几段, 扫源码必然匹配到半截 (`+ _suggest +`)。模型和主人读到的是成品。
  const { _infraFailText } = require(path.join(CORE, 'modules', 'j2_loop_shared.js'));
  const rendered = [
    _infraFailText('read ECONNRESET', { id: 'qwen_qwen3.8-27b' }),
    _infraFailText('HTTP 429 quota exceeded', { id: 'k3-256k' }),
  ];
  for (const text of rendered) {
    const hit = text.match(/切换到其他模型 \(([^)]*)\)/);
    assert.ok(hit, '报错文案里连"切换到其他模型"这句都没了, 主人无从下手: ' + text);
    if (/见「设置」/.test(hit[1])) continue;   // 读不到配置时的兜底话术, 不算候选
    const ids = hit[1].split(/\s*\/\s*/).map((s) => s.trim()).filter(Boolean);
    assert.ok(ids.length > 0, '报错文案没有给出任何候选模型: ' + text);
    for (const id of ids) {
      assert.ok(real.has(id),
        '报错推荐切换到「' + id + '」, 但配置里**没有这个模型**。\n'
        + '主人照着报错去「设置」里搜这个名字 —— 查无此模型, 比不提示还坏。\n'
        + '配置里真实存在的: ' + [...real].join(' / '));
    }
  }
});

test('D4 qian.js 里模型真正读到的提示词, 自述必须用卦名而不是英文身份', async () => {
  const { AgentDispatcher } = require(path.join(CORE, 'agents', 'qian.js'));
  const d = new AgentDispatcher({ llm: async (p) => {
    assert.ok(!/\bDispatcher\b/.test(p.split('\n')[0]),
      '分类器/收口提示词第一行还在自称 Dispatcher —— 英文身份漏进运行时了');
    assert.ok(!/你是 Pangu\b/.test(p),
      '提示词里还在自称 Pangu (英文), 同一套身份中英两个名字');
    return { content: '' };
  } });

  // 角色提示词
  for (const code of ['kan', 'li', 'kun', 'dui', 'xun', 'zhen', 'gen', 'qian']) {
    const p = d._buildRolePrompt(code, {});
    const line = p.split('\n').find((l) => l.startsWith('你是')) || '';
    assert.ok(/盘古八将灵中的\s*[乾坎艮震巽离坤兑]/.test(line),
      code + ' 的自述不是卦名: ' + line.slice(0, 50));
  }
  // 分类器 + 收口 (这两段上次手抄 Dispatcher, 英文身份就是这么漏进来的)
  d._buildClassifyPrompt('做个体检');
  await d._synthesize({ input: 'x' }, {}, {}, [], {}, {}, {});
});
