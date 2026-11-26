// 将灵职责单一权威 (2026-10-19)
//
// 老板指出一件事: 「☵坎」是将灵, 「坎·手指」里的身体部位属于意象,
// 「坎 · 拆」是将灵在做什么 —— 三个是**不同的层**。
//
// 顺着这个区分去查, 发现后端把其中两层**手写进了同一个字段**:
// gua-identity.js 的 `zh` 原来是 '手指 · 求解' / '心 · 破局' / '眼 · 分析' ……
// 身体部位(意象) 和职责动词 各写了一份, 而职责的真源是 `role`。
//
// 这不是显示层的 cosmetic 问题。zh 会流进**提示词**:
//   sub-agent.js:304  ROLES[code].name = g.zh
//   sub-agent.js:1523 '你作为 ${role.name} 必须调用工具来完成任务…'
// 于是 8 个里 7 个, 模型在提示词里被告知的职责跟真职责对不上:
//   提示词「手指 · 求解」 vs 真职责「拆」    「心 · 破局」 vs 「复盘」
//   「耳 · 渗透」 vs「找雷」  「眼 · 分析」 vs 「读」  「手 · 执行」 vs 「做」
//   「舌 · 交互」 vs 「验」    「骨 · 守成」 vs 「记」
// 跟"8 将灵统一"是同一类病 —— 一个角色两个名字, 只是这次藏在同一个字段里,
// 而且藏进了模型读的东西里, 比面板上写错更贵。
//
// 修法 (结构性, 不是注释): 意象层整个砍掉, 职责**只**归 `role`,
// `zh` 由 `gua · role` 派生。派生 = 结构上写不出第二个职责动词。
//
// 本测试钉住三件事:
//   D1 zh 恒等于 gua · role         —— 派生关系, 不是巧合
//   D2 意象层不许回来                —— part 字段 + 身体部位字面量都不许有
//   D3 提示词里的 name 职责 == role   —— 模型看到的和运行时认的是同一个
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const CORE = path.join(__dirname, '..');
const identity = require(path.join(CORE, 'agents', 'gua-identity.js'));
const { ROLES } = require(path.join(CORE, 'agents', 'sub-agent.js'));

const GUA_ROLES = identity.GUA_ROLES;

test('D1 zh 恒等于 gua · role (派生, 不是手写的第二份职责)', () => {
  for (const r of GUA_ROLES) {
    assert.strictEqual(r.zh, `${r.gua} · ${r.role}`,
      `${r.gua} 的 zh 跟 gua · role 对不上 —— `
      + '说明又有人往 zh 里手写了职责动词。职责只有一个真源: role 字段。');
  }
});

test('D2 意象层不许回来 (part 字段 + 身体部位字面量都不许有)', () => {
  // 2026-10-19 老板: 「干脆把意向砍了, 可能更顺」。意象不含新信息 ——
  // 8 个 system prompt 第一行本来就自述了身份, 而且它让同一个将灵在
  // ChatRoom / ProgressBar / SubAgentPanel 三处有三种长相。
  // 砍掉之后只剩 gua (它是谁) + role (它干什么), 显示统一成「卦 · 职责」。
  for (const r of GUA_ROLES) {
    assert.strictEqual(r.part, undefined,
      `${r.gua} 又有了 part='${r.part}' —— 意象层已经砍掉了。`
      + ' 意象不含新信息, 而且它正是"同一个将灵三处三种长相"的根源。');
    // zh 里也不许混进身体部位 (旧格式 '手指 · 拆' / '坎·手指')
    const BODY = ['手指', '大脑', '骨', '心', '耳', '眼', '手', '舌', '舌秤'];
    for (const b of BODY) {
      assert.ok(!r.zh.includes(b),
        `${r.gua} 的 zh='${r.zh}' 含身体部位 '${b}' —— 意象层已砍, 只该是「卦 · 职责」。`);
    }
  }
});

test('D3 提示词里的 name 职责 == role (模型看到的和运行时认的是同一个)', () => {
  for (const [code, role] of Object.entries(ROLES)) {
    const g = identity.GUA_BY_CODE[code];
    if (!g) continue;
    assert.ok(role.name && String(role.name).includes(g.role),
      `${code} 在提示词里的身份是 '${role.name}', 但真职责是 '${g.role}' —— `
      + `模型会被告知自己是 '${role.name}', 干的却是 '${g.role}' 的活。`
      + ' name 必须由 part · role 派生 (sub-agent.js 从身份真源取名)。');
  }
});

test('D4 8 个将灵都有 gua 和 role, 且两层各自互不重复', () => {
  assert.strictEqual(GUA_ROLES.length, 8, '将灵数不是 8');
  const guas = GUA_ROLES.map(r => r.gua);
  const roles = GUA_ROLES.map(r => r.role);
  assert.strictEqual(new Set(guas).size, 8,
    `卦名有重复: ${guas.join('/')} —— 两个将灵共用一个卦名会读成同一个角色`);
  assert.strictEqual(new Set(roles).size, 8,
    `职责层有重复: ${roles.join('/')} —— 同一个职责出现两次, "谁在干什么"就分不清`);
});
