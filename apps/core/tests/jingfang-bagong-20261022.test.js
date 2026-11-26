'use strict';
// 京房八宫 64 卦表 (2026-10-22, 第 29 批)
//
// 起因: 老板问「六爻 6 爻 12 宫」这套东西到底有没有、盘古答得对不对。
//   查下来三件事:
//     ① repo 的 `bagong` 字段**不是京房八宫** —— 是「上卦所属纯卦(上卦分组)」, 64/64;
//     ② repo 的 `elements`(卦五行) 是**上卦口径**, 跟京房**宫五行**在 **32/64** 卦上不一致;
//     ③ 六爻完整装卦纳甲真源**没有** —— 语料 0 个文件命中「六爻」, 85 个 PDF 全扫过。
//
// 这条测试的定位: **双源交叉 + 守卫会咬人**。
//   这张表进了生产输出(卦象、查卦工具), 一旦跟真源漂了, 盘古会**安静地**
//   按错的宫/世应断卦 —— 不报错, 只是答案全错(和「传男被当女命」同族)。
//
// 负例是重点: 自检全绿不说明它有用。造三张坏表喂进去, 断言它**必须咬人**。
//   负例走**注入点**(`assertJingfangTable({sourceTable})` / `({table})`),
//   **不改共享源文件** —— 2026-10-22 踩过: 改共享文件时隔壁测试文件会读到被改坏的版本,
//   报出看着像真 bug 的错(单跑绿/全量红/复现不了)。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CORE = path.join(__dirname, '..');
const JF = require(path.join(CORE, '64i', 'bagua_annotations', 'jingfang_bagong.js'));
const HEX = require(path.join(CORE, '64i', 'hexagrams.js'));

// ============================================================
// 一、真代码: 自检在当前数据上必须过
// ============================================================

test('assertJingfangTable 在当前数据上不抛 (绿灯的前提是真的没漂)', () => {
  const r = JF.assertJingfangTable();
  assert.equal(r.ok, true);
  assert.equal(r.checked, 64);
  assert.deepEqual(r.violations, []);
});

// ============================================================
// 二、双源交叉: 机械推导(变爻规则) == 文本真源表, 64/64
// ============================================================

test('机械推导与文本真源逐格一致 (64/64)', () => {
  let n = 0;
  for (const gong of JF.GONGS) {
    assert.equal(JF.SOURCE_TABLE[gong].length, 8, gong + '宫 真源表应 8 个卦位');
    JF.WEI_NAMES.forEach((wei, i) => {
      const row = JF.JINGFANG_TABLE.find(r => r.gong === gong && r.wei_index === i);
      assert.ok(row, gong + '宫' + wei + ' 缺推导条目');
      assert.equal(row.gua_name, JF.SOURCE_TABLE[gong][i],
        gong + '宫' + wei + ': 推导=' + row.gua_name + ' 真源=' + JF.SOURCE_TABLE[gong][i]);
      n++;
    });
  }
  assert.equal(n, 64);
});

test('推导是**真的按变爻规则算的** (不是把真源抄了一遍)', () => {
  // 独立再推一遍: 乾宫纯卦 111111, 一世变初爻, 游魂变回四爻, 归魂变下三爻
  assert.equal(JF._deriveBinary('乾', 0), '111111', '乾宫本宫 = 纯卦');
  assert.equal(JF._deriveBinary('乾', 1), '011111', '乾宫一世 = 变初爻');
  assert.equal(JF._deriveBinary('乾', 6), '000101', '乾宫游魂 = 五世变回四爻');
  assert.equal(JF._deriveBinary('乾', 7), '111101', '乾宫归魂 = 游魂变下三爻');
  // 坎宫本宫 = 010010
  assert.equal(JF._deriveBinary('坎', 0), '010010');
  // 震宫本宫 = 100100
  assert.equal(JF._deriveBinary('震', 0), '100100');
});

// ============================================================
// 三、双射: 64 卦一一覆盖, 8宫×8位
// ============================================================

test('64 卦一一覆盖 (无重无漏)', () => {
  const ids = JF.JINGFANG_TABLE.map(r => r.gua_id);
  assert.equal(ids.filter(id => id === null).length, 0, '有条目反查不到卦');
  assert.equal(new Set(ids).size, 64, '64 卦应各有且仅有一个宫位');
  const names = JF.JINGFANG_TABLE.map(r => r.gua_name);
  assert.equal(new Set(names).size, 64, '64 个卦名应互不重复');
});

test('8 宫 × 8 卦位 = 64 组合, 无缺失', () => {
  for (const gong of JF.GONGS) {
    const rows = JF.JINGFANG_TABLE.filter(r => r.gong === gong);
    assert.equal(rows.length, 8, gong + '宫 应 8 个卦位');
    assert.deepEqual(rows.map(r => r.wei_index).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]);
  }
});

// ============================================================
// 四、锚点: 具体几卦的宫/宫位/世爻 (人工核对过的)
// ============================================================

test('锚点卦的宫位与世爻', () => {
  const CASES = [
    { id: 1, name: '乾', gong: '乾', wei: '本宫', shi: 6, wuxing: '金' },
    { id: 4, name: '蒙', gong: '离', wei: '四世', shi: 4, wuxing: '火' },
    { id: 6, name: '讼', gong: '离', wei: '游魂', shi: 4, wuxing: '火' },
    { id: 7, name: '师', gong: '坎', wei: '归魂', shi: 3, wuxing: '水' },
    { id: 44, name: '姤', gong: '乾', wei: '一世', shi: 1, wuxing: '金' },
    { id: 64, name: '未济', gong: '离', wei: '三世', shi: 3, wuxing: '火' },
  ];
  for (const c of CASES) {
    const e = JF.getJingfang(c.id);
    assert.ok(e, c.name + ' 应查得到京房归属');
    assert.equal(e.gua_name, c.name);
    assert.equal(e.gong, c.gong, c.name + ' 宫');
    assert.equal(e.wei, c.wei, c.name + ' 卦位');
    assert.equal(e.shi, c.shi, c.name + ' 世爻');
    assert.equal(e.gong_wuxing, c.wuxing, c.name + ' 宫五行');
  }
});

// ============================================================
// 五、宫五行 == 本宫卦的卦五行
// ============================================================

test('宫五行与本宫卦的卦五行一致', () => {
  for (const gong of JF.GONGS) {
    const ben = JF.getJingfangByGong(gong)[0];
    const hex = HEX.HEXAGRAMS.find(h => h.id === ben.gua_id);
    assert.equal(hex.elements, JF.GONG_WUXING[gong], gong + '宫 宫五行与本宫卦卦五行不一致');
  }
});

// ============================================================
// 六、repo 的 bagong 不是京房宫 (这条是本批的**发现**, 钉住它别再混)
// ============================================================

test('repo 的 bagong 字段 = 上卦分组, 与京房宫在 32/64 卦上不同', () => {
  const TRIG = { '乾': '111', '兑': '110', '离': '101', '震': '100', '巽': '011', '坎': '010', '艮': '001', '坤': '000' };
  let upperGroup = 0;
  let same = 0;
  for (const h of HEX.HEXAGRAMS) {
    // bagong === 上卦所属纯卦
    const upper = h.binary.slice(3);
    const pureName = Object.keys(TRIG).find(k => TRIG[k] === upper);
    assert.equal(h.bagong, pureName, h.name + ' 的 bagong 应等于上卦所属纯卦');
    upperGroup++;
    if (JF.getJingfangGong(h.id) === h.bagong) same++;
  }
  assert.equal(upperGroup, 64);
  // 两套口径确实不同 —— 数字钉死, 免得哪天有人把其中一套「统一」掉
  assert.equal(same, 32, '京房宫与上卦分组应恰好在 32/64 卦上一致');
});

// ============================================================
// 七、应爻 8/8 行都有值 (第 35 批: 撤掉那条无出处的本宫特例)
// ============================================================

test('应爻 8/8 行都有值, 统一按隔三位配对 (本宫卦应三爻)', () => {
  // 2026-10-22 第 35 批: 原来 8 个本宫卦的应爻留 null, 理由写的是
  //   「隔三位给三爻, 经典另说初爻, 两说冲突, 真源没收录, 不编」。
  //   那条理由站不住: ① 本仓自己的配对表 {1:4,...,6:3} 就含 6:3 —— 自相矛盾;
  //   ② 「经典另说初爻」全语料查无出处; ③ 隔三位是定义式规则, 56 行早就在用。
  //   ⇒ 现在 8/8 行统一, 本宫卦(世在上爻)应三爻。
  const nulls = JF.JINGFANG_TABLE.filter(r => r.ying === null);
  assert.equal(nulls.length, 0, '不应再有应爻为 null 的行');

  for (const r of JF.JINGFANG_TABLE) {
    assert.equal(r.ying, ((r.shi + 2) % 6) + 1,
      r.gong + '宫' + r.wei + ' 应爻应与世爻隔三位');
  }
  // 8 个本宫卦: 世在上爻(6) ⇒ 应三爻(3)
  const bens = JF.JINGFANG_TABLE.filter(r => r.wei === '本宫');
  assert.equal(bens.length, 8);
  for (const r of bens) {
    assert.equal(r.shi, 6, r.gong + '宫本宫卦世应在上爻');
    assert.equal(r.ying, 3, r.gong + '宫本宫卦应爻应在三爻');
  }
});

test('世应状态说明写在模块里 (模型能读到口径)', () => {
  assert.ok(JF.SHI_YING_STATUS.shi);
  assert.ok(JF.SHI_YING_STATUS.ying);
  assert.ok(JF.SHI_YING_STATUS.ying_basis, '要说明应爻的规则依据与校验范围');
  // 第 35 批: 「本宫那行留 null」的说法已撤 —— 口径里不许再留这条假缺口,
  //   否则模型会照着讲「本宫卦应爻缺失」, 而盘古明明有值。
  assert.equal(JF.SHI_YING_STATUS.ying_missing, undefined,
    'ying_missing 字段应已删除(不应再有应爻缺口)');
});

// ============================================================
// 七之二、★ 世应爻位的**外部交叉校验**(第 35 批核心)
//   这段是本批的重点: 前面的自检(双源交叉/世应自洽)用的都是
//   **同一份规则的尺子** —— 拿"隔三位"量"按隔三位推的表", 恒真。
//   这里的尺子是**异源**的: 真纳甲地支(真源) × 真源六冲表(真源)。
// ============================================================

test('★ 世应外部交叉校验: 本宫纯卦的世应地支必相冲', () => {
  const r = JF.checkShiYingCrossCheck();
  assert.equal(r.ok, true, r.violations.join('\n'));
  assert.ok(r.checked > 0, '一条都没验上 ⇒ 校验形同虚设');
  // ⚠️ 第 41 批: 八卦纳甲地支 8/8 补齐(四源交叉验证) ⇒ 8 个本宫卦**全部**验得上。
  //   这里从「2/8」改成「8/8」不是放宽判据, 是数据补齐后的事实 ——
  //   验的仍然是同一件事(世应地支必相冲), 只是尺子的覆盖从 2 个长到 8 个。
  assert.equal(r.checked, 8, '八卦地支补齐后, 8 个本宫卦应全部验得上');
  assert.ok(/8\/8/.test(r.coverage), 'coverage 要写明覆盖到哪一层, 不能夸大');
  // 抽验两例(手算过, 不是从被测函数自己抄的): 乾 世戌应辰(冲) / 坤 世酉应卯(冲)
  const qian = r.detail.find(d => d.gua_name === '乾');
  const kun = r.detail.find(d => d.gua_name === '坤');
  assert.equal(qian.shi_zhi, '戌');
  assert.equal(qian.ying_zhi, '辰');
  assert.equal(kun.shi_zhi, '酉');
  assert.equal(kun.ying_zhi, '卯');
});

test('★ 交叉校验的判据只对本宫卦成立 (不能推广成「世应必冲」)', () => {
  // 对照组: 世3应6 的两卦(泰/否)世应地支**不冲** ——
  //   所以「世应必冲」不是通则, 只在本宫纯卦这一族成立。
  //   校验若被误改成"全 64 行都查相冲", 这条会立刻炸。
  const NJ = require(path.join(CORE, '64i', 'bagua_annotations', 'najia.js'));
  const CHONG = require(path.join(CORE, '64i', 'bazi', 'zhis_relations.js')).LIU_CHONG;
  for (const id of [11, 12]) {
    const jf = JF.getJingfang(id);
    const s = NJ.getYaoGanzhi(id, jf.shi);
    const y = NJ.getYaoGanzhi(id, jf.ying);
    assert.ok(s.ok && y.ok);
    const isChong = CHONG.some(p => p.pair.includes(s.dianzhi) && p.pair.includes(y.dianzhi));
    assert.equal(isChong, false,
      id + ' 卦的世应地支不该相冲 —— 判据若被推广, 说明尺子用错了地方');
  }
});

test('★ 交叉校验对「应爻=1」必须报错 (证明它真能分辨, 不是恒真)', () => {
  // 负例: 把乾宫本宫卦的应爻从 3 改成 1 ⇒ 世戌/应子 不冲 ⇒ 必须炸。
  //   注意这走的是**注入点**({table}), 不改共享源文件 ——
  //   node --test 多文件并行时改共享文件会让隔壁文件读到坏版本。
  const bad = JF.JINGFANG_TABLE.map(r => Object.assign({}, r));
  const qian = bad.find(r => r.gong === '乾' && r.wei === '本宫');
  assert.ok(qian, '锚点没命中: 乾宫本宫卦不见了 —— 测试会空跑, 直接抛');
  qian.ying = 1;
  const r = JF.checkShiYingCrossCheck({ table: bad });
  assert.equal(r.ok, false, '应爻改成 1 后必须报不相冲');
  assert.ok(/不相冲/.test(r.violations.join('\n')), r.violations.join('\n'));
});

test('★ 交叉校验对「世爻改一位」必须报错', () => {
  const bad = JF.JINGFANG_TABLE.map(r => Object.assign({}, r));
  const qian = bad.find(r => r.gong === '乾' && r.wei === '本宫');
  assert.ok(qian, '锚点没命中: 乾宫本宫卦不见了 —— 测试会空跑, 直接抛');
  qian.shi = 5;
  const r = JF.checkShiYingCrossCheck({ table: bad });
  assert.equal(r.ok, false, '世爻改一位后必须报不相冲');
});

test('★ 交叉校验在一条都验不上时必须报「形同虚设」', () => {
  // 注入一张**全挖空**的纳甲表 ⇒ 一个本宫卦都验不上 ⇒ checked=0
  // ⇒ 校验必须**报出来**, 不能因为"没找到问题"就绿。
  // ⚠️ 第 41 批: 这条负例原来靠「屯(3) 装不出纳甲」来制造缺口 —— 补齐八卦地支后
  //   **屯也装得出了**, 缺口消失, checked 反而变成 8。这叫**负例静默失效**:
  //   断言还在, 但它验的根本不是原来那件事(而且还会误报成"校验没报形同虚设")。
  //   ⇒ 改成**自己造缺口**: 注入一张没有八卦地支的纳甲层。
  const NJ = require(path.join(CORE, '64i', 'bagua_annotations', 'najia.js'));
  const emptyNajia = {
    loadableGuaIds: () => [],
    getYaoGanzhi: (id, pos) => NJ.getYaoGanzhiWithTable({}, id, pos),
  };
  const r = JF.checkShiYingCrossCheck({ najia: emptyNajia });
  assert.equal(r.ok, false);
  assert.ok(/形同虚设/.test(r.violations.join('\n')), r.violations.join('\n'));
});

// ------------------------------------------------------------
// 第 35 批补: 两个「守卫在但不咬人」的洞
// ------------------------------------------------------------

test('★ 坏行不许被静默降级成「验不了」 (守卫不能闭嘴)', () => {
  // 原来的洞: 某一行坏了(gua_id 改成 999 / shi 改成 0 / ying 改成 null),
  //   getYaoGanzhi 装不出干支 ⇒ 这行被静默标成 'unverifiable' 跳过;
  //   而「一条都没验上」那条兜底不触发(还有别的行验上了)
  //   ⇒ 整个校验报 ok=true —— 守卫在, 但坏数据能让它闭嘴。
  // 修法: 本宫卦的 id 有确定答案(本宫的纯卦, 由变爻规则实算),
  //   且该 id 若在纳甲层「可装卦」集合里就本该验上 ⇒ 验不上必须报。
  const CASES = [
    ['gua_id 改成 999', r => { r.gua_id = 999; }],
    ['gua_id 改成 null', r => { r.gua_id = null; }],
    ['gua_id 改成坤卦(2)', r => { r.gua_id = 2; }],
    ['shi 改成 0', r => { r.shi = 0; }],
    ['shi 改成 null', r => { r.shi = null; }],
    ['ying 改成 null', r => { r.ying = null; }],
    ['ying 改成 99', r => { r.ying = 99; }],
  ];
  for (const [label, mutate] of CASES) {
    const bad = JF.JINGFANG_TABLE.map(r => Object.assign({}, r));
    const row = bad.find(r => r.gong === '乾' && r.wei === '本宫');
    assert.ok(row, '锚点没命中: 乾宫本宫卦不见了 —— 测试会空跑, 直接抛');
    mutate(row);
    const r = JF.checkShiYingCrossCheck({ table: bad });
    assert.equal(r.ok, false, '坏行(' + label + ')必须让交叉校验报错, 不许静默跳过');
    assert.ok(r.violations.length > 0, label + ' 必须给出违例说明');
  }
});

test('★ 双射必须查「id 指向的卦」, 不只查「id 不重复」', () => {
  // 原来的洞: 双射只查了 id 不重复 ⇒ 把某行 gua_id 改成 999,
  //   id 依然唯一、双射照样过, 而这一行从此指向一个**不存在的卦**
  //   (查卦工具按 id 查不到 ⇒ 静默返回 null, 一声不响)。
  const CASES = [
    ['gua_id=999', r => { r.gua_id = 999; }, /双射/],
    ['gua_id=null', r => { r.gua_id = null; }, /双射/],
    ['gua_id=2(指坤但自称乾)', r => { r.gua_id = 2; }, /双射/],
    ['binary 与 id 不符', r => { r.gua_binary = '000000'; }, /双射/],
  ];
  for (const [label, mutate, re] of CASES) {
    const bad = JF.JINGFANG_TABLE.map(r => Object.assign({}, r));
    const row = bad.find(r => r.gong === '乾' && r.wei === '本宫');
    assert.ok(row, '锚点没命中: 乾宫本宫卦不见了 —— 测试会空跑, 直接抛');
    mutate(row);
    assert.throws(() => JF.assertJingfangTable({ table: bad }), re,
      label + ' 必须被双射(而非别的检查)抓住');
  }
});

test('纳甲状态说明写在模块里 (模型能读到口径)', () => {
  assert.ok(JF.NAJIA_STATUS.detail);
  // 2026-10-22 第 33 批: 纳甲从「缺」变成「部分」(4/64);
  //   第 41 批: 八卦地支 8/8 补齐 ⇒ 64/64, 口径跟着改成「齐全」。
  //   ⚠️ 这个数**不许再手写**: 断言改成跟纳甲层**实算**对账 ——
  //   手写的数字会跟表漂(之前就漂过一次: 写 2, 表算出来是 4), 而且没人发现。
  const NJ = require(path.join(CORE, '64i', 'bagua_annotations', 'najia.js'));
  const loadable = NJ.loadableGuaIds().length;
  // 完整了就断言完整 —— 断言「必须小于 64」等于**把缺口钉成规范**,
  //   哪天真源补齐了, 正确的代码反而会让测试红。
  assert.equal(loadable, 64, '第 41 批补齐八卦地支后, 64 卦应全部装得出完整六爻干支');
  assert.ok(JF.NAJIA_STATUS.status.includes(String(loadable)),
    '纳甲状态里的数(' + JF.NAJIA_STATUS.status + ')应与实算的 ' + loadable + ' 卦对上');
  assert.ok(/齐全/.test(JF.NAJIA_STATUS.status),
    '全部装得出时口径不该还说「部分」: ' + JF.NAJIA_STATUS.status);
  // ⚠️ 判旧数字残留时, 数字前要卡一个非数字, 否则「64 卦」会被 `/4 卦/` 命中
  //   —— 守卫自己乱叫, 比没守卫更坏(同一个病: 判据写歪会冤枉正确数据)。
  assert.ok(!/只有乾、坤|其余 60 卦|96\/384|(?<![0-9])4 卦/.test(JF.NAJIA_STATUS.detail),
    '口径里不该还留着第 33 批的旧数字');
  assert.ok(/不是纳甲表/.test(JF.NAJIA_STATUS.detail),
    '口径里要说明 64i 的 najia 字段不是纳甲表');
  assert.ok(JF.REPO_BAGONG_NOTE.includes('上卦'));
});

// ============================================================
// 八、负例: 自检必须**咬人** (不自检的守卫等于没有)
// ============================================================

test('负例①: 真源表改错一格 → 双源交叉必须炸', () => {
  const bad = {};
  for (const g of JF.GONGS) bad[g] = JF.SOURCE_TABLE[g].slice();
  bad['乾'][1] = '遁'; // 一世姤 被改成 遁 —— 只差一格
  assert.throws(() => JF.assertJingfangTable({ sourceTable: bad }),
    /双源交叉/, '改错一格必须被双源交叉抓住');
});

test('负例②: 推导表里两卦撞同一个 id → 双射必须炸', () => {
  const bad = JF.JINGFANG_TABLE.map(r => Object.assign({}, r));
  bad[1].gua_id = bad[0].gua_id; // 乾宫一世 撞上 乾宫本宫
  assert.throws(() => JF.assertJingfangTable({ table: bad }),
    /双射/, '两个卦撞同一个 id 必须被双射抓住');
});

test('负例③: 世爻越界 → 世应自检必须炸', () => {
  const bad = JF.JINGFANG_TABLE.map(r => Object.assign({}, r));
  bad[0].shi = 9;
  assert.throws(() => JF.assertJingfangTable({ table: bad }),
    /世应/, '世爻越界必须被抓住');
});

test('负例④: 本宫卦的卦五行对不上宫五行 → 必须炸', () => {
  const bad = JF.JINGFANG_TABLE.map(r => Object.assign({}, r));
  // 把乾宫本宫卦换成别的卦的 binary(上卦五行会跟宫五行打架)
  const wrong = HEX.HEXAGRAMS.find(h => h.id === 2); // 坤 土
  bad[0].gua_binary = wrong.binary;
  assert.throws(() => JF.assertJingfangTable({ table: bad }),
    /宫五行/, '本宫卦与宫五行对不上必须被抓住');
});

// ============================================================
// 九、接进生产路径: 导出 / 启动链 / 工具输出
// ============================================================

test('64i/index.js 导出 jingfangBagong', () => {
  const idx = require(path.join(CORE, '64i', 'index.js'));
  assert.ok(idx.jingfangBagong, '64i/index.js 应导出 jingfangBagong');
  assert.equal(typeof idx.jingfangBagong.getJingfang, 'function');
});

test('启动链接了自检 (装时炸, 不是「跑测试才看」)', () => {
  const src = fs.readFileSync(path.join(CORE, 'pangu-single.js'), 'utf8');
  assert.match(src, /assertJingfangTable/,
    'pangu-single.js 启动链里必须有 assertJingfangTable —— 守卫不在启动链上就等于没装');
});

test('起卦输出带京房归属 (模型看得见, 不用自己回忆)', () => {
  const engine = require(path.join(CORE, 'modules', 'gua_engine.js'));
  const gua = engine.castGua('八宫表自检', { numbers: [1, 2, 3] });
  assert.ok(gua && gua.jingfang, '起卦结果应带 jingfang');
  assert.ok(gua.jingfang.gong, '应有宫名');
  assert.ok(gua.jingfang.wei, '应有卦位');
  assert.ok(gua.jingfang.shi >= 1 && gua.jingfang.shi <= 6, '应有合法世爻');
});

test('查卦工具输出带京房归属 + 口径注', async () => {
  const { TOOLS } = require(path.join(CORE, 'modules', 'tools'));
  const r = await TOOLS.hexagram_lookup({ context: {}, params: { query: '蒙' } });
  assert.equal(r.ok, true);
  assert.ok(r.data.jingfang, '查卦结果应带 jingfang');
  assert.equal(r.data.jingfang.gong, '离');
  assert.equal(r.data.jingfang.wei, '四世');
  assert.ok(r.data.bagong_note && r.data.bagong_note.includes('上卦'),
    '必须带 bagong 口径注(那是上卦分组, 不是京房宫)');
});

test('爻层边界守卫没被这张表带坏 (爻层仍然零五行/纳甲)', () => {
  const G = require(path.join(CORE, 'modules', 'yao_layer_boundary.js'));
  const r = G.checkYaoLayerBoundary();
  assert.equal(r.ok, true, r.violations.join('\n'));
});
