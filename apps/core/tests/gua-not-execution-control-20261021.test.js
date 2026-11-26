'use strict';
// P1-5 守卫 —— 卦回答「说什么」, 不回答「调什么」 (2026-10-21)
//
// 这批测试守的是**架构边界**, 不是某个函数的行为。
// 起因: `symbol_table.js` 的 `skill_execution` 域有 166 个信号, 把 64 卦
// 映射到 17 个**执行类**工具(exec_command / write_file / permission_grant …),
// `skill_runtime.js` 再用它给 skill 排序加权。
// 那等于: 主人起了一卦, 于是「被克」从 35 变成更多次 exec_command。
// **术数一旦进了执行控制, 它就不再是术数, 是随机权重。**
//
// ⚠️ 关键背景 (已查证, 别再查一遍):
//   这条链在 2026-10-21 之前就已经**没人调用**了 ——
//   matchSkills / resolveToolByGua / executeByGua / autoRegisterTools
//   / getSkillByGua / _resolveSignalForTool 全仓库(含 desktop)零调用点,
//   且没有任何测试依赖 skill_runtime.js。
//   活的 skill 路径是 `modules/tools/skill_use.js`, 按**名字**读磁盘 SKILL.md,
//   与卦象无关。所以本批是**摘掉一条已死的耦合**, 不是改一个在跑的行为 ——
//   风险低; 但正因为它安静, 才更需要护栏。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CORE = path.join(__dirname, '..');
const SR = require(path.join(CORE, 'modules', 'skill_runtime.js'));
const SR_FILE = path.join(CORE, 'modules', 'skill_runtime.js');
const src = fs.readFileSync(SR_FILE, 'utf8');

const newRT = () => SR.createSkillRuntime({ skillsDir: path.join(__dirname, '__no_such_skills_dir__') });

/** 造一个只按触发词命中的 skill, guaId 可变 */
function seedSkill(rt, name, guaId) {
  rt._skills.set(name, {
    name, guaId, tools: [],
    loaded: true,   // getAllSkills() 会 filter(s.loaded), 漏了它候选恒空
    triggers: ['测一测'], guaMeaning: '', matches: () => true,
  });
}

// ============================================================
test('P1-5: matchSkills 不再用卦加权', () => {
  const rt = newRT();
  // 两个触发词完全相同、只有 guaId 不同。
  // 卦还加权的话分数会差 20 —— 差 0 才说明摘干净了。
  rt._skills = new Map();
  seedSkill(rt, 's1', 24);
  seedSkill(rt, 's2', 64);
  rt._loaded = true;

  const a = rt.matchSkills('测一测', { guaId: 24 });
  const b = rt.matchSkills('测一测', { guaId: 64 });
  assert.ok(a.length && b.length, '候选不该为空');
  assert.equal(a[0].score, b[0].score,
    '卦号不同但分数不同 → 卦还在影响排序 (P1-5 没摘干净)');
});

test('P1-5: 理由里可以留痕, 但不许改分数', () => {
  const rt = newRT();
  rt._skills = new Map();
  seedSkill(rt, 's1', 24);
  rt._loaded = true;
  const r = rt.matchSkills('测一测', { guaId: 24 })[0];
  const reason = r.reasons.join(' | ');
  assert.match(reason, /已摘除/, '应该留一条痕, 说明卦被有意摘掉了');
  assert.match(reason, /不再影响排序/, '留痕要说清是不生效');
  assert.equal(typeof r.score, 'number');
});

// ============================================================
test('P1-5: executeByGua 退役, 且不执行任何东西', async () => {
  const rt = newRT();
  const r = await rt.executeByGua(24);
  assert.equal(r.ok, false, '卦号不许直接顶到 skill 执行');
  assert.equal(r.error.code, 'GUA_EXEC_RETIRED');
  assert.match(r.error.message, /P1-5/);
  assert.equal(r.error.guaId, 24, '回执里要带上出事的卦号, 方便定位');
});

test('P1-5: resolveToolByGua 退役, 永远不给工具名', () => {
  const rt = newRT();
  for (const guaId of [1, 24, 64]) {
    const r = rt.resolveToolByGua(guaId);
    assert.equal(r.tool, null, '卦 ' + guaId + ' 不该解析出工具');
    assert.equal(r.signal, null);
    assert.equal(r.retired, true);
    assert.match(r.message, /P1-5/);
  }
});

test('P1-5: autoRegisterTools 是 no-op, 一个工具都不注册', () => {
  const rt = newRT();
  const ST = require(path.join(CORE, '64i', 'symbol_table.js'));
  const before = Object.keys(rt.tools).length;
  const n = rt.autoRegisterTools(ST);
  assert.equal(n, 0, '注册数量必须为 0');
  assert.equal(Object.keys(rt.tools).length, before, 'this.tools 不许被动过');
});

test('P1-5: 两个查表函数改成响亮报错(不是静默返回空)', () => {
  const rt = newRT();
  assert.throws(() => rt._resolveToolSignalsForGua(24), /P1-5 已退役/);
  assert.throws(() => rt._resolveSignalForTool('exec_command', 24), /P1-5 已退役/);
});

// ============================================================
test('P1-5: 装时自检通过(当前源码没有违规)', () => {
  assert.doesNotThrow(() => SR._assertNoGuaToExecutionCoupling());
});

/** 自检判据本身的实现 —— 与 _assertNoGuaToExecutionCoupling 保持同一条 */
function scanGuaToScore(text) {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const lines = code.split('\n').map(l => l.replace(/\/\/.*$/, ''));
  for (let i = 0; i < lines.length; i++) {
    if (!/if\s*\(\s*guaId\b/.test(lines[i])) continue;
    if (/score\s*\+=/.test(lines.slice(i, i + 12).join('\n'))) return true;
  }
  return false;
}

test('P1-5: 自检的判据本身有效 —— 注入卦加权必须被抓', () => {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(scanGuaToScore(code), false, '原文件不该被判违规');
  const injected = code.split('\n');
  injected.splice(490, 0, '      if (guaId) {', '        score += 20;  // 注入的卦加权');
  assert.equal(scanGuaToScore(injected.join('\n')), true,
    '注入了卦加权却没抓到 → 判据是空的, 等于没有护栏');
});

test('P1-5: 自检会剥注释 —— 否则它会把自己判成违规', () => {
  // 2026-10-21 实测踩到: 判据自己的注释里写着 `if (guaId` 和 `score +=`,
  // 不剥注释就直接 require 崩。这个行为必须钉住。
  const withComment = [
    '// 规则: 下面这种形态是违规的 → if (guaId) { score += 20 }',
    'function f(guaId, score) {',
    '  return score;',
    '}',
  ].join('\n');
  assert.equal(scanGuaToScore(withComment), false,
    '注释里的内容被判成违规了');
});

test('P1-5: 自检的上限是 12 行窗口 —— 如实钉住, 免得以为它是锁', () => {
  // 护栏不是锁: 垫超过 12 行它就抓不到。这条测试把这个事实写死,
  // 将来有人想扩大覆盖时, 会先看到它而不是以为自己已经万无一失。
  const code = fs.readFileSync(SR_FILE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const far = code.split('\n');
  far.splice(490, 0, '      if (guaId) {');
  for (let k = 0; k < 14; k++) far.splice(491, 0, '        // 填充行');
  far.splice(505, 0, '        score += 20;');
  assert.equal(scanGuaToScore(far.join('\n')), false,
    '垫 14 行后判据确实抓不到 —— 这是已知上限, 不是 bug');
});

// ============================================================
test('P1-5: 边界仍在别处 —— 卦该管的地方没被误伤', () => {
  // 这次只摘「卦 → 调什么」。卦 → 说什么(谋断)、卦 → 排盘、卦 → 断爻
  // 一处都不该动。这里钉住「别顺手把别的也删了」。
  assert.ok(src.includes('getSkillByGua'), 'getSkillByGua 是查表不是执行, 该留着');
  assert.ok(src.includes('getYaoContext'), '爻层上下文与本条无关, 该留着');
  assert.ok(src.includes('bindBaguaAnnotations'), '五行注解绑定与本条无关, 该留着');
});

test('P1-5: 符号表本身不动 —— 只是没人再拿它选工具了', () => {
  const ST = require(path.join(CORE, '64i', 'symbol_table.js'));
  const sigs = ST.getSignalsByDomain('skill_execution');
  assert.ok(sigs.length > 100, '信号空间还在 (' + sigs.length + ' 个)');
  // 关键: 表还在, 但**已无人用它决定调什么**。
  // 删表不如断引用 —— 表是术数知识, 引用才是执行控制。
  assert.ok(/autoRegisterTools[\s\S]{0,400}return 0;/.test(src),
    'autoRegisterTools 必须是 no-op');
  assert.ok(/executeByGua[\s\S]{0,600}GUA_EXEC_RETIRED/.test(src),
    'executeByGua 必须返回退役码');
});
