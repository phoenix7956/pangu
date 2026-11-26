'use strict';
// 大运顺逆方向 —— 性别认不出来时**静默当成女命** (2026-10-22, E2E 实跑撞出)
//
// 现场一字不差: 主人说「1987年11月20日早上7点出生，**男**」,
// 任务简报里也写着「男」, 但 bazi_calc.py 里写的是
//     is_yang_gender = (gender == 'male')      ← 只认英文字面量
// 于是 '男' ≠ 'male' → **当成女命** → 丁卯(阴年)女命顺排。
//
// 而正确的是**阴年男命逆排**。于是整张盘的大运方向、起运岁数、10 步干支全反,
// 而且**一声不吭**: 没有报错, 没有警告, 返回的是一份看起来完全正常的排盘。
//
// 这属于「取值错了不抛异常, 只是安静地返回另一个东西」那一族 ——
// 与 64卦 0..63 那条同形, 与 hexagram_lookup 白名单漏了同形, 与
// countElements 传数组静默返回全 0 同形。**盘古这一族坑全是同一个形状。**

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const CORE = path.join(__dirname, '..');

// 丁卯年 = 阴年。主流派: 阳男阴女顺排, 阴男阳女逆排。
// 所以这个日子: 男 → 逆排, 女 → 顺排。两者必须能分开。
const CHART = { year: 1987, month: 11, day: 20, hour: 7 };

async function dayunFor(gender) {
  const { TOOLS } = require(path.join(CORE, 'modules', 'tools'));
  const r = await TOOLS.bazi_calc({ params: { ...CHART, gender } });
  assert.ok(r && r.ok, 'bazi_calc 调用失败: ' + JSON.stringify(r).slice(0, 200));
  const d = (r.data && r.data.pillars) || {};
  return { dayun: d.dayun || {}, pillars: d.pillars || {} };
}

test('前提: 这个日子是阴年丁卯, 年干丁 = 阴', async () => {
  const { pillars } = await dayunFor('男');
  assert.ok(pillars['年柱'] && pillars['年柱'][0] === '丁', '年柱应为丁卯, 实为 ' + pillars['年柱']);
});

test('男 与 女 的顺逆方向必须不同 (这是本条测试的全部意义)', async () => {
  const m = await dayunFor('男');
  const f = await dayunFor('女');
  assert.equal(m.dayun['排法'], '逆排', '阴年男命应逆排, 实为 ' + m.dayun['排法']);
  assert.equal(f.dayun['排法'], '顺排', '阴年女命应顺排, 实为 ' + f.dayun['排法']);
});

test('中文「男」和英文 male 必须得到**同一个**盘 (原来只有 male 对)', async () => {
  const cn = await dayunFor('男');
  const en = await dayunFor('male');
  assert.deepStrictEqual(cn.dayun, en.dayun,
    '同一个性别两种写法算出不同的大运 → 大运方向取决于写法, 不取决于命主');
});

test('各种人话写法都归到同一个性别', async () => {
  const male = await dayunFor('男');
  for (const g of ['男性', '男命', '乾', 'male', 'M', 'm', 'man', '男 ']) {
    const r = await dayunFor(g);
    assert.equal(r.dayun['排法'], male.dayun['排法'], '写法 ' + JSON.stringify(g) + ' 应与「男」一致');
  }
  const female = await dayunFor('女');
  for (const g of ['女性', '女命', '坤', 'female', 'F', 'woman']) {
    const r = await dayunFor(g);
    assert.equal(r.dayun['排法'], female.dayun['排法'], '写法 ' + JSON.stringify(g) + ' 应与「女」一致');
  }
});

test('boolean / 数字写法也认 (true=男, 1=男, 0=女)', async () => {
  assert.equal((await dayunFor(true)).dayun['排法'], '逆排');
  assert.equal((await dayunFor(1)).dayun['排法'], '逆排');
  assert.equal((await dayunFor(0)).dayun['排法'], '顺排');
  assert.equal((await dayunFor(false)).dayun['排法'], '顺排');
});

test('认不出来的性别**不许猜** —— 报未知, 大运列表留空', async () => {
  // 这是本次修法的关键: 旧行为是"猜成女命, 照样给一份满列表"。
  // 空列表是诚实的 —— 上游看到空知道这步没做;
  // 看到一个方向相反的满列表, 会当成真盘去解读。
  for (const g of [undefined, '', '不知道', null, 'other', 7]) {
    const { dayun } = await dayunFor(g);
    assert.match(String(dayun['排法']), /未知/,
      JSON.stringify(g) + ' 应报未知, 实为 ' + dayun['排法']);
    assert.deepStrictEqual(dayun['列表'], [],
      JSON.stringify(g) + ' 的大运列表应为空, 实为 ' + JSON.stringify(dayun['列表']).slice(0, 80));
    assert.equal(dayun['起运岁数'], null, JSON.stringify(g) + ' 起运岁数应为 null');
  }
});

test('边界: 不知道性别 ≠ 性别判错 —— 前者说"不知道", 后者给错答案', async () => {
  const unknown = await dayunFor(undefined);
  const male = await dayunFor('男');
  // 前者的列表是空的, 后者有 10 步。两者不能长得一样。
  assert.notStrictEqual(unknown.dayun['列表'].length, male.dayun['列表'].length);
  assert.equal(male.dayun['列表'].length, 10, '性别已知时该给满 10 步');
});

test('边界: 归一化只有一个地方做, python 不再自己认第二遍', () => {
  const py = fs.readFileSync(path.join(CORE, 'modules', 'tools', 'bazi', 'bazi_calc.py'), 'utf8');
  // 「gender == 'male'」本身不算错 —— 它现在被 _gender_known 守着, 是对的。
  // 要锁的是**结构**: 判断必须发生在 _gender_known 之内, 而不是无条件的 else 兜底。
  assert.match(py, /_gender_known\s*=\s*\(gender == 'male' or gender == 'female'\)/,
    'python 必须显式知道"性别认出来了没有"');
  const knownAt = py.indexOf('_gender_known = ');
  const useAt = py.indexOf('if _gender_known:');
  assert.ok(knownAt >= 0 && useAt > knownAt,
    '_gender_known 必须在使用前就确定');
  // 输出不许再自己重新判一次顺逆(那是"同一义两份"的漂移源)
  assert.match(py, /'排法':\s*_paifang/,
    '输出必须用算好的 _paifang, 不许在输出处再写一遍三元');
  assert.doesNotMatch(py, /'排法':\s*'顺排' if shun else '逆排'/,
    '输出处又出现了一次独立的顺逆判断 —— 两处必漂');
});

test('边界: 工具描述要说清接受哪些写法, 别让模型猜', () => {
  // 2026-10-25 (第 97 批): 改成读**运行时注册表** —— 原来按源码文本正则找第一个 gender,
  //   拆成家族文件后既可能找不到, 也可能匹配到**别的工具**的 gender。
  //   运行时读法更准: 谁有 gender 这个参数, 就查谁的描述。
  //   而且比原来**更强**: 原来只查第一个, 现在 bazi_calc 和 fengshui_calc 两个都查。
  const TOOLS_SCHEMA = require(path.join(CORE, 'modules', 'tools_schema')).TOOLS_SCHEMA;
  let checked = 0;
  for (const [tool, def] of Object.entries(TOOLS_SCHEMA)) {
    const props = def && def.function && def.function.parameters && def.function.parameters.properties;
    if (!props || !props.gender) continue;
    checked++;
    assert.equal(props.gender.type, 'string', `${tool}.gender 的类型该是 string`);
    assert.match(String(props.gender.description || ''), /男/,
      `${tool}.gender 的描述里必须写明接受「男/女」—— 只写 male/female 正是模型和人传错值的诱因`);
  }
  assert.ok(checked > 0, '一个带 gender 参数的工具都没找到 —— 这条守卫会变成空枪');
});
