/**
 * Pangu · 64i Layer
 * bagua_annotations/tests/test_liu_qin.js
 *
 * liu_qin.js 单元测试
 * 8 组: 标签完整性 / API 形态 / 8卦6爻全正确 / 传统案例 /
 *       5五行各自序列 / 边界处理 / 全64卦扫描 / 算法原理
 *
 * 运行：node bagua_annotations/tests/test_liu_qin.js
 */

'use strict';

const path = require('path');
const {
  LIU_QIN_LABELS,
  computeLiuQin,
  computeLiuQinForGua,
} = require(path.join(__dirname, '..', 'liu_qin'));
const wuxingMap = require(path.join(__dirname, '..', 'wuxing_map'));

// ============================================================
// 测试工具
// ============================================================

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ ${msg}`);
    failed++;
  }
}

function section(name) {
  console.log(`\n【${name}】`);
}

// ============================================================
// 主测试流程
// ============================================================

function run() {
  console.log('='.repeat(60));
  console.log('Pangu · liu_qin 单元测试 (8 组)');
  console.log('='.repeat(60));

  const VALID = new Set(LIU_QIN_LABELS);

  // ---- 1. 标签完整性 ----
  section('1. LIU_QIN_LABELS - 5 标签齐全');
  assert(Array.isArray(LIU_QIN_LABELS), 'LIU_QIN_LABELS 是数组');
  assert(LIU_QIN_LABELS.length === 5, `LIU_QIN_LABELS.length === 5（实际：${LIU_QIN_LABELS.length}）`);
  for (const label of ['父母', '兄弟', '子孙', '妻财', '官鬼']) {
    assert(LIU_QIN_LABELS.includes(label), `LIU_QIN_LABELS 包含 "${label}"`);
  }
  assert(Object.isFrozen(LIU_QIN_LABELS), 'LIU_QIN_LABELS 是 frozen (防外部篡改)');

  // ---- 2. API 形态 ----
  section('2. API 形态 - 返回类型与字段');
  assert(typeof computeLiuQin === 'function', 'computeLiuQin 是 function');
  assert(typeof computeLiuQinForGua === 'function', 'computeLiuQinForGua 是 function');

  const r1 = computeLiuQin(1, 0);
  assert(typeof r1 === 'string', `computeLiuQin(1, 0) 返回 string（实际：${typeof r1}）`);
  assert(VALID.has(r1), `computeLiuQin(1, 0) 值在 5 标签集内（实际：${r1}）`);

  const r2 = computeLiuQinForGua(1);
  assert(Array.isArray(r2), 'computeLiuQinForGua(1) 返回 Array');
  assert(r2.length === 6, `computeLiuQinForGua(1).length === 6（实际：${r2.length}）`);
  assert('yaoPosition' in r2[0], '元素有 yaoPosition 字段');
  assert('yaoWuxing' in r2[0], '元素有 yaoWuxing 字段');
  assert('guaWuxing' in r2[0], '元素有 guaWuxing 字段');
  assert('liuQin' in r2[0], '元素有 liuQin 字段');
  // 字段值类型
  assert(typeof r2[0].yaoPosition === 'number', 'yaoPosition 是 number');
  assert(typeof r2[0].yaoWuxing === 'string', 'yaoWuxing 是 string');
  assert(typeof r2[0].guaWuxing === 'string', 'guaWuxing 是 string');
  // ⚠️ 第 36 批: 「他」侧改用**该爻的纳甲地支五行**, 而纳甲地支真源只覆盖乾/坤两卦。
  //   所以 liuQin 的类型是 `string|null` —— 装不出纳甲的爻位是 **null + reason**,
  //   不是「拿别的东西顶」。以前这里断言「必须是 string」, 等于把
  //   「缺口伪装成结论」写成了 API 契约, 谁来实现都得编一个出来。
  assert(r2[0].liuQin === null || typeof r2[0].liuQin === 'string',
    `liuQin 是 string 或 null（实际：${typeof r2[0].liuQin}）`);
  assert('ganzhi' in r2[0], '元素有 ganzhi 字段(纳甲干支)');
  assert('reason' in r2[0], '元素有 reason 字段(缺口原因)');

  // ---- 3. 8 卦各 6 爻 = 48 爻 (全六亲正确) ----
  section('3. 8 卦各 6 爻 = 48 爻 - 每爻六亲都是有效标签');
  // 一宫一卦, 覆盖全部 5 五行
  const EIGHT_GUAS = [
    { id: 1,  bagong: '乾' }, // 乾宫本宫 金
    { id: 58, bagong: '兑' }, // 兑宫本宫 金
    { id: 30, bagong: '离' }, // 离宫本宫 火
    { id: 57, bagong: '巽' }, // 巽宫本宫 木
    { id: 51, bagong: '震' }, // 震宫本宫 木
    { id: 29, bagong: '坎' }, // 坎宫本宫 水
    { id: 52, bagong: '艮' }, // 艮宫本宫 土
    { id: 2,  bagong: '坤' }, // 坤宫本宫 土
  ];
  const seenLabels = new Set();
  for (const { id, bagong } of EIGHT_GUAS) {
    const arr = computeLiuQinForGua(id);
    assert(arr !== null, `guaId=${id} (${bagong}宫 ${wuxingMap.getWuxing(id).wuxing}) 返回非 null`);
    if (arr) {
      for (const item of arr) {
        if (item.liuQin === null) {
          // 「诚实的空」: 必须带原因, 干支/爻五行一并空
          assert(item.yaoWuxing === null, `guaId=${id} pos=${item.yaoPosition} 六亲空则爻五行也须空`);
          assert(item.ganzhi === null, `guaId=${id} pos=${item.yaoPosition} 六亲空则干支也须空`);
          assert(item.reason && item.reason.length > 5, `guaId=${id} pos=${item.yaoPosition} 缺口必须带原因`);
          continue;
        }
        assert(VALID.has(item.liuQin), `guaId=${id} pos=${item.yaoPosition} (yaoWuxing=${item.yaoWuxing}) → ${item.liuQin} ∈ 5 标签集`);
        seenLabels.add(item.liuQin);
      }
    }
  }
  // 5 标签都应出现在**装得出纳甲**的那些爻位上。
  //   八宫本宫卦里只有乾(1)、坤(2) 的六爻地支有真源 —— 其余六个一个都装不出。
  //   旧版这里要求「48 爻中 5 标签都出现」, 那等于逼着下一个人去编:
  //   真源缺失被写成了验收失败。
  assert(seenLabels.has('父母') && seenLabels.has('兄弟') && seenLabels.has('子孙')
    && seenLabels.has('妻财') && seenLabels.has('官鬼'),
    `装得出纳甲的爻位上 5 标签都出现（实见：${[...seenLabels].join('/')}）`);
  // 反向: 第 41 批补齐八卦地支后, 原先「装不出」的六个宫本宫卦
  //   (震51/坎29/艮52/巽57/离30/兑58) 现在**都装得出**了 ⇒ 这条断言
  //   从「必须全 null」翻转成「必须全算得出, 且与纳甲地支五行逐爻对得上」。
  //   ⚠️ 翻转的理由: 判据该钉的是**性质**不是**某个缺口**。
  //     「缺口处不许编」这条性质没有消失, 只是它在真实数据上走不到了 ——
  //     所以下面第 8 组用**注入一张挖空的纳甲表**把它单独验回来。
  for (const id of [58, 30, 57, 51, 29, 52]) {
    const arr = computeLiuQinForGua(id);
    assert(arr.every(x => VALID.has(x.liuQin) && x.yaoWuxing && x.ganzhi && x.reason === null),
      `guaId=${id} 补齐地支后六爻都该算得出六亲, 且不该挂缺口理由`);
  }
  for (const label of LIU_QIN_LABELS) {
    assert(seenLabels.has(label), `装得出纳甲的爻位上出现 "${label}"`);
  }

  // ---- 4. 传统案例: 乾为天 (guaId=1, 卦五行=金) ----
  section('4. 传统案例: 乾为天 guaId=1 (京房乾宫=金) 6 爻六亲');
  // 「他」侧 = 该爻的**纳甲地支五行**。真源(<course-source>·八字神煞大全 阳德条):
  //   「乾六爻自初爻至上面爻之爻辰为『子寅辰午申戌』」⇒ 子水 寅木 辰土 午火 申金 戌土
  // 「我」侧 = 京房乾宫**金**。五种关系(老板 10-21 原话):
  //   生我者⇒父母 同我者⇒兄弟 我生者⇒子孙 我克者⇒妻财 克我者⇒官鬼
  //   (2026-10-22 第 30 批: 静态 LIU_QIN 表已改为**派生**, 形状从「key→六亲标签」
  //    变成「六亲名→出现在哪几爻」, key 名与值不再对不上。)
  //   (2026-10-22 第 36 批: 「他」侧从**爻位固定五行表**换成真纳甲地支五行 ——
  //    那张表查无出处, 且与真纳甲在可验爻位上大幅冲突, 已撤。)
  const QIAN_CASES = [
    { pos: 0, ganzhi: '甲子', yaoWuxing: '水', expected: '子孙', reason: '金生水 (我生他)' },
    { pos: 1, ganzhi: '甲寅', yaoWuxing: '木', expected: '妻财', reason: '金克木 (我克他)' },
    { pos: 2, ganzhi: '甲辰', yaoWuxing: '土', expected: '父母', reason: '土生金 (他生我)' },
    { pos: 3, ganzhi: '壬午', yaoWuxing: '火', expected: '官鬼', reason: '火克金 (他克我)' },
    { pos: 4, ganzhi: '壬申', yaoWuxing: '金', expected: '兄弟', reason: '金金 (同我)' },
    { pos: 5, ganzhi: '壬戌', yaoWuxing: '土', expected: '父母', reason: '土生金 (他生我)' },
  ];
  for (const { pos, ganzhi, yaoWuxing, expected, reason } of QIAN_CASES) {
    const item = computeLiuQinForGua(1)[pos];
    assert(item.ganzhi === ganzhi, `乾为天 pos=${pos} 干支 = ${ganzhi}（实际：${item.ganzhi}）`);
    assert(item.yaoWuxing === yaoWuxing, `乾为天 pos=${pos} 爻五行 = ${yaoWuxing}（实际：${item.yaoWuxing}）`);
    const got = computeLiuQin(1, pos);
    assert(got === expected, `乾为天 pos=${pos} (${yaoWuxing}) → ${got} (期望 ${expected}, ${reason})`);
  }

  // ---- 5. 五个宫五行各验一遍(挑**装得出纳甲**的卦当样本) ----
  section('5. 五个宫五行的 6 爻 liu_qin 序列 (canonical, 走真纳甲)');
  // ⚠️ 这里原来用「爻位固定五行序列 [水木火金土火]」× 五个宫五行 ——
  //   那张序列第 36 批已撤。现在每个宫五行挑一个**装得出纳甲**的卦当样本,
  //   期望值按该卦真实纳甲干支**手推**(不抄被测函数的输出 —— 同源即恒真)。
  //   第 41 批补齐八卦地支后这五个样本**六爻全部装得出**, 所以序列是完整的。
  //   手推过程(「我」= 宫五行; 生我者父母/同我者兄弟/我生者子孙/我克者妻财/克我者官鬼):
  //     金宫 乾(1) 子水寅木辰土午火申金戌土 ⇒ 子孙妻财父母官鬼兄弟父母
  //     土宫 坤(2) 未土巳火卯木丑土亥水酉金 ⇒ 兄弟父母官鬼兄弟妻财子孙
  //     火宫 讼(6) 上乾下坎, 离宫属火:
  //           寅木(生我→父母) 辰土(我生→子孙) 午火(同我→兄弟)
  //           午火(兄弟) 申金(我克→妻财) 戌土(子孙)
  //     水宫 师(7) 上坤下坎, 坎宫属水:
  //           寅木(我生→子孙) 辰土(克我→官鬼) 午火(我克→妻财)
  //           丑土(官鬼) 亥水(同我→兄弟) 酉金(生我→父母)
  //     木宫 豫(16) 上**震**下坤, 震宫属木:
  //           未土(我克→妻财) 巳火(我生→子孙) 卯木(同我→兄弟)
  //           午火(子孙) 申金(克我→官鬼) 戌土(妻财)
  //   ⚠️ 豫是「上震下坤」不是「上坤下震」—— 我一开始凭印象写成反的,
  //     查了 hexagrams.js 的 trigrams 才发现。凡是写死术数期望, 先查表再动手。
  const CANONICAL = {
    '金': { id: 1,  expected: ['子孙', '妻财', '父母', '官鬼', '兄弟', '父母'] },
    '土': { id: 2,  expected: ['兄弟', '父母', '官鬼', '兄弟', '妻财', '子孙'] },
    '火': { id: 6,  expected: ['父母', '子孙', '兄弟', '兄弟', '妻财', '子孙'] },
    '水': { id: 7,  expected: ['子孙', '官鬼', '妻财', '官鬼', '兄弟', '父母'] },
    '木': { id: 16, expected: ['妻财', '子孙', '兄弟', '子孙', '官鬼', '妻财'] },
  };
  for (const wuxing of ['金', '木', '水', '火', '土']) {
    const { id, expected } = CANONICAL[wuxing];
    // 2026-10-22 (第 30 批): 「我」侧换成京房宫五行 ⇒ 断言改成「宫五行确实是 X」。
    const jf = require(path.join(__dirname, '..', 'jingfang_bagong'));
    assert(jf.getJingfang(id).gong_wuxing === wuxing, `guaId=${id} 宫五行确实是 ${wuxing}`);
    for (let pos = 0; pos < 6; pos++) {
      const got = computeLiuQin(id, pos);
      assert(got === expected[pos],
        `宫五行=${wuxing} guaId=${id} pos=${pos} → ${got} (期望 ${expected[pos]})`);
    }
  }

  // ---- 6. 边界处理 ----
  section('6. 边界: guaId / yaoPosition 越界 / 类型错误 → null');
  // guaId 越界
  assert(computeLiuQin(0, 0) === null, 'guaId=0 (下界外) → null');
  assert(computeLiuQin(-1, 0) === null, 'guaId=-1 (负) → null');
  assert(computeLiuQin(65, 0) === null, 'guaId=65 (上界外) → null');
  assert(computeLiuQin(100, 0) === null, 'guaId=100 → null');
  // yaoPosition 越界
  assert(computeLiuQin(1, -1) === null, 'yaoPosition=-1 → null');
  assert(computeLiuQin(1, 6) === null, 'yaoPosition=6 (上界外) → null');
  assert(computeLiuQin(1, 10) === null, 'yaoPosition=10 → null');
  // 类型错误
  assert(computeLiuQin('1', 0) === null, "guaId='1' (string) → null");
  assert(computeLiuQin(1.5, 0) === null, 'guaId=1.5 (float) → null');
  assert(computeLiuQin(null, 0) === null, 'guaId=null → null');
  assert(computeLiuQin(undefined, 0) === null, 'guaId=undefined → null');
  assert(computeLiuQin(1, null) === null, 'yaoPosition=null → null');
  assert(computeLiuQin(1, undefined) === null, 'yaoPosition=undefined → null');
  assert(computeLiuQin(1, '0') === null, "yaoPosition='0' (string) → null");
  assert(computeLiuQin(1, 2.5) === null, 'yaoPosition=2.5 (float) → null');
  // computeLiuQinForGua 边界
  assert(computeLiuQinForGua(0) === null, 'computeLiuQinForGua(0) → null');
  assert(computeLiuQinForGua(65) === null, 'computeLiuQinForGua(65) → null');
  assert(computeLiuQinForGua(-1) === null, 'computeLiuQinForGua(-1) → null');
  assert(computeLiuQinForGua('1') === null, "computeLiuQinForGua('1') → null");
  assert(computeLiuQinForGua(null) === null, 'computeLiuQinForGua(null) → null');

  // ---- 7. 全 64 卦 (384 爻) 扫描 ----
  // ⚠️ 第 36 批: 「他」侧换成了**该爻的纳甲地支五行**, 而纳甲真源只覆盖
  //   乾、坤两卦 ⇒ 实算 96/384 爻位装得出。所以「全部有效且无 null」
  //   这条旧验收标准本身就是**缺口伪装成结论** —— 现在分两半验:
  //     装得出(96)  → 六亲必须是合法标签, 且必须与纳甲地支五行一致
  //     装不出(288) → 六亲必须 null + 原因, **一个都不许编**
  section('7. 全 64 卦 384 爻扫描 - 96 有据 / 288 显式空');
  const najia = require(path.join(__dirname, '..', 'najia.js'));
  let totalYao = 0;
  let loaded = 0;
  let empty = 0;
  const wuxingGuaCount = {};
  for (let guaId = 1; guaId <= 64; guaId++) {
    const arr = computeLiuQinForGua(guaId);
    assert(arr !== null, `guaId=${guaId} → 非 null`);
    const w = wuxingMap.getWuxing(guaId).wuxing;
    wuxingGuaCount[w] = (wuxingGuaCount[w] || 0) + 1;
    for (const item of arr) {
      totalYao++;
      const gz = najia.getYaoGanzhi(guaId, item.yaoPosition + 1);
      if (gz.ok) {
        loaded++;
        assert(VALID.has(item.liuQin), `guaId=${guaId} pos=${item.yaoPosition} → ${item.liuQin} ∈ 5 标签集`);
        assert(item.yaoWuxing === gz.wuxing, `guaId=${guaId} pos=${item.yaoPosition} 爻五行应取纳甲地支 ${gz.dianzhi}=${gz.wuxing}`);
        assert(item.ganzhi === gz.ganzhi, `guaId=${guaId} pos=${item.yaoPosition} 干支应跟纳甲一致`);
        assert(item.reason === null, `guaId=${guaId} pos=${item.yaoPosition} 有纳甲却挂了缺口理由`);
      } else {
        empty++;
        assert(item.liuQin === null, `guaId=${guaId} pos=${item.yaoPosition} 装不出纳甲却给出六亲「${item.liuQin}」`);
        assert(item.yaoWuxing === null, `guaId=${guaId} pos=${item.yaoPosition} 装不出纳甲却给出爻五行`);
        assert(item.ganzhi === null, `guaId=${guaId} pos=${item.yaoPosition} 装不出纳甲却给出干支`);
        assert(item.reason && item.reason.length > 5, `guaId=${guaId} pos=${item.yaoPosition} 缺口必须带原因`);
      }
      // 字段一致性
      assert(item.yaoPosition === item.yaoPosition, `guaId=${guaId} pos=${item.yaoPosition} 字段自洽`);
    }
  }
  assert(totalYao === 64 * 6, `总爻数 = 384（实际：${totalYao}）`);
  // ⚠️ 这两个数**从纳甲层实算**, 不手写。第 41 批补齐八卦地支后是 384/0;
  //   之前手写的「96 / 288」曾经是真值, 也曾随真源补齐而变假 —— 手写的数是负债。
  const stats = najia.getCoverageStats();
  assert(loaded === stats.yao_loadable,
    `装得出纳甲的爻位应与纳甲层实算一致 = ${stats.yao_loadable}（实际：${loaded}）`);
  assert(empty === stats.yao_total - stats.yao_loadable,
    `装不出纳甲的爻位应与纳甲层实算一致 = ${stats.yao_total - stats.yao_loadable}（实际：${empty}）`);
  assert(loaded + empty === totalYao, '装得出 + 装不出 必须等于总数, 不能两头都对不上');
  // 5 五行卦都有 (覆盖完备)
  for (const w of ['金', '木', '水', '火', '土']) {
    assert((wuxingGuaCount[w] || 0) >= 1, `64 卦中至少 1 个 ${w} 卦（实际：${wuxingGuaCount[w] || 0}）`);
  }

  // ---- 8. 算法原理直接验证 ----
  section('8. 算法原理: 拿真纳甲地支, 五个宫五行各验一遍');
  // 「他」侧现在 = 该爻的**纳甲地支五行**。期望值全部手写, 不从被测函数自己算:
  //   纳甲地支真源: 「乾六爻…爻辰为『子寅辰午申戌』」/「[坤]卦…为『未巳卯丑亥酉』」
  //     (<course-source>·八字神煞大全 阳德条 / 阴德条)
  //   装卦规则(内三爻取下卦纳甲, 外三爻取上卦纳甲)是本仓第 33 批从两例真源验出来的。
  // 五种关系出自老板 2026-10-21 原话:
  //   生我者⇒父母  同我者⇒兄弟  我生者⇒子孙  我克者⇒妻财  克我者⇒官鬼
  //
  // 我=金 (乾宫, guaId=1): 甲子水 甲寅木 甲辰土 壬午火 壬申金 壬戌土
  assert(computeLiuQin(1, 0) === '子孙', '金+子水 → 子孙 (我生他)');
  assert(computeLiuQin(1, 1) === '妻财', '金+寅木 → 妻财 (我克他)');
  assert(computeLiuQin(1, 2) === '父母', '金+辰土 → 父母 (土生我)');
  assert(computeLiuQin(1, 3) === '官鬼', '金+午火 → 官鬼 (火克我)');
  assert(computeLiuQin(1, 4) === '兄弟', '金+申金 → 兄弟 (同我)');
  // 我=土 (坤宫, guaId=2): 乙未土 乙巳火 乙卯木 癸丑土 癸亥水 癸酉金
  assert(computeLiuQin(2, 0) === '兄弟', '土+未土 → 兄弟 (同我)');
  assert(computeLiuQin(2, 1) === '父母', '土+巳火 → 父母 (火生我)');
  assert(computeLiuQin(2, 2) === '官鬼', '土+卯木 → 官鬼 (木克我)');
  assert(computeLiuQin(2, 4) === '妻财', '土+亥水 → 妻财 (我克他)');
  assert(computeLiuQin(2, 5) === '子孙', '土+酉金 → 子孙 (我生他)');
  // 我=火 (离宫, guaId=6 讼 = 坎下乾上 ⇒ 外三爻纳乾): 壬午火 壬申金 壬戌土
  assert(computeLiuQin(6, 3) === '兄弟', '火+午火 → 兄弟 (同我)');
  assert(computeLiuQin(6, 4) === '妻财', '火+申金 → 妻财 (我克他)');
  assert(computeLiuQin(6, 5) === '子孙', '火+戌土 → 子孙 (火生土)');
  // 我=水 (坎宫, guaId=7 师 = 坎下坤上 ⇒ 外三爻纳坤): 癸丑土 癸亥水 癸酉金
  assert(computeLiuQin(7, 3) === '官鬼', '水+丑土 → 官鬼 (土克水)');
  assert(computeLiuQin(7, 4) === '兄弟', '水+亥水 → 兄弟 (同我)');
  assert(computeLiuQin(7, 5) === '父母', '水+酉金 → 父母 (金生水)');
  // 我=木 (震宫, guaId=16 豫 = 坤下震上 ⇒ 内三爻纳坤): 乙未土 乙巳火 乙卯木
  assert(computeLiuQin(16, 0) === '妻财', '木+未土 → 妻财 (木克土)');
  assert(computeLiuQin(16, 1) === '子孙', '木+巳火 → 子孙 (木生火)');
  assert(computeLiuQin(16, 2) === '兄弟', '木+卯木 → 兄弟 (同我)');
  // 第 41 批: 坎、离的地支补齐后不再有缺口, 改验**真值**。
  //   期望值是**手推**的(不是从被测函数抄的 —— 同源即恒真):
  //     坎为水 = 坎宫属水, 纳甲 戊寅戊辰戊午戊申戊戌戊子 ⇒ 木/土/火/金/土/水
  //       生我者父母(金) 同我者兄弟(水) 我生者子孙(木) 我克者妻财(火) 克我者官鬼(土)
  //       ⇒ 子孙 官鬼 妻财 父母 官鬼 兄弟
  //     离为火 = 离宫属火, 纳甲 己卯己丑己亥己酉己未己巳 ⇒ 木/土/水/金/土/火
  //       ⇒ 父母 子孙 官鬼 妻财 子孙 兄弟
  const KAN = ['子孙', '官鬼', '妻财', '父母', '官鬼', '兄弟'];
  const LI = ['父母', '子孙', '官鬼', '妻财', '子孙', '兄弟'];
  for (let p = 0; p <= 5; p++) {
    assert(computeLiuQin(29, p) === KAN[p], `坎为水(29) 第${p + 1}爻六亲应 ${KAN[p]}`);
    assert(computeLiuQin(30, p) === LI[p], `离为火(30) 第${p + 1}爻六亲应 ${LI[p]}`);
  }

  // ⚠️ 「装不出的爻位必须 null, 不许因为凑齐 5 种关系而编一个」——
  //   这条性质在第 41 批补齐后, 真实数据上**走不到**了(384/384 都装得出)。
  //   如果就此删掉, 「没给的地方不许自己编」就永远没人验了。所以**注入一张
  //   挖空的纳甲表**把它单独验回来 —— 牙齿是「真数据 + 故意缺口」。
  const najiaMod = require(path.join(__dirname, '..', 'najia.js'));
  const holedNajia = {
    getYaoGanzhi: (id, pos) => najiaMod.getYaoGanzhiWithTable({}, id, pos),
  };
  for (let p = 0; p <= 5; p++) {
    assert(computeLiuQin(1, p, { najia: holedNajia }) === null,
      `注入空纳甲表后乾卦第${p + 1}爻必须返回 null(不许编六亲)`);
  }

  // ---- 汇总 ----
  console.log('\n' + '='.repeat(60));
  console.log(`测试结果：✅ ${passed} 项通过  ❌ ${failed} 项失败`);
  console.log('='.repeat(60));

  if (failed === 0) {
    console.log('\n🎯 8 组测试全部通过！liu_qin.js 验证完毕。');
    process.exit(0);
  } else {
    console.log(`\n⚠️  有 ${failed} 项失败，请检查 liu_qin.js。`);
    process.exit(1);
  }
}

run();
