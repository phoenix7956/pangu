/**
 * 64i/tests/smoke_64gua_384yao.js
 * W4-A.2 实战 smoke test: 全 64 卦 × 6 爻 = 384 个 vector 跑通 + 关键字段校验
 *
 * 不写死"必须是什么值"(那是单元测试的事), 只检查:
 *   1. 不抛异常
 *   2. 必填字段存在
 *   3. 五行 / 八卦 / 爻位 / 六亲 是合法枚举
 *   4. 抽查 1-2 个卦的传统说法, 看是否对得上
 *
 * 期望: 384/384 全过, 0 异常
 */
'use strict';

const v = require('../hexagram_vector');
const wuxingAx = require('../bagua_annotations/wuxing_axioms');
const baguaAx = require('../bagua_annotations/bagua_axioms');
const liuQinAx = require('../bagua_annotations/liu_qin');
const najia = require('../bagua_annotations/najia');

const WUXING = ['金', '木', '水', '火', '土'];
const BAGUA_NAMES = ['乾', '兑', '离', '震', '巽', '坎', '艮', '坤'];
const LIU_QIN = ['父母', '兄弟', '子孙', '妻财', '官鬼'];

let passed = 0;
let failed = 0;
let loaded = 0;   // 装得出纳甲的爻位
let empty = 0;    // 装不出纳甲的爻位(诚实的空)
const errors = [];

function check(cond, label) {
  if (cond) { passed++; }
  else { failed++; errors.push(label); }
}

function isValidYinYang(v) { return v === 0 || v === 1; }
function isValidMovement(v) { return v === 'static' || v === 'dynamic'; }
function isValidYaoValue(v) { return [6, 7, 8, 9].includes(v); }
function isValidBagua(b) { return b && BAGUA_NAMES.includes(b.name) && WUXING.includes(b.wuxing); }
function isValidWuxing(w) { return WUXING.includes(w); }
function isValidLiuQin(l) { return LIU_QIN.includes(l); }

// ===== 1. 跑全 384 个 vector =====
// ⚠️ W4-A.2 实战发现: getYaoVector 是 0-indexed (0-5), 不是 1-indexed (1-6)
// 老板自然思考"六爻"是 1-6, 但内部 API 用 0-5
// 见 /api/pangu/animate-logo 注释: "yaoPosition must be 0-5"
// W4-A 范围: 先用 0-indexed 跑通, 报 0/1 indexed 不一致给老板拍
for (let guaId = 1; guaId <= 64; guaId++) {
  for (let yao = 0; yao < 6; yao++) {  // 0-indexed: 0=初爻, 5=上爻
    let vec;
    try {
      vec = v.getYaoVector(guaId, yao);
    } catch (e) {
      failed++; errors.push(`guaId=${guaId} yao=${yao} 抛异常: ${e.message}`);
      continue;
    }
    check(vec !== null, `guaId=${guaId} yao=${yao} vector 不为 null`);
    check(vec.guaId === guaId, `guaId 字段正确 (${guaId})`);
    check(vec.yaoPosition === yao, `yaoPosition 字段正确 (${yao})`);
    check(isValidYinYang(vec.yinYang), `yinYang 合法 (${vec.yinYang})`);
    check(isValidMovement(vec.movement), `movement 合法 (${vec.movement})`);
    check(isValidYaoValue(vec.yaoValue), `yaoValue 合法 (${vec.yaoValue})`);
    check(isValidBagua(vec.upperBagua), `upperBagua 合法 (${vec.upperBagua && vec.upperBagua.name})`);
    check(isValidBagua(vec.lowerBagua), `lowerBagua 合法 (${vec.lowerBagua && vec.lowerBagua.name})`);
    check(isValidWuxing(vec.guaWuxing), `guaWuxing 合法 (${vec.guaWuxing})`);
    // ⚠️ 第 36 批: 爻五行改用**真纳甲地支五行**, 六亲同理。
    //   纳甲是**按爻**算的(内三爻取下卦、外三爻取上卦), 真源只覆盖乾/坤两卦的地支
    //   ⇒ 当时实算 96/384 爻位装得出。所以「合法」要**逐爻**判:
    //     装得出 → 五行/六亲必须是合法枚举, 且五行必须等于纳甲地支五行
    //     装不出 → 必须是**诚实的空**(五行 ''、六亲 null), 不许拿别的东西顶
    //   以前这里无条件要求 384 个都合法 —— 那等于把「缺口伪装成结论」写成了验收标准。
    // ⚠️ 第 42 批修过期断言: 第 41 批把纳甲补齐到 8/8(384/384)之后,
    //   下面两条 `loaded===96 / empty===288` 就过期了 —— smoke 在 HEAD 上是红的。
    //   「逐爻判合法/诚实空」的分支保留(它防的正是「缺口伪装成结论」),
    //   但现在的正确期望是全量装得出: 384 / 0。
    const gz = najia.getYaoGanzhi(guaId, yao + 1);
    if (gz.ok) {
      loaded++;
      check(isValidWuxing(vec.yaoWuxing), `yaoWuxing 合法 (${vec.yaoWuxing})`);
      check(vec.yaoWuxing === gz.wuxing, `yaoWuxing 应取纳甲地支五行 (${gz.ganzhi}→${gz.wuxing})`);
      check(isValidLiuQin(vec.liuQin), `liuQin 合法 (${vec.liuQin})`);
    } else {
      empty++;
      check(vec.yaoWuxing === '', `装不出纳甲时 yaoWuxing 应为诚实空 (实得 ${vec.yaoWuxing})`);
      check(vec.liuQin === null, `装不出纳甲时 liuQin 应为 null (实得 ${vec.liuQin})`);
    }
    check(typeof vec.yaoCi === 'string' && vec.yaoCi.length > 0, `yaoCi 非空`);
  }
}
check(loaded === 384, `装得出纳甲的爻位应为 384/384 (实得 ${loaded})`);
check(empty === 0, `装不出纳甲的爻位应为 0 (实得 ${empty})`);

// ===== 2. 抽查传统说法 (3 个, 用周文王序 + 0-indexed) =====
// 乾为天 (guaId=1, 周文王序同伏羲序) - 九五之尊
{
  const wu5 = v.getYaoVector(1, 4);  // 0-indexed: 九五 = position 4
  check(wu5.yaoName === '九五', `乾卦九五名正确 (${wu5.yaoName})`);
  check(wu5.yinYang === 1, `乾卦九五阳爻正确`);
  check(wu5.positionNature === '德成', `乾卦九五位正确 (${wu5.positionNature})`);
}
// 坤为地 (周文王序 guaId=2, 0-indexed: 上六=5) - 上爻“龙战于野”
{
  const shang6 = v.getYaoVector(2, 5);  // 周文王序: guaId=2=坤
  check(shang6.yinYang === 0, `坤卦上六阴爻正确`);
  check(shang6.yaoName === '上六', `坤卦上六名正确 (${shang6.yaoName})`);
  check(shang6.positionNature === '极终', `坤卦上六位正确 (${shang6.positionNature})`);
}
// 坎为水 (周文王序 guaId=29, 0-indexed: 三爻=2) - 上下卦都是水
{
  const c3 = v.getYaoVector(29, 2);  // 周文王序坎 = guaId=29 (巧合同伏羲序)
  check(c3.upperBagua.name === '坎', `坎卦上卦名正确 (${c3.upperBagua.name})`);
  check(c3.upperBagua.wuxing === '水', `坎卦上卦五行为水 (${c3.upperBagua.wuxing})`);
  check(c3.lowerBagua.name === '坎', `坎卦下卦名正确`);
}

// ===== 3. 5×5 关系矩阵 抽查 =====
// 金生水, 金克木, 火克金, 土生金, 木克土
{
  check(wuxingAx.getRelation('金', '水') === 'sheng', `金→水 = sheng`);
  check(wuxingAx.getRelation('金', '木') === 'ke', `金→木 = ke`);
  check(wuxingAx.getRelation('火', '金') === 'ke', `火→金 = ke (火克金)`);
  check(wuxingAx.getRelation('土', '金') === 'sheng', `土→金 = sheng (土生金)`);
  check(wuxingAx.getRelation('木', '土') === 'ke', `木→土 = ke (木克土)`);
  check(wuxingAx.getRelation('金', '金') === 'tong', `金→金 = tong`);
  // 25 格应填满 5 类各 5 格(tong/sheng/ke/bei_sheng/bei_ke), **不该有 unknown**。
  //
  // ⚠️ 这两条原本断言 'unknown', 是**过时的旧契约** —— 那一版矩阵只填 tong/sheng/ke,
  //   其余 10 格兜底成 unknown, 于是"反向的两条边"被判成"无关系"。
  //   实际上反向边有明确名字: getRelation(主方, 对方) 返回**对方对主方**的角色。
  //   2026-10-21 实查: 这两个失败在本次改动**之前**就在(4624 通过/2 失败),
  //   属于基线坏了没人修 —— 按踩坑日志的规矩「基线坏了就当场修」, 在这里收掉。
  //   (P0-2「25 格留不成立态」是另一回事, 由 wuxing_strength 逐格层管, 不是矩阵本身。)
  check(wuxingAx.getRelation('金', '火') === 'bei_ke', `金→火 = bei_ke (火 克 我, 火是金的"克")`);
  check(wuxingAx.getRelation('水', '金') === 'bei_sheng', `水→金 = bei_sheng (金 生 我, 金是水的"生")`);
  // 兜底: 25 格分布必须是 5/5/5/5/5, 出现 unknown 就是矩阵退化了
  {
    const cnt = {};
    for (const a of ['金', '木', '水', '火', '土']) {
      for (const b of ['金', '木', '水', '火', '土']) {
        const r = wuxingAx.getRelation(a, b);
        cnt[r] = (cnt[r] || 0) + 1;
      }
    }
    check(!cnt.unknown, `25 格不该出现 unknown (实得 ${JSON.stringify(cnt)})`);
    for (const k of ['tong', 'sheng', 'ke', 'bei_sheng', 'bei_ke']) {
      check(cnt[k] === 5, `${k} 应占 5 格, 实得 ${cnt[k] || 0}`);
    }
  }
}

// ===== 4. liu_qin 抽查 =====
// 乾为天, 京房乾宫属金。乾纳甲 = 内甲(子寅辰) + 外壬(午申戌)
//   九五(idx4) 纳壬申, 申=金 ⇒ 与宫同五行 ⇒ 兄弟
// 真源: 「乾六爻自初爻至上面爻之爻辰为『子寅辰午申戌』」(<course-source>·八字神煞大全 阳德条)
{
  const wu5 = v.getYaoVector(1, 4);
  check(wu5.yaoWuxing === '金', `乾九五纳壬申, 申金 (${wu5.yaoWuxing})`);
  check(wu5.liuQin === '兄弟', `乾九五 = 兄弟 (申金与乾宫同为金) (${wu5.liuQin})`);
}

// ===== 汇总 =====
console.log('========================================');
console.log('  W4-A.2: 64 卦 × 6 爻 = 384 vector smoke');
console.log('========================================');
console.log(`通过: ${passed}`);
console.log(`失败: ${failed}`);
if (failed > 0) {
  console.log('\n失败项:');
  errors.slice(0, 20).forEach(e => console.log('  ❌ ' + e));
  if (errors.length > 20) console.log(`  ... 还有 ${errors.length - 20} 项`);
  process.exit(1);
}
console.log('🎯 384 vector smoke + 抽查全过!');
process.exit(0);
