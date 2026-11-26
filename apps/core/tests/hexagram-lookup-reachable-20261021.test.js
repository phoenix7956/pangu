'use strict';
// hexagram-lookup-reachable-20261021.test.js
//
// 立这条是因为 2026-10-21 一次真实跑题的根因不是模型笨, 是**真源够不着**:
// hexagram_lookup 在 TOOLS_SCHEMA 里, 描述写得很硬 ("问第N卦是哪一卦 → 第一个动作
// 就是调这里"), 但它**不在任何一个将灵角色的白名单里** —— 只在主循环的
// MAIN_GENERAL_TOOLS_FOR_LLM 有。题一旦派给子 agent, 真源就消失了。
//
// 现场后果一字不差地落在答案里: 模型去 web_search、想用 python 列表核对卦序
// (被只读守卫拦)、web_fetch 404, 然后写出 **错的** 卦序 "第24卦: 贲卦"。
// 64i 真值: 24=复, 贲=22。它自己在证据说明里都写了"为记忆结论, 未获机器校验"。
//
// 这跟 li 系统提示里已记着的 bazi_calc 事故是**同一个形状**:
//   "白名单漏了 bazi_calc, 排盘题路由到将灵后无工具可用, 模型直接把整张盘编出来"
// 同一个坑踩第二次, 所以这次不只补名单, 还要装一条**兜底自检**:
//   术数真源工具 (查表类) 至少得有一个研究型角色够得着。

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { console.log('  ✅ ' + msg); pass++; }
  else { console.log('  ❌ ' + msg); fail++; }
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'agents', 'sub-agent.js'), 'utf8');

function roleTools(role) {
  const m = SRC.match(new RegExp('^  ' + role + ': \\{[\\s\\S]{0,4000}?tools: \\[([^\\]]*)\\]', 'm'));
  if (!m) return null;
  return m[1].match(/'([^']+)'/g).map(x => x.replace(/'/g, ''));
}
function roleBlock(role) {
  const m = SRC.match(new RegExp('^  ' + role + ': \\{([\\s\\S]*?)\\n  \\w+: \\{', 'm'));
  return m ? m[1] : '';
}

console.log('--- 64i 真源够得着 (2026-10-21 实跑: 第24卦被答成贲卦, 真值 24=复 贲=22) ---');

// ① 研究型角色必须够得着 hexagram_lookup
for (const role of ['li', 'kun', 'dui', 'xun']) {
  const t = roleTools(role);
  ok(t && t.includes('hexagram_lookup'),
    role + ' 白名单里有 hexagram_lookup (实际 ' + (t ? t.length : '?') + ' 个工具)');
}

// ② 光有工具不够 —— 角色得被**告知**先查它, 否则模型照样凭记忆
ok(/64 卦资料必须调 hexagram_lookup/.test(roleBlock('li')),
  'li 的系统提示写明 64 卦资料先调 hexagram_lookup');
ok(/第24卦/.test(SRC) && /贲=22/.test(SRC),
  'li 的规则里留了这次实跑的错例证据 (不是空口规则)');

// ③ 只读角色调它不该被拦 (它是查表, 不改状态)
const ap = require('../modules/action_policy');
for (const role of ['li', 'dui', 'xun', 'zhen']) {
  const v = ap.checkRoleAction(role, 'hexagram_lookup', { query: '24' });
  ok(v && v.ok === true, role + ' 调 hexagram_lookup 不被只读守卫拦 (got ' + JSON.stringify(v) + ')');
}

// ④ 兜底自检: 术数真源工具不能只活在主循环白名单里
//    (锁的是"形状" —— 下次再加一个查表工具又忘了给将灵, 这里立刻红)
for (const t of ['bazi_calc', 'hexagram_lookup']) {
  const anyRoleHas = ['li', 'kun', 'dui', 'xun'].some(r => {
    const tools = roleTools(r);
    return tools && tools.includes(t);
  });
  ok(anyRoleHas, '术数真源工具 ' + t + ' 至少有一个研究型角色够得着');
}

// ⑤ 工具真能用, 且卦序是 1..64 文王序
//    (老板原话: "64卦有一个最大的坑, 不是1~64是0~63")
const { TOOLS } = require('../modules/tools');
(async () => {
  const r24 = await TOOLS.hexagram_lookup({ params: { query: '24' } });
  ok(r24 && r24.ok && r24.data && r24.data.name === '复',
    'query="24" → 复 (实得 ' + (r24 && r24.data && r24.data.name) + ') —— 这正是那次答错的点');
  const rBen = await TOOLS.hexagram_lookup({ params: { query: '贲' } });
  ok(rBen && rBen.ok && rBen.data && rBen.data.id === 22,
    'query="贲" → id=22 (实得 ' + (rBen && rBen.data && rBen.data.id) + ')');
  const rList = await TOOLS.hexagram_lookup({ params: {} });
  ok(rList && rList.ok && rList.count === 64,
    '不传 query 返回 64 卦清单 (实得 ' + (rList && rList.count) + ')');
  const r63 = await TOOLS.hexagram_lookup({ params: { query: '63' } });
  ok(r63 && r63.ok && r63.data && r63.data.name === '既济',
    'query="63" → 既济 (文王序 63=既济, 实得 ' + (r63 && r63.data && r63.data.name) + ')');

  console.log('\n============================================================');
  console.log('测试结果：' + (fail === 0 ? '✅ 全部通过' : '❌ ' + fail + ' 项失败'));
  console.log('============================================================');
  if (fail > 0) process.exit(1);
})();
