'use strict';
// 爻位 0-based / 1-based 错位 (2026-10-22, 第二十六批)
//
// 老板 10-21 原话:「64卦不是 1~64 是 0~63」—— 同一个坑, 下沉到了爻位。
//
// 现场 (本轮查「串起来能不能用」时撞出来的):
//   `gua_cast` 一次返回里, **同一个动爻**的两半在描述**不同的爻**:
//     moving_yao: 4 | yao_name: 六四 | yao_wuxing: 土 | liu_qin: 妻财
//   六四 是**四爻**(金/官鬼), 土/妻财 是**九五**的 —— 错位一爻。
//
// 根因: `movingYao` 是 1-based (本函数 `yaoCiAll[movingYao - 1]` 就是证据),
// 而 `getYaoVector(guaId, yaoPosition)` 的形参是 0-based
// (文档「0=初爻, 5=上爻」+ 内部 `_isValidYaoPosition` 只收 0..5)。
// 直接传 → 整个向量错位一爻, **一声不吭**。
//
// 为什么不报错、为什么没人发现:
//   下游 `yao_name` 走 yaoCiAll[movingYao-1], 那条**是对的** →
//   于是看起来整条链都对。错的只有 vector 那四个字段
//   (yao_wuxing / wuxing_rel / liu_qin / position_nature), 且不抛不警告。
//   上爻更甚: movingYao=6 越界 → getYaoVector 返回 null →
//   那四个字段**静默全空** —— 卦起出来了, 五行和六亲却是空的, 不像出错, 像没数据。
//
// 本测试盯四件事:
//   ① 四爻的爻五行/六亲必须对得上**四爻自己**(金/官鬼), 不是九五(土/妻财)
//   ② 上爻(movingYao=6)不许静默变空
//   ③ 1-based ↔ 0-based 换算只有一个点 (防第二个错点)
//   ④ 负例: 把换算改回去, 守卫必须咬人

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CORE = path.join(__dirname, '..');
const hv = require(path.join(CORE, '64i', 'hexagram_vector.js'));
const yaoAxioms = require(path.join(CORE, '64i', 'bagua_annotations', 'yao_axioms.js'));
const NAJIA = require(path.join(CORE, '64i', 'bagua_annotations', 'najia.js'));

// ⚠️ 第 36 批更正: 爻五行不再来自「爻位固定五行表」(那张表查无出处, 已撤),
//   改来自**该爻的纳甲地支五行**。所以下面凡涉及爻五行的**真值**,
//   一律手写自真源「乾六爻自初爻至上面爻之爻辰为『子寅辰午申戌』」
//   (外三爻取后三支), 不从被测函数自己算 —— 尺子与被测对象同源 = 恒真断言。
//   纳甲是**按爻**算的(内三爻取下卦、外三爻取上卦), 所以「有没有五行」
//   要**逐爻**判, 不能按整卦判: 实算 96/384 爻位装得出。

// ============================================================
// 一、表本身是 0-based (一切错位的源头)
// ============================================================

test('爻位公理表是 0-based: idx0=初爻, idx5=上爻, idx6 越界', () => {
  const a0 = yaoAxioms.getYaoPositionAxiom(0);
  assert.equal(a0.yaoName_yang, '初九');
  assert.equal('wuxing' in a0, false, '爻位公理层不该再带五行(第 36 批已撤那张查无出处的表)');
  const a5 = yaoAxioms.getYaoPositionAxiom(5);
  assert.equal(a5.yaoName_yang, '上九');
  assert.equal(yaoAxioms.getYaoPositionAxiom(6), null, '越界必须返回 null 而不是瞎给一个');
});

test('getYaoVector 的形参是 0-based (传 6 越界返回 null)', () => {
  assert.ok(hv.getYaoVector(1, 0), '传 0 应有值');
  assert.ok(hv.getYaoVector(1, 5), '传 5 应有值');
  assert.equal(hv.getYaoVector(1, 6), null, '传 6 必须 null —— 这正是上爻静默变空的机制');
});

// ============================================================
// 二、接线: gua_engine 的换算
// ============================================================

test('★ 接线: gua_engine 必须把 movingYao 减 1 再传 getYaoVector', () => {
  const src = fs.readFileSync(path.join(CORE, 'modules', 'gua_engine.js'), 'utf8');
  const call = src.match(/getYaoVector\(\s*guaId\s*,\s*([^)]+)\)/);
  assert.ok(call, 'gua_engine 里找不到 getYaoVector 调用 —— 接线变了, 先核');
  assert.notEqual(call[1].trim(), 'movingYao',
    '直接把 movingYao(1-based) 传给 0-based 形参 = 错位一爻, '
    + '且 yao_name 走另一条路仍然对, 于是**看起来**整条链没问题');
  // 换算必须收敛到**一个**具名变量, 不能散落两处 (散落必有一处漏)
  assert.match(src, /const yaoIdx0 = movingYao - 1;/,
    '1-based→0-based 的换算应该收在具名变量 yaoIdx0, 便于全文件核对只有这一处');
  const nMinus1 = (src.match(/movingYao\s*-\s*1/g) || []).length;
  assert.ok(nMinus1 >= 1, '换算点不见了');
});

// ============================================================
// 三、行为: 错位到底错在哪 (负例对照, 不靠源码断言)
// ============================================================

test('★ 行为: 四爻的向量必须对得上四爻自己, 不是九五', () => {
  const guaId = 6;    // 讼 = 坎下乾上 ⇒ 外三爻纳乾(壬午申戌)
                      // 真源: 乾外三爻爻辰 = 午申戌 ⇒ 四爻午(火) / 五爻申(金)
  // 四爻 = 1-based 4 = 0-based idx3
  const v = hv.getYaoVector(guaId, 3);
  const truth = yaoAxioms.getYaoPositionAxiom(3);
  assert.equal(NAJIA.getYaoGanzhi(guaId, 4).ganzhi, '壬午', '前提: 讼四爻纳壬午');
  assert.equal(v.yaoWuxing, '火', '四爻五行应取纳甲午火');
  assert.equal(v.yaoName, truth.yaoName_yang, '四爻名对不上爻位表(讼上卦乾全阳 ⇒ 四爻是阳爻)');
  assert.equal(NAJIA.getYaoGanzhi(guaId, 5).ganzhi, '壬申', '前提: 讼五爻纳壬申');
  // 反例钉死: 九五(idx4) 的值长什么样 —— 错位时会给的就是这些
  const wrong = hv.getYaoVector(guaId, 4);
  assert.notEqual(v.yaoWuxing, wrong.yaoWuxing, '四爻与九五五行相同, 这条断言就测不出错位了');
  assert.notEqual(v.liuQin, wrong.liuQin, '四爻与九五六亲相同, 这条断言就测不出错位了');
});

test('★ 行为: 上爻不许静默变空 (越界 → 整条链静默, 最像「没数据」)', () => {
  // 用**装得出纳甲**的卦(乾), 这样「空」只可能来自下标越界, 不会跟
  // 「真源没有」混淆 —— 这两种空长得一模一样, 必须靠选样本分开。
  const v = hv.getYaoVector(1, 5);   // 上爻 = 0-based idx5
  assert.ok(v, '上爻取不到向量');
  assert.ok(v.yaoWuxing, '上爻五行为空 —— 静默丢数据');
  assert.ok(v.liuQin, '上爻六亲为空');
  assert.ok(v.positionNature, '上爻爻位性质为空');
});

test('★「真源没有」的空与「下标越界取空」必须能分开', () => {
  // ⚠️ 第 41 批补齐八卦地支后, 中孚(61 = 兑下巽上)**装得出了** ——
  //   真实数据上「诚实的空」已经走不到, 所以这条断言改成**注入缺口**来验。
  //   ⚠️ 判据该钉的是「两种空能分开」这个**性质**, 不是「恰好现在哪个卦是空的」。
  const holedNajia = {
    getYaoGanzhi: (id, pos) => NAJIA.getYaoGanzhiWithTable({}, id, pos),
  };
  const v = hv.getYaoVector(61, 5, { najia: holedNajia });
  assert.ok(v, '中孚上爻取不到向量');
  assert.equal(v.yaoWuxing, '', '装不出纳甲时, 爻五行应为「诚实的空」');
  assert.equal(v.liuQin, null, '装不出纳甲时, 六亲应为 null');
  // 而「诚实的空」必须带着原因一起走 —— 原因在纳甲层, 不是在向量层
  const gz = NAJIA.getYaoGanzhiWithTable({}, 61, 6);
  assert.equal(gz.ok, false, '注入空表后中孚上爻应装不出纳甲');
  assert.ok(gz.error && gz.error.message.length > 5, '装不出必须带原因');
  // 对照: 越界是**另一个**机制, 且返回 null(不是空字段)
  assert.equal(hv.getYaoVector(61, 6), null, '越界返回 null, 与「诚实的空」形态不同');
  // 对照2: 真数据下中孚**装得出**(补齐后的事实), 空的机制确实是「有据可查」,
  //   不是「碰巧空」—— 这条把两种机制钉死在不同的卦上, 防止它们被混成一种。
  const real = hv.getYaoVector(61, 5);
  assert.ok(real && real.yaoWuxing, '真数据下中孚上爻应装得出五行');
});

// ============================================================
// 四、负例: 守卫必须咬人
// ============================================================

test('★ 负例: 把换算改回 movingYao, 必须报错 (守卫不许是永真)', () => {
  const fs2 = require('fs');
  const os = require('os');
  const sp = require('child_process').spawnSync;
  const SELF = path.resolve(__filename);

  // ⚠️ 2026-10-22: 原来这个负例**直接改生产源文件** (apps/core/modules/gua_engine.js):
  //   把换算拆坏 → 跑子进程 → 再还原。而 `node --test` 是**多文件并行**跑的 ——
  //   那个窗口里, 别的测试文件正好 require gua_engine.js, 读到的是**被拆坏的版本**。
  //   现场 (2026-10-22 全量回归实测): 隔壁文件报出「初九 配 木」这种
  //   **看着像真 bug** 的错 —— 单跑绿、全量红、复现不了, 差点当成生产 bug 去改。
  //   教训: **故障注入不许碰共享文件** —— 进程内的隔离不算隔离。
  //   现在改成: 把 64i/ + 涉及的两个模块复制到临时目录, 在**副本**上拆坏, 副本里跑断言。
  const tmp = fs2.mkdtempSync(path.join(os.tmpdir(), 'pangu-yao-idx-'));
  try {
    fs2.cpSync(path.join(CORE, '64i'), path.join(tmp, '64i'), { recursive: true });
    fs2.mkdirSync(path.join(tmp, 'modules'), { recursive: true });
    fs2.mkdirSync(path.join(tmp, 'tests'), { recursive: true });
    for (const f of ['gua_engine.js', 'yao_vector_consistency.js']) {
      const src = path.join(CORE, 'modules', f);
      if (fs2.existsSync(src)) fs2.cpSync(src, path.join(tmp, 'modules', f));
    }
    fs2.cpSync(SELF, path.join(tmp, 'tests', path.basename(SELF)));

    const GE = path.join(tmp, 'modules', 'gua_engine.js');
    const orig = fs2.readFileSync(GE, 'utf8');
    const NEEDLE = 'const yaoIdx0 = movingYao - 1;';
    assert.ok(orig.includes(NEEDLE), '换算点写法变了, 先核 gua_engine.js');
    // 拆坏: 让换算**看起来还在**, 但失效 (传原值)
    fs2.writeFileSync(GE, orig.replace(NEEDLE, 'const yaoIdx0 = movingYao;'), 'utf8');
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;   // 子进程要真产 TAP, 见踩坑日志
    const r = sp(process.execPath, ['--test', '--test-name-pattern', '接线',
      path.join(tmp, 'tests', path.basename(SELF))],
      { encoding: 'utf8', env });
    const out = (r.stdout || '') + (r.stderr || '');
    assert.ok(/^not ok /m.test(out),
      '把换算拆坏后守卫没咬人 —— 接线断言失效了');
  } finally {
    fs2.rmSync(tmp, { recursive: true, force: true });
  }
});
