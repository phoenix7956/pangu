/**
 * 盘古 · 大象辞(象曰)三方对账构建器 (build_xiang_ci.js)
 *
 * 2026-10-23 第 70 批配套。作用: 把 64 卦大象辞**从三个源重新对账一遍**,
 * 落进 `64i/sources/xiang_ci_64.txt` —— 让切片是**可复算的**, 不是手抄的。
 *
 * ## 为什么要有这个脚本 (而不是手抄)
 *
 *   手抄 = 转录错误 + 不可复现。改一个字没人知道原文是不是那样。
 *   这跟 `extract_provenance_sources.js` 是同一个道理, 只是源从「本地文件按行抽」
 * 变成「三个外部源按文字层对账」。
 *
 * ## 三个源
 *
 *   A = npm `iching-shifa@1.8.0`   —— 《周易本义》系。每个卦对象里 `title: "象曰：…"`。
 *   B = github `qingshano/yijing-data` —— 每卦一份 json, 字段 `xiangZhuan`。
 *   C = 本机《周易》原文切片(上经 30 卦 + 咸卦) —— 只覆盖 31 卦, 覆盖不满 64。
 *
 * ## ⚠️ 为什么「三方对账」这个动作本身是必需的 (本批真踩过)
 *
 *   源 A 把**否卦**的大象辞贴成了**屯卦**的「云雷，屯，君子以经纶」——
 *   整句通顺、标点正常、任何「读起来顺不顺」的检查都过得了。
 *   只有一条判据能逮住它: **开头必须含本卦名**。
 *   ⇒ 这条判据写进了 `64i/provenance.js` 的 `checkXiangCiSourceCoverage`,
 *     也在 `tests/xiang-ci-20261023.test.js` 里, 两处都要在。
 *
 * ## 对账口径 (三步, 顺序不能换)
 *
 *   ① **文字层**比对: 去标点 + 异体字归一(懼→惧, 遯→遁)。
 *      ⚠️ 必须去标点再比 —— 标点差异会把「真差异」淹没(50/64 vs 54/64 的差别
 *      就是这么来的: 按标点比, 一致率只有 50)。
 *   ② 三方一致 ⇒ 取共识。
 *   ③ 仍不一致 ⇒ **按「首句必含本卦名」筛掉贴错卦的一源**;
 *      筛完还平票 ⇒ 人工裁决(裁决结果硬编码在 `CANON` 正读表 + `REASONS` 理由表里)。
 *
 * ## 用法
 *
 *   node scripts/build_xiang_ci.js             # 对账并写切片
 *   node scripts/build_xiang_ci.js --check     # 校验: 现有切片是否仍与三方可对出来的结果一致
 *   node scripts/build_xiang_ci.js --offline   # 不联网: 只用本机已有的源缓存
 *
 * ⚠️ `--check` 是**真守卫**: 三方数据变了(上游改了/贴错卦了) ⇒ 报出来。
 *   没有它, 切片会安静地变成「一份没人核过的旧拷贝」。
 *
 * ⚠️ 本脚本**只做机械对账**, 不做「润色」。汉字零改动 ——
 *   清洗只动标点/引号/书名号, 且清洗前后有断言(见 `clean()`)。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CORE_ROOT = path.resolve(__dirname, '..');
const OUT_FILE = path.join(CORE_ROOT, '64i', 'sources', 'xiang_ci_64.txt');
// ⚠️ 缓存**不放 64i 目录里** —— 出处守卫 discoverI64Modules() 会扫
//   64i 下的每个 .js 文件, 缓存里的 .js 会被当成「64i 模块」⇒ 报「未登记出处」。
//   ⇒ 挪到 64i 之外(apps/core/.cache/), 两个问题一起消。
const CACHE_DIR = path.join(CORE_ROOT, '.cache', 'xiang_ci');

// ── 本机《周易》原文切片(源 C) ─────────────────────────────────────
//   只覆盖上经 30 卦 + 咸卦 —— 本机没下经 33 卦的原文。
//   这不是缺陷: 源 C 的作用是「第三票」, 不是唯一真源。
const LOCAL_ORIGIN = '<course-source>/<course-file>'
  + '完整版《易经》全文、全文翻译（上）.txt';

// 语料根目录 —— 原始典籍不在本仓, 由使用者自备。
//   PANGU_CORPUS_ROOT=/path/to/易经 node scripts/build_xiang_ci.js
// LOCAL_ORIGIN 存的是**语料库相对路径**, 不是任何人的本机绝对路径。
const CORPUS_ROOT = (process.env.PANGU_CORPUS_ROOT || '').trim();
const LOCAL_ORIGIN_ABS = CORPUS_ROOT
  ? path.join(CORPUS_ROOT, LOCAL_ORIGIN)
  : null;

// ── 源 A / 源 B 的下载地址 ─────────────────────────────────────────
const NPM_PKG = 'iching-shifa@1.8.0';
const GH_REPO = 'qingshano/yijing-data';

/**
 * 人工裁决表 —— 剩下平票的, 由人定稿。
 * 每条必须写清「为什么裁这一份」, 不许只留结果。
 * ⚠️ key 是**卦名**, value 是裁决后的正读原文。
 */
/**
 * 正读表 —— 64 卦大象辞的**人工定稿**结果。
 *
 * ## 为什么正读是「写出来的」而不是「算出来的」
 *
 *   三方对账能定出「哪些源一致、哪些有异文」, 但**定不出标点**:
 *   源 A 作「云雷，屯，君子以经纶。」, 源 B 作「云，雷，屯；君子以经纶。」,
 *   源 C 作「云雷屯，君子以经纶。」—— 三家标点三种样。
 *   ⇒ 若让脚本按「多数票原文」产出, 标点会随源变动而漂, 切片就不稳定。
 *   ⇒ 正读必须是**人工定稿的规范形式**, 脚本只负责**验证**它:
 *       ① 每条正读至少被**一个源**在文字层支持(否则 = 编的, 报错);
 *       ② 各源的全部**非共识读法**登记为异文(逐条带源与理由);
 *       ③ 「首句必含本卦名」逐条检查(专治贴错卦)。
 *
 *   ⇒ 这张表是**裁决记录**, 不是抄来的数据。
 *     每一行都能在下面三源里找到支持, 差异处都在 VARIANT_LEDGER_XIANG 里登记。
 */
const CANON = {
  '乾': '天行健，君子以自强不息。',
  '坤': '地势坤，君子以厚德载物。',
  '屯': '云雷屯，君子以经纶。',
  '蒙': '山下出泉，蒙；君子以果行育德。',
  '需': '云上于天，需；君子以饮食宴乐。',
  '讼': '天与水违行，讼；君子以作事谋始。',
  '师': '地中有水，师；君子以容民畜众。',
  '比': '地上有水，比；先王以建万国，亲诸侯。',
  '小畜': '风行天上，小畜；君子以懿文德。',
  '履': '上天下泽，履，君子以辨上下，定民志。',
  '泰': '天地交，泰；后以财成天地之道，辅相天地之宜，以左右民。',
  '否': '天地不交，否；君子以俭德辟难，不可荣以禄。',
  '同人': '天与火，同人，君子以类族辨物。',
  '大有': '火在天上，大有；君子以遏恶扬善，顺天休命。',
  '谦': '地中有山，谦。君子以裒多益寡，称物平施。',
  '豫': '雷出地奋，豫。先王以作乐崇德，殷荐之上帝，以配祖考。',
  '随': '泽中有雷，随。君子以向晦入宴息。',
  '蛊': '山下有风，蛊；君子以振民育德。',
  '临': '泽上有地，临；君子以教思无穷，容保民无疆。',
  '观': '风行地上，观；先王以省方观民设教。',
  '噬嗑': '雷电噬嗑，先王以明罚敕法。',
  '贲': '山下有火，贲；君子以明庶政，无敢折狱。',
  '剥': '山附于地，剥；上以厚下安宅。',
  '复': '雷在地中，复；先王以至日闭关，商旅不行，后不省方。',
  '无妄': '天下雷行，物与无妄；先王以茂对时育万物。',
  '大畜': '天在山中，大畜；君子以多识前言往行，以畜其德。',
  '颐': '山下有雷，颐。君子以慎言语，节饮食。',
  '大过': '泽灭木，大过；君子以独立不惧，遯世无闷。',
  '坎': '水洊至，习坎；君子以常德行，习教事。',
  '离': '明两作，离；大人以继明照于四方。',
  '咸': '山上有泽，咸；君子以虚受人。',
  '恒': '雷风，恒，君子以立不易方。',
  '遁': '天下有山，遁，君子以远小人，不恶而严。',
  '大壮': '雷在天上，大壮，君子以非礼弗履。',
  '晋': '明出地上，晋，君子以自昭明德。',
  '明夷': '明入地中，明夷，君子以莅众，用晦而明。',
  '家人': '风自火出，家人。君子以言有物而行有恒。',
  '睽': '上火下泽，睽，君子以同而异。',
  '蹇': '山上有水，蹇，君子以反身修德。',
  '解': '雷雨作，解，君子以赦过宥罪。',
  '损': '山下有泽，损。君子以惩忿窒欲。',
  '益': '风雷，益。君子以见善则迁，有过则改。',
  '夬': '泽上于天，夬，君子以施禄及下，居德则忌。',
  '姤': '天下有风，姤；后以施命诰四方。',
  '萃': '泽上于地，萃。君子以除戎器，戒不虞。',
  '升': '地中生木，升。君子以顺德，积小以高大。',
  '困': '泽无水，困。君子以致命遂志。',
  '井': '木上有水，井。君子以劳民劝相。',
  '革': '泽中有火，革。君子以治历，明时。',
  '鼎': '木上有火，鼎。君子以正位凝命。',
  '震': '洊雷震。君子以恐惧修省。',
  '艮': '兼山，艮。君子以思不出其位。',
  '渐': '山上有木，渐。君子以居贤德善俗。',
  '归妹': '泽上有雷，归妹，君子以永终知敝。',
  '丰': '雷电皆至，丰。君子以折狱致刑。',
  '旅': '山上有火，旅。君子以明慎用刑，而不留狱。',
  '巽': '随风，巽。君子以申命行事。',
  '兑': '丽泽，兑，君子以朋友讲习。',
  '涣': '风行水上，涣，先王以享于帝，立庙。',
  '节': '泽上有水，节。君子以制数度，议德行。',
  '中孚': '泽上有风，中孚。君子以议狱缓死。',
  '小过': '山上有雷，小过。君子以行过乎恭，丧过乎哀，用过乎俭。',
  '既济': '水在火上，既济。君子以思患而豫防之。',
  '未济': '火在水上，未济。君子以慎辨物居方。',
};

/**
 * 逐卦的裁决理由 —— 只写**需要解释的那些**, 其余照共识走。
 * key 是卦名, value 是理由。
 */
const REASONS = {
  履: '源 B 作「安民志」, 源 C 作「辩上下」, 源 A 作「辨上下」。'
    + '「辨上下, 定民志」是通行读法(定民志 与「民」相关, 「安民志」倒不常说); '
    + '「辩/辨」在原文里是「辨」(辨别)。⇒ 取「辨上下, 定民志」。',
  泰: '源 A/B 作「天地交泰」+「财（裁）」, 源 C 作「天地交，泰」。'
    + '通行本是「天地交，泰」, 「后以财成天地之道」——「财」通「裁」(裁成), '
    + '正文用「财」不用「裁」, 且句首「泰」单列。⇒ 取「天地交，泰；后以财成天地之道…」。',
  否: '源 A 把这卦的象辞**贴成了屯卦的**(开头不含「否」)⇒ 直接出局。'
    + '源 B/C 一致 ⇒ 取「天地不交，否」。',
  大有: '源 B 作「竭恶」, 源 A/C 作「遏恶」。「遏恶扬善」是通行读法 ⇒ 取 A/C。',
  随: '源 B 里那个字是全角空格(不是汉字)⇒ 判为异文, 取 A 的「向晦」。',
  噬嗑: '源 C 贴错(「雷电，噬磕」开头不含卦名)且有讹字(噬嗑→噬磕, 敕法→赤法)⇒ 出局, 取 A/B。',
  贲: '源 A 作「庶攻」(讹字, 应作「庶政」)⇒ 判为异文, 取 B/C 的「明庶政」。',
  剥: '源 B 作「山附地上」+「安宅」, 源 A/C 作「山附于地」+「安宅」。'
    + '「山附于地」是通行读法 ⇒ 取 A/C。',
  颐: '源 C 脱了卦名(「山下有雷，君子以…」)⇒ 出局, 取 A/B 的「山下有雷，颐」。',
  离: '源 A 作「照乎四方」, 源 B/C 作「照于四方」。「照乎」不通 ⇒ 取 B/C。',
  大壮: '源 B 作「非礼勿履」, 源 A/C 作「非礼弗履」。「弗履」是通行读法 ⇒ 取 A/C。',
  姤: '源 A 把卦名写成「始」(开头不含本卦名)⇒ 出局, 取 B/C 的「姤」。',
  震: '源 B 作「洊雷，震；君子以恐惧修身」, 源 A 作「洊雷震。君子以恐惧修省」。'
    + '两版并存(「修身」/「修省」都是通行读法), 本盘古取源 A 的「修省」——'
    + '源 A 是《周易本义》系, 与本仓爻辞底本同源。',
  既济: '源 B 作「预防之」, 源 A/C 作「豫防之」。「豫防」是通行读法(《左传》「豫防」)⇒ 取 A/C。',
  大过: '源 A 作「懼」「遁」, 源 B 作「惧」「遁」。这是**异体字**差异(懼=惧, 遯=遁), '
    + '不是实质分歧 ⇒ 归一后两边一致, 正读取简体形「惧」「遯」。',
};

// ── 文字层归一 ────────────────────────────────────────────────────
// 标点全去掉; 异体字归一(懼→惧, 遯→遁, 於→于)。
// ⚠️ 只在这里动汉字 —— 正读原文里保留原字, 归一只用于**比对**。
//
// ⚠️⚠️ 归一表里**必须包含排版记号**(引号/书名号)的处理, 否则会出两种错:
//   ① 源 C 的「“雷出地奋，豫。先王…」(带引号)会被当成与正读**不同**的读法
//      ⇒ 白白多出一条异文, 而且正读明明就在源 C 里, 却说「只有一源支持」。
//   ② 引号里的第一个字可能被判成「首句不含卦名」(源 C 的剥卦作
//      「山附于地，《剥》，…」—— 归一后开头是「山附于地剥」, 卦名在, 判据本该过)。
//   ⇒ 引号/书名号是**排版记号**, 不是文字, 归一层就去掉。
const PUNCT = /[，,。；;：:、！!？?「」『』“”‘’＂＇（）()《》〈〉【】"''—－\-·\s]/g;
// 异体/繁简归一 —— 只用于**比对**, 正读原文里保留原字。
//   於/于 是最要紧的一个: 源 B 用「云上於天」, 源 A 用「云上于天」,
//   不归一 ⇒ 两源在「需」「萃」两卦上被当成实质差异 ⇒ 明明有多数票也判平票。
//   ⚠️ 归一表**只收真异体字**, 不收「近义词替换」(如「豫防」vs「预防」——
//   那两个是**不同的字**, 属异文, 不属异体, 必须进台账)。
const ORTHO = { '懼': '惧', '遯': '遁', '無': '无', '爲': '为', '於': '于' };

function normText(s) {
  let t = String(s || '');
  for (const [from, to] of Object.entries(ORTHO)) t = t.split(from).join(to);
  return t.replace(PUNCT, '');
}

/**
 * 清洗正读文本: 只动标点/引号/书名号, 汉字零改动。
 * ⚠️ 断言在这里 —— 「清洗只动标点」是**许诺**, 必须验。
 */
function clean(raw) {
  const before = String(raw || '').trim();
  // 去掉**全部**排版记号(引号/书名号/方头括号) —— 它们是排版, 不是文字。
  //   ⚠️ 不只去首尾: 源 C 的剥卦是「山附于地，《剥》，上以厚下安宅。」——
  //     《剥》在**中间**。只去首尾的话, 《剥》会留在正文里, 而正读是「剥」。
  //   ⚠️ 这跟「汉字零改动」不冲突: 《》“”里没有汉字。
  //   ⚠️ 必须连 **ASCII 直引号**(") 一起去掉: 源 C 的小畜卦作
  //     「风行天上，"小畜"；…」—— 那是 0x22 直引号, 不是中文引号“”,
  //     只收中文引号的话它会漏过, 在异文表里留下一条假异文。
  let out = before.replace(/[「」『』“”‘’＂＇《》〈〉【】"]/g, '');
  out = out.replace(/^\s+|\s+$/g, '');
  // 英文标点 → 中文标点(只这几个, 不动汉字)
  out = out
    .replace(/,/g, '，')
    .replace(/;/g, '；')
    .replace(/:/g, '：')
    .replace(/\?/g, '？')
    .replace(/!/g, '！');
  // 断言: 清洗掉的所有字符必须**都不是汉字**
  const hanBefore = (before.match(/[\u4e00-\u9fff]/g) || []).join('');
  const hanAfter = (out.match(/[\u4e00-\u9fff]/g) || []).join('');
  if (hanBefore !== hanAfter) {
    throw new Error('清洗动了汉字 —— 违反「汉字零改动」: ' + hanBefore + ' vs ' + hanAfter);
  }
  return out;
}

/** 「开头含本卦名」判据 —— 本批最核心的一条。取前两个小句。 */
function headHasName(text, name) {
  if (name === '乾' || name === '坤') return true; // 「天行健」「地势坤」首句无卦名
  const head = String(text || '').split(/[，,。；;]/).slice(0, 2).join('');
  return head.indexOf(name) >= 0;
}

// ── 取源 ───────────────────────────────────────────────────────────

function cachePath(name) {
  return path.join(CACHE_DIR, name);
}

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

/** 源 A: npm iching-shifa@1.8.0 ⇒ 64 条「象曰：…」 */
function loadSourceA(offline) {
  const cached = cachePath('iching-shifa.tgz');
  if (!fs.existsSync(cached)) {
    if (offline) throw new Error('离线模式但没有源 A 缓存: ' + cached);
    ensureCacheDir();
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'xiangci-'));
    execFileSync('npm', ['pack', NPM_PKG], { cwd: tmp, stdio: 'pipe' });
    const tgz = fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'));
    if (!tgz) throw new Error('npm pack 没拿到 tgz');
    // npm pack 只出 tgz —— 得先解包才能拿到 dist/index.js。
    execFileSync('tar', ['xzf', tgz], { cwd: tmp, stdio: 'pipe' });
    fs.copyFileSync(path.join(tmp, 'package', 'dist', 'index.js'), cachePath('iching-shifa-index.js'));
    fs.copyFileSync(path.join(tmp, tgz), cached);
  }
  const idx = cachePath('iching-shifa-index.js');
  if (!fs.existsSync(idx)) throw new Error('源 A 缓存缺 index.js');
  const src = fs.readFileSync(idx, 'utf8');
  const at = src.indexOf('hexagrams = [');
  if (at < 0) throw new Error('源 A 里找不到 hexagrams 数组');
  const seg = src.slice(at);
  // 每卦一个顶层 `title: "象曰：…"` —— 爻象辞在 lines[].xiang 里, 不含「象曰：」前缀, 不会混进来。
  const titles = seg.match(/title: "象曰：[^"]*"/g) || [];
  if (titles.length !== 64) throw new Error('源 A 取到大象辞 ' + titles.length + ' 条(应 64)');
  // 卦序: 源 A 的数组顺序 = 文王序 1..64
  const out = [];
  titles.forEach((t, i) => {
    const raw = t.replace(/^title: "象曰：/, '').replace(/"$/, '');
    out.push({ id: i + 1, text: raw });
  });
  return out;
}

/** 源 B: github qingshano/yijing-data ⇒ 每卦一份 json 的 xiangZhuan */
function loadSourceB(offline) {
  const cached = cachePath('yijing-data-xiangzhuan.json');
  if (!fs.existsSync(cached)) {
    if (offline) throw new Error('离线模式但没有源 B 缓存: ' + cached);
    ensureCacheDir();
    // ⚠️ **一次拉整个 tarball**, 不逐个文件走 API:
    //   逐个文件 = 64 次请求 ⇒ 必撞 GitHub 匿名限流(60 次/小时),
    //   撞了之后 API 返回的是 `{message: "API rate limit exceeded"}`,
    //   而 `meta.content` 是 undefined —— 症状是 Buffer.from(undefined) 抛
    //   ERR_INVALID_ARG_TYPE, 看起来像"脚本写错", 实际是"被限流了"。
    //   ⇒ 一条请求拿全量, 之后纯本地读。
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'xiangci-b-'));
    const tarball = path.join(tmp, 'repo.tar.gz');
    execFileSync('curl', ['-sSL', '-m', '120', '-o', tarball,
      'https://codeload.github.com/' + GH_REPO + '/tar.gz/refs/heads/main'], { stdio: 'pipe' });
    execFileSync('tar', ['xzf', tarball, '-C', tmp], { stdio: 'pipe' });
    const root = fs.readdirSync(tmp).find((d) => /^yijing-data/.test(d));
    if (!root) throw new Error('源 B 的 tarball 解开没找到仓库目录');
    const hexDir = path.join(tmp, root, 'data', 'hexagrams');
    const out = {};
    for (let id = 1; id <= 64; id++) {
      const nn = String(id).padStart(2, '0');
      const j = JSON.parse(fs.readFileSync(path.join(hexDir, nn + '.json'), 'utf8'));
      out[nn] = { name: j.name, text: j.xiangZhuan || '' };
    }
    fs.writeFileSync(cached, JSON.stringify(out, null, 2));
  }
  return JSON.parse(fs.readFileSync(cached, 'utf8'));
}

/**
 * 源 C: 本机《周易》原文切片 —— 只覆盖上经 30 卦 + 咸卦。
 *
 * 文件结构 (实测):
 *   「  一卦：《乾卦》」/「  第三十一卦：《咸卦》」  ← 卦标题
 *   「  乾：元，亨，利，贞。」                        ← 卦辞
 *   「  【白话】…」                                   ← 白话
 *   「  《象》曰：天行健，君子以自强不息。」          ← **大象辞**
 *   「  【白话】…」                                   ← 白话
 *   「  初九，潜龙勿用。」                            ← 爻辞
 *   「  《象》曰：潜龙勿用，阳在下也。」              ← 爻象辞
 *
 * ⚠️ 大象辞与爻象辞**共用**「《象》曰：」标记 ⇒ 必须**按位置**切:
 *   每个卦里的**第一个**《象》曰 才是大象辞, 后面那些都是爻象辞。
 *   (按词切会切出 218 条 —— 爻象辞全都在里面。)
 */
function loadSourceC() {
  // 源 C 的**抽取结果**进缓存 —— 原始典籍不在仓里(版权+体量), 但对账必须
//   **可复算**: 别人 clone 下来跑 `--check --offline` 要能验出同一份切片。
  //   ⇒ 第一次 build 时把解析出来的「卦名 → 大象辞」缓存下来, 之后离线用缓存。
  //   (缓存不入库: .cache/ 是外部源缓存区; 切片本身 64i/sources/xiang_ci_64.txt 才是产物。)
  const cacheFile = cachePath('local-corpus-xiang.json');
  if (!LOCAL_ORIGIN_ABS || !fs.existsSync(LOCAL_ORIGIN_ABS)) {
    if (fs.existsSync(cacheFile)) {
      try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (_) { /* 缓存坏了 ⇒ 当没有 */ }
    }
    return null;   // 本机没这份底本 ⇒ 源 C 缺席(不编)
  }
  const raw = fs.readFileSync(LOCAL_ORIGIN_ABS, 'utf8');
  const out = {};
  const lines = raw.split('\n');
  let current = null;      // 当前卦名
  let seenXiang = false;   // 本卦取过象辞了吗(只取第一个)
  for (const line of lines) {
    // 卦标题: 「一卦：《乾卦》」/「第三十一卦：《咸卦》」
    //   ⚠️ 「第十三卦：《同人》」**没有**「卦」字(其余都有) ⇒ 那个「卦」是可选的。
    const titleM = line.match(/^\s*(?:第[一二三四五六七八九十百]+卦|一卦)\s*[：:]\s*[《【"]\s*([一-龥]{1,3})卦?/);
    if (titleM) {
      current = titleM[1];
      seenXiang = false;
      continue;
    }
    // 卦辞行: 「乾：元，亨，利，贞。」/「咸：亨，利贞；取女吉。」
    const ciM = line.match(/^\s*([一-龥]{1,3})\s*[：:]\s*\S/);
    if (ciM && !line.includes('曰') && !line.includes('【') && !line.includes('《')) {
      current = ciM[1];
      seenXiang = false;
      continue;
    }
    // 象辞**就在这一行**: 「《象》曰：天行健，君子以自强不息。」
    //   ⚠️ 大象辞与爻象辞**共用**「《象》曰：」标记 ⇒ 必须**按位置**切:
    //     每个卦里的**第一个**才是大象辞, 后面那些是爻象辞。
    //     (按词切会切出 218 条 —— 爻象辞全都在里面。)
    const xiangM = line.match(/^\s*(?:《象》曰|象曰)\s*[：:]\s*(.+?)\s*$/);
    if (xiangM) {
      // 只取本卦的**第一个**象辞 —— 后面那些是爻象辞。
      if (current !== null && !seenXiang) {
        // 底本里的卦名有时带「习」前缀(「习坎」= 坎卦), 而盘古内核里叫「坎」。
        //   ⇒ 归一一次, 不然源 C 在坎卦上永远是「缺席」, 白白浪费一票。
        const key = current === '习坎' ? '坎' : current;
        out[key] = xiangM[1];
        seenXiang = true;
      }
      continue;
    }
  }
  try {
    ensureCacheDir();
    fs.writeFileSync(cacheFile, JSON.stringify(out, null, 2), 'utf8');
  } catch (e) {
    console.warn('[xiang-ci] 源 C 缓存写不进去 (不影响本次对账):', e.message);
  }
  return out;
}

// ── 对账 ───────────────────────────────────────────────────────────

/**
 * 对账主流程。返回 { rows: [{id, name, text, sources, variant}], stats }。
 */
function reconcile(names, offline) {
  const A = loadSourceA(offline);
  const B = loadSourceB(offline);
  const C = loadSourceC() || {};

  const rows = [];
  const stats = {
    supportedBy3: 0, supportedBy2: 0, supportedBy1: 0,
    unsupported: 0, misfiled: 0, variants: 0,
    srcA: A.length, srcB: Object.keys(B).length, srcC: Object.keys(C).length,
  };
  const variants = [];
  const problems = [];

  names.forEach((g, idx) => {
    const id = idx + 1;
    const name = g.name;
    const canon = CANON[name];
    if (!canon) {
      problems.push('「' + name + '」没有正读 —— 停下来问人, 别自己编');
      return;
    }
    const cand = {
      A: A[idx] ? A[idx].text : '',
      B: B[String(id).padStart(2, '0')] ? B[String(id).padStart(2, '0')].text : '',
      C: C[name] || '',
    };
    const canonNorm = normText(canon);
    const supporters = [];

    for (const k of Object.keys(cand)) {
      if (!cand[k]) continue;
      const raw = cand[k];
      const n = normText(raw);
      // ① 贴错卦的一源: 开头**不含本卦名** ⇒ 出局(记异文, 不参与支持计数)
      if (!headHasName(raw, name)) {
        stats.misfiled++;
        variants.push({ id, name, src: k, text: clean(raw), reason: '首句不含本卦名' });
        continue;
      }
      // ② 文字层与正读一致 ⇒ 支持
      if (n === canonNorm) {
        supporters.push(k);
        continue;
      }
      // ③ 其余 ⇒ 非共识读法, 登记为异文
      stats.variants++;
      variants.push({ id, name, src: k, text: clean(raw), reason: '文字异' });
    }

    // ④ 每条正读至少要被**一个源**支持 —— 一个都不支持 = 这条是编的
    if (supporters.length === 0) {
      stats.unsupported++;
      problems.push('「' + name + '」的正读**没有任何源支持** —— 停下来问人, 别自己编: ' + canon);
    } else if (supporters.length >= 3) {
      stats.supportedBy3++;
    } else if (supporters.length === 2) {
      stats.supportedBy2++;
    } else {
      stats.supportedBy1++;
    }

    rows.push({
      id, name,
      text: canon,
      sources: supporters,
      reason: REASONS[name] || '',
    });
  });

  if (problems.length) {
    throw new Error('对账不通过:\n  ' + problems.join('\n  '));
  }
  return { rows, variants, stats };
}
// ── 切片文件 ───────────────────────────────────────────────────────

function renderSlice(rows, variants, stats) {
  const hex = require(path.join(CORE_ROOT, '64i', 'hexagrams.js'));
  const LIST = hex.HEXAGRAMS || hex;
  const lines = [];
  lines.push('# ===== PROVENANCE SLICE =====');
  lines.push('# source_id: xiang_ci_64');
  lines.push('# tier: classic');
  lines.push('# origin: 三方交叉对账(见下方 origin_detail)');
  lines.push('# sliced_at: 2026-10-23');
  lines.push('# extractor: scripts/build_xiang_ci.js (可复算; --check 可验)');
  lines.push('# origin_detail: 源A=npm iching-shifa@1.8.0 / 源B=github qingshano/yijing-data / '
    + '源C=本机《周易》原文切片(上经30卦+咸卦, 覆盖不满64)');
  lines.push('# note: 64 卦大象辞(象曰)正读本。正读=三方(本地《周易》原文切片 / npm iching-shifa / '
    + 'github yijing-data)文字层一致者取共识; 分歧者按「首句必含本卦名」筛掉贴错卦的一源, '
    + '仍平票者人工裁决并记 VARIANT_LEDGER_XIANG。异文原文见文件末尾。');
  lines.push('# 规则: 正文每行一条「卦序 卦名|大象辞」, 大象辞**逐字**取自三方对账结果, '
    + '清洗只动标点/引号/书名号(汉字零改动, 见 clean.js 断言)。');
  lines.push('# 对账统计: 三源支持 ' + stats.supportedBy3 + ' 卦, 两源支持 ' + stats.supportedBy2
    + ' 卦, 单源支持 ' + stats.supportedBy1 + ' 卦, 无源支持 ' + stats.unsupported
    + ' 卦; 筛掉贴错卦 ' + stats.misfiled + ' 处, 版本异文 ' + stats.variants
    + ' 条, 异文合计 ' + variants.length + ' 条。');
  lines.push('# 源覆盖: 源A ' + stats.srcA + '/64, 源B ' + stats.srcB + '/64, 源C ' + stats.srcC + '/64。');
  lines.push('# ===== /PROVENANCE SLICE =====');
  for (const r of rows) {
    lines.push(String(r.id).padStart(2, '0') + ' ' + r.name + '|' + r.text);
  }
  lines.push('');
  lines.push('## 异文 (三方对账中的非共识读法; 与 provenance.js 的 VARIANT_LEDGER_XIANG 一一对应)');
  for (const v of variants) {
    lines.push(String(v.id).padStart(2, '0') + ' ' + v.name + '|' + v.text + '|' + v.src + '|' + v.reason);
  }
  lines.push('');
  return lines.join('\n');
}

// ── 入口 ───────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const check = args.indexOf('--check') >= 0;
  const offline = args.indexOf('--offline') >= 0;

  const hex = require(path.join(CORE_ROOT, '64i', 'hexagrams.js'));
  const LIST = hex.HEXAGRAMS || hex;
  const names = LIST.map((g) => ({ id: g.id, name: g.name }));

  const { rows, variants, stats } = reconcile(names, offline);
  const slice = renderSlice(rows, variants, stats);

  if (check) {
    if (!fs.existsSync(OUT_FILE)) {
      console.error('✘ 切片不存在: ' + OUT_FILE);
      process.exit(1);
    }
    const cur = fs.readFileSync(OUT_FILE, 'utf8');
    if (cur === slice) {
      console.log('✔ 切片与三方对账结果一致 (' + rows.length + ' 卦, 异文 ' + variants.length + ' 条)');
      console.log('  统计: ' + JSON.stringify(stats));
      process.exit(0);
    }
    // 逐行报差异(别只说「不一致」)
    const a = cur.split('\n');
    const b = slice.split('\n');
    const diffs = [];
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i++) {
      if (a[i] !== b[i]) diffs.push('  行' + (i + 1) + ':\n    现有: ' + a[i] + '\n    实算: ' + b[i]);
      if (diffs.length >= 10) break;
    }
    console.error('✘ 切片与三方对账结果**不一致** —— 差 ' + diffs.length + ' 处以上:');
    diffs.forEach((d) => console.error(d));
    console.error('  统计: ' + JSON.stringify(stats));
    process.exit(1);
  }

  fs.writeFileSync(OUT_FILE, slice, 'utf8');
  console.log('✔ 已写切片: ' + OUT_FILE);
  console.log('  ' + rows.length + ' 卦, 异文 ' + variants.length + ' 条');
  console.log('  统计: ' + JSON.stringify(stats));
}

if (require.main === module) main();

module.exports = { normText, clean, headHasName, reconcile, renderSlice, CANON, REASONS };

