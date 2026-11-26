'use strict';
/**
 * tests/weixin-channel-20261030.test.js
 *
 * 第 172 批守卫 —— 「盘古接微信」
 *
 * 老板 10-30: 「盘古你可以操作, 只保留盘古可以接微信的接口就可以, 我需要你连微信」。
 *
 * 查出来的事实 (不是猜):
 *   · 盘古里的 send_wechat 一直是**空壳** —— 只往 ~/.pangu/weixin_queue/ 写文件,
 *     没有消费者, 所以工具直接返回 WECHAT_NOT_IMPLEMENTED (怕 LLM 假装成功)。
 *   · 真正能收发微信的是老 openclaw 桌面端里的腾讯官方插件
 *     (@tencent-weixin/openclaw-weixin), 账号 308231fa95df-im-bot 已绑好。
 *   · 那个插件的 dist **依赖 openclaw 宿主** (logger 里 import 'openclaw/plugin-sdk/infra-runtime')
 *     ⇒ 盘古不能直接用它的包。
 *   · 用同一套 iLink 协议 + 同一份凭据**自己实现**一份直连客户端 ⇒ 收发都通
 *     (2026-10-30 实测: 老板在微信发「1」→ 盘古 agent 跑一轮 → 回复回到微信)。
 *
 * 这批守卫盯七件事:
 *   ① send_wechat 不许再退回空壳 (空壳 = 老板在微信那头永远收不到盘古的话)
 *   ② send_wechat 必须在 main 工具集里 (主 agent 要能主动推微信)
 *   ③ schema 的必填必须是 message 而不是 to (模型不知道 user_id, 必填 to = 逼它瞎编)
 *   ④ 盘古的通道不许依赖 openclaw 宿主 (老桌面端要退休, 盘古不能被它拖死)
 *   ⑤ 凭据不许进 repo (bot token 是密钥)
 *   ⑥ context_token 必须用**最新**那条 (旧的会被服务端拒: ret=-2 prepare failed)
 *   ⑦ 长轮询超时不许当成故障 (那是"没有新消息"的正常控制流)
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const APP = path.resolve(__dirname, '..');
const REPO = path.resolve(APP, '..', '..');
const MODULES = path.join(APP, 'modules');

const CHANNEL = path.join(MODULES, 'weixin_channel.js');
const BRIDGE = path.join(MODULES, 'weixin_bridge.js');
const TOOLS = path.join(MODULES, 'tools', 'index.js');
const SCHEMA = path.join(MODULES, 'tools_schema', 'web_info.js');
const MAIN_LIST = path.join(MODULES, 'tools_schema.js');

const channelSrc = fs.readFileSync(CHANNEL, 'utf8');
const bridgeSrc = fs.readFileSync(BRIDGE, 'utf8');
const toolsSrc = fs.readFileSync(TOOLS, 'utf8');
const schemaSrc = fs.readFileSync(SCHEMA, 'utf8');
const mainListSrc = fs.readFileSync(MAIN_LIST, 'utf8');

test('172-①: send_wechat 不许再是空壳', () => {
  assert.ok(!/WECHAT_NOT_IMPLEMENTED/.test(toolsSrc),
    'send_wechat 又退回空壳了 —— 老板在微信那头永远收不到盘古的话');
  assert.ok(/weixin_channel/.test(toolsSrc),
    'send_wechat 工具必须真调 modules/weixin_channel.js, 不许自己另写一套');
  assert.ok(/sendText/.test(toolsSrc),
    'send_wechat 必须走 weixin_channel.sendText —— 那是唯一真发过微信的那条路');
});

test('172-②: send_wechat 必须在 main 工具集里 (主 agent 要能主动推微信)', () => {
  const { MAIN_GENERAL_TOOLS_FOR_LLM } = require(MAIN_LIST);
  assert.ok(MAIN_GENERAL_TOOLS_FOR_LLM.includes('send_wechat'),
    'send_wechat 不在 MAIN_GENERAL_TOOLS_FOR_LLM ⇒ 主 agent 看得见 schema 却调不到 '
    + '(网页/终端里跟盘古说话, 盘古没法把结果推回微信)');
});

test('172-③: schema 必填是 message, to 可省 (模型不知道 user_id)', () => {
  const m = schemaSrc.match(/send_wechat:\s*\{[\s\S]*?meta:/);
  assert.ok(m, 'tools_schema 里找不到 send_wechat');
  const seg = m[0];
  assert.ok(/required:\s*\['message'\]/.test(seg),
    "send_wechat 的必填必须是 ['message'] —— 必填 to 会逼模型瞎编一个 user_id");
  assert.ok(!/required:\s*\['to'\]/.test(seg),
    "send_wechat 不许再必填 to (省略 to = 发给绑定的默认会话, 也就是主人)");
});

test('172-④: 盘古的微信通道不许依赖 openclaw 宿主', () => {
  // 只查**真的 import/require**, 不查注释里提到它 —— 注释里说明"为什么不用那个插件"
  // 是有意留的 (那是决策依据), 拦下来反而逼人删证据。
  for (const [name, src] of [['weixin_channel.js', channelSrc], ['weixin_bridge.js', bridgeSrc]]) {
    const importsHost = /require\(\s*['"]openclaw\//.test(src) || /from\s+['"]openclaw\//.test(src);
    assert.ok(!importsHost,
      name + ' 不许 import openclaw/plugin-sdk —— 老桌面端退休后盘古会直接起不来');
    assert.ok(!/\.openclaw\/openclaw-weixin/.test(src),
      name + ' 不许去读 ~/.openclaw 的凭据 —— 凭据要搬进盘古自己的 PANGU_HOME');
  }
  assert.ok(/PANGU_HOME/.test(channelSrc),
    'weixin_channel 的目录必须挂在 PANGU_HOME 下 (盘古 owns 自己的凭据)');
});

test('172-⑤: 凭据不许进 repo', () => {
  // bot token 长什么样: "<account>@im.bot:<hex>"
  const tracked = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (!/\.(js|mjs|json|sh|md|txt|plist)$/.test(e.name)) continue;
      let txt = '';
      try { txt = fs.readFileSync(p, 'utf8'); } catch (_) { continue; }
      if (/@im\.bot:[0-9a-f]{16,}/i.test(txt)) tracked.push(path.relative(REPO, p));
    }
  };
  walk(REPO, 0);
  assert.deepStrictEqual(tracked, [],
    'repo 里出现了微信 bot token 明文: ' + tracked.join(', ') + ' —— 密钥不进代码库');
});

test('172-⑥: context_token 必须用最新那一条', () => {
  assert.ok(/saveContextToken/.test(channelSrc),
    '收到入站消息必须记住最新的 context_token');
  // 语义检查: parseMessages 里先把 token 存下来, 再从存储里取 (而不是用旧的)
  const m = channelSrc.match(/function parseMessages[\s\S]*?\n}/);
  assert.ok(m, '找不到 parseMessages');
  const seg = m[0];
  const saveAt = seg.indexOf('saveContextToken');
  assert.ok(saveAt > 0, 'parseMessages 必须保存入站消息带来的 context_token');
  assert.ok(/loadContextToken/.test(seg),
    'parseMessages 必须**从存储里取** context_token —— 用消息里带的旧值会被服务端拒 '
    + '(ret=-2 prepare failed, 老 openclaw 断出站就是这个原因)');
});

test('172-⑦: 长轮询超时不许当成故障', () => {
  const m = channelSrc.match(/async function pollOnce[\s\S]*?\n}/);
  assert.ok(m, '找不到 pollOnce');
  assert.ok(/timeout/i.test(m[0]),
    'pollOnce 必须把长轮询超时当成正常控制流 (没有新消息), 不许抛错');
});

test('172-⑧: 通道模块要能加载, 且状态字段齐全', () => {
  const ch = require(CHANNEL);
  for (const fn of ['sendText', 'pollOnce', 'startPolling', 'parseMessages', 'status', 'saveAccount']) {
    assert.equal(typeof ch[fn], 'function', 'weixin_channel 少导出 ' + fn);
  }
  const s = ch.status();
  for (const k of ['configured', 'tokenPresent', 'defaultRecipientPresent', 'contextTokens', 'dir']) {
    assert.ok(k in s, 'status() 少字段 ' + k);
  }
});

test('172-⑨: 桥要把微信消息交给盘古自己的 agent, 并把答案发回去', () => {
  assert.ok(/\/api\/chat/.test(bridgeSrc),
    '微信桥必须走盘古自己的 /api/chat (跟网页工作台同一条执行路径)');
  assert.ok(/run_j2:\s*true/.test(bridgeSrc),
    '微信桥必须跑完整 agent loop (run_j2=true), 不许只做单次快问');
  assert.ok(/sendText/.test(bridgeSrc),
    '微信桥必须把答案发回微信');
  assert.ok(/session_id/.test(bridgeSrc),
    '微信桥必须带 session_id —— 老板在微信里连着问要是同一段上下文');
});

