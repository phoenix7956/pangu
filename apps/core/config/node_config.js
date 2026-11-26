/**
 * config/node_config.js —— 「用哪份节点配置」的唯一真源
 *
 * ── 为什么要有这个模块 ──
 *   原来 pangu-single.js 把节点配置写死成 `config/nodes/your-mac.json` ——
 *   那是**某台机器的名字**。别人 clone 下来要么读不到(启动即崩),
 *   要么得先猜「原来那个名字是什么」。
 *   ⇒ 开源仓里不该有别人的机器名当默认路径。
 *
 * ── 解析顺序 ──
 *   1. `PANGU_NODE_CONFIG` 环境变量 (显式指定, 相对路径按 cwd 解)
 *   2. `config/nodes/node.json` —— 通用安装约定的名字
 *   3. `config/nodes/` 下**唯一**一个非示例的 `.json` (兼容历史命名)
 *   4. 都没有 ⇒ 返回 `node.json` 这个**约定路径** (由调用方决定怎么报错)
 *
 * ── 为什么第 3 条不许「随便挑一个」 ──
 *   目录里有多个候选时, 挑哪个是**业务决定**, 不是代码该替人做的决定。
 *   多于一个 ⇒ 返回 null, 让调用方**大声报出来**, 而不是静默挑一个跑起来。
 *
 * ⚠️ 这里的文件名规则 (`.json` 结尾且不是 `.example`) 是**概念**层的判据:
   「这是不是一份真的节点配置」—— 不依赖调用方从哪个入口进来。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const NODES_DIR = path.join(__dirname, 'nodes');
const DEFAULT_NAME = 'node.json';

/** 候选节点配置文件 (排除模板: `*.example` 和 `example-*.json`)。 */
function listNodeConfigFiles() {
  let names;
  try {
    names = fs.readdirSync(NODES_DIR);
  } catch (e) {
    return [];
  }
  return names.filter(n =>
    n.endsWith('.json')
    && !n.endsWith('.example')
    && !/^example[-_]/i.test(n)).sort();
}

/**
 * @returns {{path: string, source: string, candidates: string[]}}
 *   source: 'env' | 'default-name' | 'only-candidate' | 'missing'
 */
function resolveNodeConfig() {
  const env = (process.env.PANGU_NODE_CONFIG || '').trim();
  if (env) {
    const p = path.isAbsolute(env) ? env : path.resolve(process.cwd(), env);
    return { path: p, source: 'env', candidates: listNodeConfigFiles() };
  }
  const preferred = path.join(NODES_DIR, DEFAULT_NAME);
  if (fs.existsSync(preferred)) {
    return { path: preferred, source: 'default-name', candidates: listNodeConfigFiles() };
  }
  const files = listNodeConfigFiles();
  if (files.length === 1) {
    return { path: path.join(NODES_DIR, files[0]), source: 'only-candidate', candidates: files };
  }
  if (files.length > 1) {
    // 多个候选 ⇒ 不猜。返回 null, 由调用方报清楚。
    return { path: null, source: 'ambiguous', candidates: files };
  }
  return { path: preferred, source: 'missing', candidates: [] };
}

/**
 * 给「必须有一份配置」的调用方用: 解析不出来就**大声报错**, 不返回空配置。
 *   @returns {string} 配置文件绝对路径
 */
function requireNodeConfigPath() {
  const r = resolveNodeConfig();
  if (!r.path) {
    throw new Error(
      '[node_config] config/nodes/ 下有多份候选节点配置, 不许替你猜: '
      + r.candidates.join(', ')
      + ' —— 用 PANGU_NODE_CONFIG 环境变量指定其中一份。',
    );
  }
  if (r.source === 'missing') {
    throw new Error(
      '[node_config] 找不到节点配置 (找过: PANGU_NODE_CONFIG / config/nodes/'
      + DEFAULT_NAME + ' / config/nodes/*.json)。'
      + '复制 config/nodes/example-node.json 成 config/nodes/' + DEFAULT_NAME
      + ' 再填你的 API key。',
    );
  }
  return r.path;
}

module.exports = {
  NODES_DIR,
  DEFAULT_NAME,
  listNodeConfigFiles,
  resolveNodeConfig,
  requireNodeConfigPath,
  /**
   * 兜底路径 (给「读不到就当没有」的调用方): 解析不出**或文件不存在** ⇒ 空串。
   *   这些调用方都是**可选**读节点配置 (提建议 / 拿角色档位), 读不到就退化成
   *   「没有建议」, 不该把整条链拖崩 —— 更不该退回某个人的机器名当默认路径。
   */
  resolveNodeConfigPathOrEmpty,
  /**
   * 测试/文档用: 真配置不在 (CI、别人的机器) ⇒ 退回**脱敏示例**。
   *   没有这一步, 依赖节点配置的守卫在全新 clone 上会「文件不存在」⇒ 假红。
   */
  resolveNodeConfigPathOrExample,
};

function resolveNodeConfigPathOrEmpty() {
  const r = resolveNodeConfig();
  if (r.path && fs.existsSync(r.path)) return r.path;
  return '';
}

function resolveNodeConfigPathOrExample() {
  const r = resolveNodeConfig();
  if (r.path && fs.existsSync(r.path)) return r.path;
  const ex = path.join(NODES_DIR, 'example-node.json');
  if (fs.existsSync(ex)) return ex;
  return r.path || ex;
}
