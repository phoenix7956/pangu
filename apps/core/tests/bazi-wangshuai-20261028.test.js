// tests/bazi-wangshuai-20261028.test.js — 八字旺衰/喜用神的**判据守卫**
//
// 为什么有这条守卫 (第 130 批, 2026-10-28):
//   老板发了一张盘古的截图, 问「为什么你的喜用是反的?」。盘古自己查出来:
//   「第218行把月令本气"甲"当作五行, 与日主"木"比较, 旺、弱判断全部失效,
//     status 被固定成"中和"」「第270行因此走错分支, 把日主木列为喜用,
//     又把盘中已有的火、土、金全列为忌用」。
//
//   根因: `ZHI_BENQI` 存的是**本气天干**(寅→'甲'), 旧代码拿它跟**五行**('木')比大小
//   ⇒ 天干字跟五行名永远不相等 ⇒ 旺/弱/中和三个分支一个都进不去 ⇒
//   status 恒为「中和」, 喜用恒为 [日主五行], 忌神恒为「其余全部」。
//   实跑后果: 乙卯 戊寅 乙酉 辛巳(乙木) → 引擎吐「喜用木、忌火土金」,
//   而课程答案是「身强, 喜火土金, 忌木水」—— **正好倒过来**。
//
// 判据真源: <course-source>/<course-file>
//   三要素 (L57-88) / 等级表 (L97-112) / 扶抑法 (L133-164)
//
// 这条守卫钉的是**行为**(算出来的旺衰/喜忌对不对), 不是实现形状 ——
// 下次谁把引擎改回「拿天干字比五行」, 这里当场红。

'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');

const PY = '/usr/bin/python3';
const SCRIPT = path.resolve(__dirname, '..', 'modules', 'tools', 'bazi', 'bazi_calc.py');
const BS = require(path.resolve(__dirname, '..', 'modules', 'bazi_strength.js'));

const WUXING = ['金', '木', '水', '火', '土'];
const GRADES = ['极强', '强', '偏强', '均衡', '偏弱', '弱', '极弱'];

function calc(args) {
  const out = execFileSync(PY, [SCRIPT, ...args.map(String)], { encoding: 'utf-8', maxBuffer: 1e8 });
  return JSON.parse(out);
}

let pass = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ok  ' + name);
  } catch (e) {
    console.error('  FAIL ' + name + '\n       ' + (e && e.message));
    process.exitCode = 1;
  }
}

console.log('\n--- 老板那张盘: 乙卯 戊寅 乙酉 庚辰 (1975-02-08 10:05 四川成都 男) ---');

const BOSS = calc([1975, 2, 8, 10, 5, 'male', '--city', '成都']);

t('四柱没变(别把修旺衰改成改排盘)', () => {
  // 2026-10-31 第 176 批: 真太阳时补了**均时差**, 这张盘的时柱因此从辛巳变成庚辰。
  //   这不是排盘被改坏, 是补上了一个本来就该有的修正 —— 账在这儿:
  //     成都经度 104.07°E  → 经度修正 (104.07-120)×4 = **-63.7 分**
  //     1975-02-08 均时差  → **-14.4 分** (2 月均时差约 -14 分)
  //     钟表 10:05 → 10:05 - 78.1 分 = **8:46** ⇒ 辰时 ⇒ 乙日辰时 = **庚辰**
  //   旧算法(只补经度修正, 漏了均时差): 10:05 - 63.7 = 9:01 ⇒ 巳时 ⇒ 辛巳。
  //   ⚠ 均时差的口径不是我发明的:
  //     2026-10-29 的 review-bazi-eval §2.4 已经把「叫真太阳时, 算的是**平**太阳时」
  //     定性成缺陷, 写明「均时差最大 ±16 分, 正好够把时柱顶到隔壁时辰」。
  //     第 176 批按那条结论补了均时差, 并用老板上课 app 反证:
  //       上海 1986-12-17 16:20 → app 真太阳时 **16:29**
  //       = 经度修正(+5.88, 宝山 121.47°E) + 均时差(+3.25, 12/17) = +9.13 分 ⇒ 16:29 ✔
  //     ⇒ app 的口径 = 经度修正 + 均时差, 与本引擎现在一致。
  //   ⇒ 「辛巳」是**漏了均时差**时的旧值, 这条断言跟着盘面更新。
  //   ⚠ 2026-10-31 老板澄清: 「不是没有修正, 是没有给区, 那是为了做题」
  //     —— app 那道成都题**没填到区**, 经度精度只到市级; 上海那道题给了
  //     「上海市宝山区」(有区), 才谈得上分毫不差。
  //     ⇒ **不许拿 app 那道没给区的题当口径基准**。盘古给到区 = 更精确,
  //       跟 app 不冲突: 成都各区经度差 < 1.5 分, 给不给区都落在辰时。
  assert.deepStrictEqual(BOSS.pillars, {
    年柱: '乙卯', 月柱: '戊寅', 日柱: '乙酉', 时柱: '庚辰',
  });
  assert.strictEqual(BOSS.day_master, '乙');
  assert.strictEqual(BOSS.day_master_wuxing, '木');
});

t('月令: 本气天干与月支五行是两个东西, 不许混用', () => {
  assert.strictEqual(BOSS.month_benqi, '甲', '月令本气天干仍是甲');
  assert.strictEqual(BOSS.month_wuxing, '木', '月支五行是木');
});

t('旺衰 = 强 (得令+得地+得势), 不是「中和」', () => {
  assert.strictEqual(BOSS.status, '旺');
  assert.strictEqual(BOSS.status_grade, '强');
  assert.strictEqual(BOSS.status_detail['三要素'], '得令+得地+得势');
  assert.strictEqual(BOSS.status_detail['得令'].成立, true);
  assert.strictEqual(BOSS.status_detail['得地'].成立, true);
  assert.strictEqual(BOSS.status_detail['得势'].成立, true);
});

t('喜用 = 火、土、金; 忌 = 水、木 (课程答案)', () => {
  assert.deepStrictEqual(BOSS.xi_yong.slice().sort(), ['土', '火', '金'].sort());
  assert.deepStrictEqual(BOSS.ji_shell.slice().sort(), ['木', '水'].sort());
  // 「命局中已出现」这栏随盘面走: 旧盘时柱是辛巳(巳本气=火) ⇒ 火已出现;
  // 新盘时柱是庚辰, 火只剩寅里**藏干**的丙(0.5), 而"已出现"只认天干+地支本气
  // ⇒ 火算未出现。喜用本身(火土金)没变, 变的只是"优先用命局里已有的那部分"。
  assert.deepStrictEqual(BOSS.xi_yong_present.slice().sort(), ['土', '金'].sort());
  assert.deepStrictEqual(BOSS.ji_shell_present, ['木']);
});

t('回归守卫: 旧 bug 的答案(喜用木/忌火土金)不许再出现', () => {
  assert.notDeepStrictEqual(BOSS.xi_yong.slice().sort(), ['木']);
  assert.notDeepStrictEqual(BOSS.ji_shell.slice().sort(), ['火', '土', '金']);
});

t('财星 = 我克者(耗) = 土', () => {
  assert.deepStrictEqual(BOSS.cai_xing, ['土']);
});

console.log('\n--- 扶抑法方向(课程 L133-164): 身强喜抑、身弱喜扶 ---');

const SHENG = { '木': '火', '火': '土', '土': '金', '金': '水', '水': '木' };
const KE = { '木': '土', '土': '水', '水': '火', '火': '金', '金': '木' };

// 我视角的五个位置
function positions(dm) {
  return {
    生: Object.keys(SHENG).find((w) => SHENG[w] === dm),   // 生我者
    比: dm,                                                // 同我者
    克: Object.keys(KE).find((w) => KE[w] === dm),         // 克我者
    泄: SHENG[dm],                                         // 我生者
    耗: KE[dm],                                            // 我克者
  };
}

const STRONG = calc([1935, 2, 20, 10, 30, 'male', '--city', '成都']);   // 乙亥 戊寅 丁卯 乙巳 / 火 / 偏强
const WEAK = calc([1935, 2, 20, 4, 30, 'male', '--city', '成都']);     // 乙亥 戊寅 丁卯 壬寅 / 火 / 偏弱
const BAL = calc([1936, 5, 5, 10, 30, 'male', '--city', '成都']);      // 丙子 壬辰 丁亥 乙巳 / 火 / 均衡

t('身强: 喜用 = 泄+耗+克, 忌 = 生+比', () => {
  assert.strictEqual(STRONG.status, '旺');
  const p = positions(STRONG.day_master_wuxing);
  assert.deepStrictEqual(STRONG.xi_yong.slice().sort(), [p.泄, p.耗, p.克].sort());
  assert.deepStrictEqual(STRONG.ji_shell.slice().sort(), [p.生, p.比].sort());
});

t('身弱: 喜用 = 生+比, 忌 = 克+泄+耗', () => {
  assert.strictEqual(WEAK.status, '弱');
  const p = positions(WEAK.day_master_wuxing);
  assert.deepStrictEqual(WEAK.xi_yong.slice().sort(), [p.生, p.比].sort());
  assert.deepStrictEqual(WEAK.ji_shell.slice().sort(), [p.克, p.泄, p.耗].sort());
});

t('扶抑法不许出现「生我者当喜用」这种反向答案', () => {
  const p = positions(STRONG.day_master_wuxing);
  assert.ok(!STRONG.xi_yong.includes(p.生), '身强时生我者(印)不能当喜用');
  assert.ok(!STRONG.xi_yong.includes(p.比), '身强时同我者(比劫)不能当喜用');
  const q = positions(WEAK.day_master_wuxing);
  assert.ok(!WEAK.xi_yong.includes(q.克), '身弱时克我者不能当喜用');
  assert.ok(!WEAK.xi_yong.includes(q.泄), '身弱时我生者(泄)不能当喜用');
});

console.log('\n--- 等级表 / 三要素 / 均衡口径 ---');

t('等级取值合法, 且与 status 三值映射正确', () => {
  const MAP = {
    极强: '旺', 强: '旺', 偏强: '旺',
    均衡: '中和',
    偏弱: '弱', 弱: '弱', 极弱: '弱',
  };
  for (const r of [BOSS, STRONG, WEAK, BAL]) {
    assert.ok(GRADES.includes(r.status_grade), '等级非法: ' + r.status_grade);
    assert.strictEqual(MAP[r.status_grade], r.status, '等级↔status 不一致: ' + r.status_grade);
  }
});

t('三要素组合出自课程等级表(8 种组合)', () => {
  const LEGAL = new Set([
    '得令+得地+得势', '得令+得地+不得势', '得令+不得地+得势', '得令+不得地+不得势',
    '不得令+得地+得势', '不得令+得地+不得势', '不得令+不得地+得势', '不得令+不得地+不得势',
  ]);
  for (const r of [BOSS, STRONG, WEAK, BAL]) {
    assert.ok(LEGAL.has(r.status_detail['三要素']), '三要素组合非法: ' + r.status_detail['三要素']);
  }
});

t('均衡盘: status=中和, 喜用/忌神空, 理由明说「不臆造」', () => {
  assert.strictEqual(BAL.status, '中和');
  assert.strictEqual(BAL.status_grade, '均衡');
  assert.deepStrictEqual(BAL.xi_yong, []);
  assert.deepStrictEqual(BAL.ji_shell, []);
  assert.ok(/不臆造/.test(BAL.xi_yong_reason), '均衡盘必须写明不臆造喜忌');
});

t('旺/弱盘不许出现空喜忌(除均衡外都要给扶抑取向)', () => {
  for (const r of [BOSS, STRONG, WEAK]) {
    assert.ok(r.xi_yong.length > 0, '非均衡盘必须有喜用');
    assert.ok(r.ji_shell.length > 0, '非均衡盘必须有忌神');
  }
});

t('喜忌里出现的必须是五行名, 不许是天干字', () => {
  for (const r of [BOSS, STRONG, WEAK, BAL]) {
    for (const w of r.xi_yong.concat(r.ji_shell)) {
      assert.ok(WUXING.includes(w), '喜忌里混进了非五行名: ' + w);
    }
  }
});

console.log('\n--- 两层一致(格局层 vs 逐格层) + 给模型看的文案 ---');

t('逐格层的得令判定与格局层的得令判定必须一致', () => {
  for (const r of [BOSS, STRONG, WEAK, BAL]) {
    const j = BS.judgeFromChart(r);
    assert.ok(j, 'judgeFromChart 返回空');
    assert.strictEqual(
      j.month.deLing.deLing,
      r.status_detail['得令'].成立,
      '得令判定两层不一致: ' + JSON.stringify(r.pillars));
  }
});

t('逐格层透传的喜忌与格局层一致(不许两套口径)', () => {
  for (const r of [BOSS, STRONG, WEAK, BAL]) {
    const j = BS.judgeFromChart(r);
    assert.deepStrictEqual(j.xiYong, r.xi_yong);
    assert.deepStrictEqual(j.jiShell, r.ji_shell);
  }
});

t('给模型看的结论含「旺衰: 旺(强)」/依据/喜用/忌', () => {
  const j = BS.judgeFromChart(BOSS);
  const s = BS.formatConclusion(j);
  assert.ok(/旺衰: 旺\(强\)/.test(s), '缺「旺衰: 旺(强)」: ' + s);
  assert.ok(s.includes('得令+得地+得势'), '缺三要素依据: ' + s);
  assert.ok(s.includes('喜用: 火、土、金'), '缺喜用: ' + s);
  assert.ok(s.includes('忌: 水、木'), '缺忌神: ' + s);
});

t('均衡盘的结论不编喜忌(不许出现空占位的「喜用:」)', () => {
  const s = BS.formatConclusion(BS.judgeFromChart(BAL));
  assert.ok(!/喜用:/.test(s), '均衡盘不该有喜用行: ' + s);
  assert.ok(!/^忌:/m.test(s), '均衡盘不该有忌神行: ' + s);
});

console.log('\n--- 源码形状守卫: 「天干字 vs 五行名」不许复发 ---');

function stripPyComments(src) {
  return src
    .split('\n')
    .map((line) => {
      // 去掉整行注释与行尾注释(粗略但足够: 判据只看 benqi / dm_wx 的比较形状)
      const out = [];
      let inStr = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inStr) {
          if (c === inStr && line[i - 1] !== '\\') inStr = null;
          out.push(c);
          continue;
        }
        if (c === '"' || c === "'") { inStr = c; out.push(c); continue; }
        if (c === '#') break;
        out.push(c);
      }
      return out.join('');
    })
    .join('\n');
}

t('bazi_calc.py 里不许拿月令天干字(benqi)去跟五行名比大小', () => {
  const src = stripPyComments(require('fs').readFileSync(SCRIPT, 'utf-8'));
  assert.ok(!/benqi\s*==\s*dm_wx/.test(src), '又出现了 benqi == dm_wx 的比较');
  assert.ok(!/KE_MAP\.get\(\s*benqi\s*\)/.test(src), '又用 KE_MAP 去查天干字');
  assert.ok(!/SHENG_MAP\.get\(\s*benqi\s*\)/.test(src), '又用 SHENG_MAP 去查天干字');
  assert.ok(!/dm_wx\s*==\s*benqi/.test(src), '又出现了 dm_wx == benqi 的比较');
});

t('bazi_calc.py 里旺衰判定必须用月令五行(month_wuxing)', () => {
  const src = stripPyComments(require('fs').readFileSync(SCRIPT, 'utf-8'));
  assert.ok(/month_wx\s*=\s*WUXING_GZ\[month_zhi\]/.test(src),
    '月令五行必须单独取(WUXING_GZ[month_zhi])');
  assert.ok(/_rel_from_self\(month_wx\)/.test(src),
    '得令判定必须基于月令五行, 不是本气天干');
});

t('旧字段不许被删(下游还在读 status / xi_yong / ji_shell / cai_xing)', () => {
  for (const k of ['status', 'status_reason', 'status_grade', 'status_detail',
    'xi_yong', 'ji_shell', 'xi_yong_present', 'ji_shell_present', 'cai_xing',
    'month_benqi', 'month_wuxing', 'wuxing_count_int']) {
    assert.ok(k in BOSS, '缺字段: ' + k);
  }
});

console.log('\n旺衰守卫: ' + pass + ' 项通过'
  + (process.exitCode ? ' —— 有失败项' : ' —— 全绿'));

