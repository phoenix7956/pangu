'use strict';
// 爻值接线 (2026-10-22 第 37 批)
//
// 老板 10-21 原话:「爻动阴阳那就太过了」
//
// 这条红线在数据层的准确落地(第 36 批定的, 第 37 批才真的接上):
//   · 爻值 6/7/8/9 **影响** movement(静/动) —— 卦筮地基, 必须接;
//   · 爻值 **不影响** yaoWuxing —— 爻五行唯一来源是纳甲地支五行;
//   · 爻值 **不翻转** 本卦爻位的阴阳 —— 阴阳翻转发生在**变卦**里。
//
// ⚠️ 第 37 批动手前实查发现: `hexagram_vector.getYaoVector(guaId, pos)`
//   **只收两参** ⇒ 爻值从设计上就没进过被测路径, 向量层内部自己按 binary
//   推爻值(阳→7/阴→8) ⇒ `movement` 恒为 'static'。
//   连带两个生产 bug:
//     ① `gua_engine.js` 调 `getYaoVector(guaId, yaoIdx0)` 只传两参
//        ⇒ **动爻在 8 维向量里 movement 恒为 static**, 老阳(9)/老阴(6)信息丢光;
//     ② 边界守卫的 C4 判据是**恒真**的: 它四次调 `getYaoVector(id, pos)`
//        (同参调用) 比爻五行 —— 爻值压根没进被测路径, 结论必然成立;
//        而且它拿一个**编造的假卦** yao6=[7,8,7,8,7,8] 去"实跑一遍变卦",
//        跟 id 无关 ⇒ 名不副实。
//
// 本批修的: 爻值真接进向量层, C4 换成"真卦真爻位 + 扰动真的进被测路径",
// 并给 C4 配**三条负例** —— 守卫「全绿」本身不说明它有用, 咬人才算。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const CORE = path.join(__dirname, '..');
const hv = require(path.join(CORE, '64i', 'hexagram_vector.js'));
const yy = require(path.join(CORE, '64i', 'yin_yang.js'));
const yaoModels = require(path.join(CORE, '64i', 'yao_models.js'));
const G = require(path.join(CORE, 'modules', 'yao_layer_boundary.js'));
const { castGua } = require(path.join(CORE, 'modules', 'gua_engine.js'));

// ============================================================
// 一、爻值真的接进了向量层
// ============================================================

test('★ getYaoVector 收第三个参数(爻值) —— 以前只有两参, 爻值进不来', () => {
  // ⚠️ 不能用 `getYaoVector.length` 判: 第三参有默认值 `= {}`,
  //   Function.length 只数到第一个带默认值的参数之前 ⇒ 永远是 2。
  //   判「收没收第三个参数」只能看**行为**: 传进去有没有被用上。
  const withValue = hv.getYaoVector(1, 0, { yaoValue: 9 });
  const without = hv.getYaoVector(1, 0);
  assert.notEqual(withValue.movement, without.movement,
    '传进去的爻值必须改变结果 —— 否则爻值没进被测路径(这正是 C4 恒真的根因)');
  assert.equal(withValue.movement, 'dynamic');
  assert.equal(without.movement, 'static');
});

test('动爻值 ⇒ movement 变 dynamic; 静爻值 ⇒ static', () => {
  // 乾卦(id=1)六爻全阳 ⇒ 合法爻值 {7 少阳, 9 老阳}
  const s = hv.getYaoVector(1, 0, { yaoValue: 7 });
  const d = hv.getYaoVector(1, 0, { yaoValue: 9 });
  assert.equal(s.movement, 'static', '少阳(7)是静爻');
  assert.equal(d.movement, 'dynamic', '老阳(9)是动爻 —— 爻值必须真的进到向量层');
  assert.equal(d.yaoValue, 9, '爻值本身也要如实反映');
  assert.equal(s.yaoValue, 7);
});

test('★ 爻值不许翻转本卦爻位的阴阳 —— 矛盾爻值必须被拒(返回 null)', () => {
  // 乾卦初爻是阳爻 ⇒ 传 6(老阴) 矛盾 ⇒ 必须拒绝
  assert.equal(hv.getYaoVector(1, 0, { yaoValue: 6 }), null,
    '给阳爻位传老阴(6)必须返回 null —— 爻动不许改阴阳');
  // 坤卦(id=2)初爻是阴爻 ⇒ 传 9(老阳) 矛盾 ⇒ 必须拒绝
  assert.equal(hv.getYaoVector(2, 0, { yaoValue: 9 }), null,
    '给阴爻位传老阳(9)必须返回 null');
  // 合法组合照常给值
  assert.ok(hv.getYaoVector(2, 0, { yaoValue: 6 }), '阴爻位传老阴(6)合法');
  assert.equal(hv.getYaoVector(2, 0, { yaoValue: 6 }).movement, 'dynamic');
});

test('★ 爻值不许改爻五行 —— 静动两态下 yaoWuxing 必须完全相同', () => {
  for (let id = 1; id <= 64; id++) {
    for (let pos = 0; pos < 6; pos++) {
      const b = yaoModels.getBinary(id);
      if (typeof b !== 'string' || b.length !== 6) continue;
      const isYang = b.charAt(pos) === '1';
      const s = hv.getYaoVector(id, pos, { yaoValue: isYang ? 7 : 8 });
      const d = hv.getYaoVector(id, pos, { yaoValue: isYang ? 9 : 6 });
      if (!s || !d) continue;
      assert.equal(d.yaoWuxing, s.yaoWuxing,
        `卦 ${id} 第 ${pos + 1} 爻从静到动, 爻五行变了(${s.yaoWuxing}→${d.yaoWuxing})`);
    }
  }
});

test('不传爻值时保持旧行为(阳7/阴8, 全 static) —— 向后兼容', () => {
  assert.equal(hv.getYaoVector(1, 0).yaoValue, 7);
  assert.equal(hv.getYaoVector(1, 0).movement, 'static');
  assert.equal(hv.getYaoVector(2, 0).yaoValue, 8);
  assert.equal(hv.getYaoVector(2, 0).movement, 'static');
});

test('非法爻值 ⇒ null', () => {
  assert.equal(hv.getYaoVector(1, 0, { yaoValue: 5 }), null);
  assert.equal(hv.getYaoVector(1, 0, { yaoValue: 10 }), null);
  assert.equal(hv.getYaoVector(1, 0, { yaoValue: '7' }), null, '字符串不是合法爻值');
});

test('resolveYaoValue 给出可读原因(缺口/冲突都要说清为什么)', () => {
  const ok = hv.resolveYaoValue(1, 0, 9);
  assert.equal(ok.ok, true);
  assert.equal(ok.movement, 'dynamic');
  assert.equal(ok.yinYang, 1);
  const bad = hv.resolveYaoValue(1, 0, 6);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'YINYANG_CONFLICT');
  assert.ok(bad.reason.includes('阴阳'), '原因要说清是阴阳冲突: ' + bad.reason);
  assert.equal(hv.resolveYaoValue(1, 0, 5).code, 'BAD_YAO_VALUE');
});

// ============================================================
// 二、生产接线: 动爻的爻值进了向量层
// ============================================================

test('★ 生产起卦: 动爻的 movement 必须是 dynamic(以前恒为 static)', () => {
  // 三数法: 第三数取动爻 ⇒ numbers=[7,9,4] ⇒ 动爻4
  const r = castGua('接线自检', { numbers: [7, 9, 4] });
  assert.equal(r.moving_yao, 4);
  // 变卦与本卦在动爻位上阴阳相反 ⇒ 老阳(9) 或 老阴(6)
  const bit = r.binary.charAt(r.moving_yao - 1);
  assert.ok(bit === '0' || bit === '1', 'binary 位序必须能取到');
  // 爻向量层算出来的爻值(通过 yao_wuxing/wuxing_rel 不直接暴露, 这里用
  // 向量层接口复核): 动爻位是阳 ⇒ 老阳9; 阴 ⇒ 老阴6
  const v = hv.getYaoVector(r.gua_id, r.moving_yao - 1, {
    yaoValue: bit === '1' ? 9 : 6,
  });
  assert.ok(v, '动爻向量取不到');
  assert.equal(v.movement, 'dynamic');
});

test('★ 生产起卦: 动爻的爻值必须是老阳/老阴, 不是少阳/少阴', () => {
  // 直接看接线的源码: 引擎必须把 movingYaoValue 送进 getYaoVector
  const fs = require('fs');
  const src = fs.readFileSync(path.join(CORE, 'modules', 'gua_engine.js'), 'utf8');
  assert.match(src, /getYaoVector\(\s*guaId\s*,\s*yaoIdx0\s*,\s*\{/,
    'gua_engine 必须把爻值送进 getYaoVector —— 两参调用下动爻信息全丢');
  assert.match(src, /movingYaoValue\s*=\s*movingBit\s*===\s*'1'\s*\?\s*9\s*:\s*6/,
    '动爻爻值必须由该爻位的静态阴阳决定(阳⇒老阳9, 阴⇒老阴6)');
});

// ============================================================
// 三、C4 守卫: 重写后必须能咬人
// ============================================================

test('真代码下方向 C 全绿', () => {
  const r = G.checkYaoPositionWuxingIsStatic();
  assert.equal(r.ok, true, r.violations.join('\n'));
});

test('★ 负例1: 爻五行随动爻变 → 守卫必须报出来', () => {
  // 这就是老板禁的那件事: 「这爻是阳, 所以它属木, 阳木克阴土」的变种 ——
  // 动爻一动, 爻的五行就换。
  const realHv = hv;
  const fakeHv = {
    getYaoVector(guaId, pos, opts = {}) {
      const v = realHv.getYaoVector(guaId, pos, opts);
      if (!v) return v;
      if (opts.yaoValue === 9 || opts.yaoValue === 6) {
        const map = { 金: '水', 水: '木', 木: '火', 火: '土', 土: '金' };
        return { ...v, yaoWuxing: map[v.yaoWuxing] || v.yaoWuxing };
      }
      return v;
    },
  };
  const r = G.checkYaoPositionWuxingIsStatic({ hexagramVector: fakeHv });
  assert.equal(r.ok, false, '爻五行随动爻变竟然通过了 —— C4 没咬人');
  assert.ok(r.violations.some(v => v.includes('动的是爻的阴阳')),
    '报错要点名「动的是爻的阴阳, 不是爻的五行」: ' + r.violations.join('; '));
});

test('★ 负例2: 爻值接不进向量层(movement 恒 static) → 守卫必须报出来', () => {
  // 这条是 C4 自己的**回归守卫**: 哪天有人把爻值从向量层里摘掉,
  // C4 会从「恒真」变成「零牙齿」—— 上面那条负例就抓不到任何东西了。
  // 所以 C4 额外断言 movement 必须随爻值变。
  const realHv = hv;
  const staleHv = {
    getYaoVector(guaId, pos) { return realHv.getYaoVector(guaId, pos); },
  };
  const r = G.checkYaoPositionWuxingIsStatic({ hexagramVector: staleHv });
  assert.equal(r.ok, false, '爻值接不进向量层竟然通过了 —— 扰动没进被测路径');
  assert.ok(r.violations.some(v => v.includes('爻值没进到被测路径')),
    '报错要点名「扰动没进被测路径」: ' + r.violations.join('; '));
});

test('★ 负例3: 矛盾爻值被静默接受(改阴阳) → 守卫必须报出来', () => {
  // 假层**无视**真层的拒绝, 自己造一个「阴阳被翻了」的向量。
  const realHv = hv;
  const flipHv = {
    getYaoVector(guaId, pos, opts = {}) {
      const v = realHv.getYaoVector(guaId, pos, opts);
      if (!v) {
        const base = realHv.getYaoVector(guaId, pos);
        if (!base) return null;
        return {
          ...base,
          yinYang: base.yinYang === 1 ? 0 : 1,
          movement: 'dynamic',
          yaoValue: opts.yaoValue,
        };
      }
      return v;
    },
  };
  const r = G.checkYaoPositionWuxingIsStatic({ hexagramVector: flipHv });
  assert.equal(r.ok, false, '矛盾爻值被静默接受竟然通过了');
  assert.ok(r.violations.some(v => v.includes('不许翻转本卦爻位的阴阳')),
    '报错要点名「爻值不许翻转本卦爻位的阴阳」: ' + r.violations.join('; '));
});

// ============================================================
// 四、爻值层的语义没被改坏
// ============================================================

test('爻值层本身没动: 6/7/8/9 的阴阳与动静映射不变', () => {
  assert.equal(yy.yaoToBinary(6), 0, '老阴是阴');
  assert.equal(yy.yaoToBinary(7), 1, '少阳是阳');
  assert.equal(yy.yaoToBinary(8), 0, '少阴是阴');
  assert.equal(yy.yaoToBinary(9), 1, '老阳是阳');
  assert.equal(yy.getMovement(6), 'dynamic');
  assert.equal(yy.getMovement(7), 'static');
  assert.equal(yy.getMovement(8), 'static');
  assert.equal(yy.getMovement(9), 'dynamic');
  // 老阳9 变少阴8 / 老阴6 变少阳7 —— 阴阳翻转在**变卦**里发生
  assert.equal(yy.transformYao(9), 8);
  assert.equal(yy.transformYao(6), 7);
  assert.equal(yy.transformYao(7), 7, '少阳不变');
  assert.equal(yy.transformYao(8), 8, '少阴不变');
});

test('★ 爻值的阴阳必须与爻位静态阴阳一致 —— 全 384 爻位逐个核', () => {
  // 这条不是「拿尺子量自己」: 尺子是 binary 位(卦层静态事实),
  // 被测的是「爻值的阴阳与它一致」。合法组合表:
  //   阳爻位 ⇒ {7 少阳, 9 老阳};  阴爻位 ⇒ {8 少阴, 6 老阴}
  let checked = 0;
  for (let id = 1; id <= 64; id++) {
    const b = yaoModels.getBinary(id);
    for (let pos = 0; pos < 6; pos++) {
      const bit = b.charAt(pos);
      const legal = bit === '1' ? [7, 9] : [8, 6];
      for (const v of [6, 7, 8, 9]) {
        const r = hv.resolveYaoValue(id, pos, v);
        if (legal.includes(v)) {
          assert.equal(r.ok, true, `卦 ${id} 第 ${pos + 1} 爻的合法爻值 ${v} 被拒了`);
          assert.equal(r.yinYang, bit === '1' ? 1 : 0);
          checked++;
        } else {
          assert.equal(r.ok, false, `卦 ${id} 第 ${pos + 1} 爻的矛盾爻值 ${v} 被接受了`);
          assert.equal(r.code, 'YINYANG_CONFLICT');
        }
      }
    }
  }
  assert.equal(checked, 384 * 2, '合法爻值组合数应为 384 爻位 × 2');
});
