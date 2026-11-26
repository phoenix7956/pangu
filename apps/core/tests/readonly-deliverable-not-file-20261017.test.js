'use strict';

// 2026-10-17: 只读角色被派了"必须落盘"的活 → 20 次工具调用 / 14 轮 / 75 秒空转。
//
// 现场 (session tl-1792193377047, 老板那道「查清楚模型池」长任务):
//   sub-0-analyzer 单刀就跑了 20 次工具调用 / 14 轮。而"把配置文件里的模型池
//   列成一张表"真正需要的只有 4 次 (读 models.json / config / registry / 汇总)。
//
// 根因是一个**死结**, 两头同时逼它:
//   ① planner 拆出来的 task 写着「输出结构化报告, 并明确给出该报告的实际产出
//      文件路径」。planner 读的是主 agent 版全局铁律 (dispatcher.js:368 调
//      getGlobalRules() 不带参数 → main 全量), 其中 #24「产出 > 报告…核验只认
//      『写了哪个文件 + 路径』」—— 那条对主 agent 成立, 对只读 worker 是死路。
//   ② analyzer 是只读角色, 写不了文件, 执行层 ROLE_READ_ONLY 硬拦。
//   而它的系统提示原来只说「被拒时交给 executor 去写」, **没说"你的交付物就是
//   这条回复本身"** → 它既交不了差又不敢直接答, 只能一轮轮换命令摸文件,
//   撞满轮数上限后报「部分交付」→ 系统判 partial → 自动续跑 4 次 (71s~210s)。
//
// 修法 (两端都改, 因为死结是两头造成的):
//   - worker 侧: READONLY_DELIVERABLE_NOTE 追加到每个只读角色的 system prompt
//     (角色清单取 action_policy.READ_ONLY_ROLES = 执行层真正拦权的那个集合)
//   - planner 侧: 明令只读角色的子任务不许要求写盘, 要写盘派 executor
//
// D1/D2 是动态的: 真 require 出 ROLES, 逐个只读角色查它真的拿到了那句。
//   只查字面量里有没有这段字符串是不够的 —— 今天栽过"字段写了没被用掉"。
// D3 钉住角色清单不是硬编码的: 硬编码一份名单, 将来加一个只读角色就会漏掉它,
//   于是那个角色重演这出戏, 而这条护栏还是绿的。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { ROLES } = require(path.join(ROOT, 'agents', 'sub-agent.js'));
// 2026-10-18 拼音迁移: 判定一律走 isReadOnlyRole, 不再拿集合直接 .has()。
// 角色规范名已改成拼音 (li/xun/dui/zhen), 而 Object.keys(ROLES) 仍是历史英文名 ——
// 拿拼音集合去 has() 英文键会恒为 false, "可写角色"会被算成全部 8 个,
// D2 于是把只读角色误判成可写并报红。isReadOnlyRole 拼音/英文/卦名三种都认。
const {isReadOnlyRole, GUA_ROLES} = require(path.join(ROOT, 'agents', 'gua-identity.js'));

const RO_ARR = GUA_ROLES.filter((g) => isReadOnlyRole(g.code)).map((g) => g.code);
const MARK = '你的交付物就是这条回复本身';

test('D1 每个只读角色都必须被告知"交付物是回复本身"', () => {
  assert.ok(RO_ARR.length > 0, '只读角色清单不能是空的 —— 空了这条护栏等于没写');
  for (const role of RO_ARR) {
    const sys = (ROLES[role] && ROLES[role].system) || '';
    assert.ok(sys.includes(MARK),
      role + ' 是只读角色, 但它的 system prompt 没写"交付物就是这条回复本身" —— '
      + '现场 analyzer 就是因为这句缺失, 为了凑一个它写不出来的"产出文件路径", '
      + '跑了 20 次工具调用 / 14 轮');
  }
});

test('D2 写盘角色不许被这段话污染 —— executor 能写盘, 不能被劝成"别写"', () => {
  const writable = Object.keys(ROLES).filter((r) => !isReadOnlyRole(r));
  assert.ok(writable.length > 0, '可写角色清单不能是空的');
  for (const role of writable) {
    const sys = (ROLES[role] && ROLES[role].system) || '';
    assert.ok(!sys.includes(MARK),
      role + ' 是可写角色, 却收到了只读角色的交付物说明 —— '
      + '"产出 > 报告"对 executor 本来就是对的, 被误劝成"不要写文件"是反向事故');
  }
});

test('D3 角色清单必须取自 action_policy 唯一真源, 不许硬编码', () => {
  const src = fs.readFileSync(path.join(ROOT, 'agents', 'sub-agent.js'), 'utf8');
  // 先剥注释再扫 —— 今天第三次栽在"断言扫到自己的注释"上: 这段逻辑的注释里
  // 正好举了 ['analyzer','checker','bug_hunter','reflector'] 当**反例**,
  // 裸扫源码会把它当成真硬编码而报红。仓库既有先例见 dispatcher-gate 护栏的 kws()。
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  // 2026-10-18: 真源从 action_policy 搬到 agents/gua-identity.js (零依赖叶子模块,
  // 因为 action_policy 与 sub-agent 互相 require 会成环, 而环的表现是守卫静默失效)。
  // 护栏的**意图**不变 —— 名单必须来自单一真源, 不许在这里手写。所以认这两个符号,
  // 但下面"不许硬编码"那条断言照样执行, 强度没降。
  const cat = code.indexOf('READ_ONLY_CODES');
  assert.ok(cat > 0, '要能找到只读角色追加逻辑');
  const block = code.slice(cat, cat + 500);
  assert.ok(block.includes('READ_ONLY_CODES'),
    'D3: 追加逻辑必须取自 gua-identity.READ_ONLY_CODES (单一真源)');
  // 硬编码一份 ['analyzer','checker','bug_hunter','reflector'] = 加新只读角色时静默漏掉
  assert.ok(!/analyzer.*,.*checker.*,.*bug_hunter/.test(block),
    'D3: 不许硬编码只读角色名单 —— 加新角色时会静默漏掉, 那个角色重演现场那出戏');
});

test('D4 planner 必须知道只读角色接不了写盘的活', () => {
  // 死结的另一头。光改 worker 不改 planner, 下一个任务还会被派成"必须落盘"。
  // 2026-10-18 拼音统一: ROLES 的键从 planner 变成 kan。
  const p = (ROLES.kan && ROLES.kan.system) || '';
  assert.ok(p.includes('不许要求写盘'),
    'D4: planner 的拆解规则里必须明确只读角色不许接写盘活 —— '
    + '现场 planner 把"必须给出产出文件路径"派给了写不了文件的 analyzer, '
    + '20 次工具调用 / 14 轮 / 75 秒就是这么来的');
  assert.ok(p.includes('kun'),
    'D4: 必须同时告诉 planner 要写盘派给 kun, 不能只堵不许写');
});

