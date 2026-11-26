'use strict';
/**
 * tools-schema-runtime-guard-20261025.test.js —— 第 97 批配套: 运行时判据的**变异体检**
 *
 * 起因 (第 97 批踩到的):
 *   tools_schema.js 拆成门面 + 十三个家族文件后, 有几条旧守卫**按源码文本**扫描
 *   (fs.readFileSync(tools_schema.js) + 正则), 于是:
 *     · tool-contract-regression: 「stock_resolve 必须注册进 schema」—— 拆出去后门面里没有那个文本了
 *     · bazi-gender-direction: 「schema 里能找到 gender 的描述」—— 同上
 *     · gua-fact-lookup: 「hexagram_lookup 的描述里写着卦序 1..64」—— 同上
 *   这几条守卫的**意图**都是「注册表里真的有那个东西」, 只是用源码文本当透镜。
 *   源码文本透镜有两个弱点: (a) 拆一挪就失效; (b) 正则可能跨工具边界抓到**别的**条目。
 *   ⇒ 判据换成**运行时注册表** (更强), 工具实现侧的源码扫描改成读**全部**工具源文件 (不漏不弱)。
 *
 * 本文件的任务: 证明换过去的运行时判据**会咬** —— 不是空枪。
 * 三发变异:
 *   M1 把 hexagram_lookup 描述里的「卦序 1..64」改成「卦序 0..63」 ⇒ 卦序守卫必须报红
 *   M2 把 bazi_calc 的 gender 描述里的「男」删掉 ⇒ gender 守卫必须报红
 *   M3 把 stock_resolve 从家族文件里删掉 ⇒ 注册守卫必须报红
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP = path.join(__dirname, '..');
const MODULES = path.join(APP, 'modules');

function copyApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-rtguard-'));
  fs.cpSync(MODULES, path.join(root, 'modules'), { recursive: true });
  fs.cpSync(path.join(APP, 'agents'), path.join(root, 'agents'), { recursive: true });
  return root;
}

function schemaOf(root) {
  for (const k of Object.keys(require.cache)) {
    if (k.indexOf(root) === 0) delete require.cache[k];
  }
  return require(path.join(root, 'modules', 'tools_schema.js')).TOOLS_SCHEMA;
}

function patchFamily(root, file, from, to) {
  const p = path.join(root, 'modules', 'tools_schema', file);
  const src = fs.readFileSync(p, 'utf8');
  assert.ok(src.includes(from), `变异目标没找到 (${file} 里没有 ${JSON.stringify(from)})`);
  fs.writeFileSync(p, src.replace(from, to), 'utf8');
}

// ---- 三条运行时判据 (跟换过去的那几条旧守卫一一对应) ------------------------

function guaOrderOk(S) {
  const d = String((S.hexagram_lookup || {}).function?.description || '');
  return d.includes('卦序 1..64') && d.includes('不要搜网') && d.includes('第一个动作');
}

function genderOk(S) {
  let checked = 0;
  for (const def of Object.values(S)) {
    const props = def && def.function && def.function.parameters && def.function.parameters.properties;
    if (!props || !props.gender) continue;
    checked++;
    if (!/男/.test(String(props.gender.description || ''))) return false;
  }
  return checked > 0;
}

function stockRegistered(S) {
  const d = S.stock_resolve;
  return !!d && !!d.function && d.function.name === 'stock_resolve';
}

test('M1: 把卦序改成 0..63 ⇒ 卦序守卫必须报红', () => {
  const root = copyApp();
  try {
    patchFamily(root, 'gua_trend.js', '卦序 1..64', '卦序 0..63');
    assert.ok(!guaOrderOk(schemaOf(root)), '变异体没被卦序守卫抓到 ⇒ 判据是空枪');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('M2: 把 bazi_calc 的 gender 描述里「男」删掉 ⇒ gender 守卫必须报红', () => {
  const root = copyApp();
  try {
    patchFamily(root, 'divination.js', '接受 男/女', '接受 MALE/FEMALE');
    assert.ok(!genderOk(schemaOf(root)), '变异体没被 gender 守卫抓到 ⇒ 判据是空枪');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('M3: 把 stock_resolve 从家族文件里删掉 ⇒ 注册守卫必须报红', () => {
  const root = copyApp();
  try {
    const p = path.join(root, 'modules', 'tools_schema', 'ops_workflow.js');
    const src = fs.readFileSync(p, 'utf8');
    const i = src.indexOf('stock_resolve: {');
    assert.ok(i > 0, '没找到 stock_resolve 的定义位置');
    // 从它的键开始删到配对的收尾 (schema 块是 { type:..., function:{...} }, 用缩进定位)
    const lines = src.split('\n');
    const start = lines.findIndex(l => l.includes('stock_resolve: {'));
    let end = start;
    let depth = 0;
    for (let k = start; k < lines.length; k++) {
      depth += (lines[k].match(/\{/g) || []).length;
      depth -= (lines[k].match(/\}/g) || []).length;
      if (depth <= 0 && k > start) { end = k; break; }
    }
    assert.ok(end > start, '没定位到 stock_resolve 块的结尾');
    lines.splice(start, end - start + 1);
    fs.writeFileSync(p, lines.join('\n'), 'utf8');
    assert.ok(!stockRegistered(schemaOf(root)), '变异体没被注册守卫抓到 ⇒ 判据是空枪');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- 基线: 未变异时, 三条判据都必须是「真」 -------------------------------

test('基线: 未变异的注册表三条判据都为真 (否则上面的变异体检没意义)', () => {
  const S = require(path.join(MODULES, 'tools_schema.js')).TOOLS_SCHEMA;
  assert.ok(guaOrderOk(S), '卦序判据在基线上就不成立');
  assert.ok(genderOk(S), 'gender 判据在基线上就不成立');
  assert.ok(stockRegistered(S), 'stock_resolve 注册判据在基线上就不成立');
});
