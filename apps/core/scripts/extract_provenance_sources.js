/**
 * 盘古 · 出处切片抽取器 (extract_provenance_sources.js)
 *
 * 2026-10-22 第 42 批配套。作用: 把外部典籍的**原文切片**按行号机械抽出来,
 * 落进 `64i/sources/`, 让「出处」变成**仓库内的、机器可验的文本**, 而不是
 * 注释里的一句「据《三命通会》」—— 注释 ≠ 隔离。
 *
 * 为什么要有这个脚本 (而不是手抄):
 *   手抄 = 转录错误 + 不可复现。改一个数字没人知道原文是不是那样。
 *   本脚本只做一件事: 按**起始行 + 结束行**机械取行, 一字不改。
 *   切片文件的头部写明「原文件绝对路径 / 起止行 / 抽取日期 / 切片说明」,
 *   任何人可以拿这三个数回到原文件核对。
 *
 * 用法:
 *   node scripts/extract_provenance_sources.js            # 抽取(写到 64i/sources/)
 *   node scripts/extract_provenance_sources.js --check    # 校验: 现有切片是否仍与原文一致
 *
 * ⚠️ --check 是**真守卫**: 原文文件被换掉/改动过 ⇒ 报出来。
 *   没有它, 切片会安静地变成「一份没人核过的旧拷贝」。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CORE_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(CORE_ROOT, '64i', 'sources');

/**
 * 语料根目录 —— 原始典籍**不在本仓**(版权 + 体量), 由使用者自备。
 *
 *   PANGU_CORPUS_ROOT=/path/to/易经 node scripts/extract_provenance_sources.js
 *
 * 仓里存的 origin 一律是**语料库相对路径**(如 `<course-source>/<course-file>`),
 * 不是任何人的本机绝对路径 —— 这样出处记录才能跟着仓走, 换台机器照样读得懂。
 */
const CORPUS_ROOT = (process.env.PANGU_CORPUS_ROOT || '').trim();

/** 把语料库相对路径解析成本机可读路径。语料不在本机 ⇒ 返回 null。 */
function corpusPath(rel) {
  if (!CORPUS_ROOT) return null;
  return path.join(CORPUS_ROOT, rel);
}

/**
 * 切片清单 —— 与 `64i/provenance.js` 的 SOURCES 表一一对应。
 * 改这里 ⇒ 记得同步改那边(那边有守卫查两边对得上)。
 */
const SLICES = [
  {
    id: 'smt_wuxing_sheng_ke',
    origin: '<course-source>/<course-file>',
    from: 55,
    to: 76,
    tier: 'classic',
    note: '《三命通会》「论五行生克」全段: 五行方位/季节/物性 + 相生相克全链 + 素问水生木。',
  },
  {
    id: 'smt_gan_wuhe',
    origin: '<course-source>/<course-file>',
    from: 1752,
    to: 1766,
    tier: 'classic',
    note: '《三命通会》「论十干合」: 阴阳相配为合 + 乙庚/丁壬/甲己/丙辛/戊癸五合逐对。',
  },
  {
    id: 'smt_ke_yinyang_force',
    origin: '<course-source>/<course-file>',
    from: 3822,
    to: 3827,
    tier: 'classic',
    // ⚠️ 为什么单开一份切片 (2026-10-22 第 47 批):
    //   1752-1766 那段讲的是**合**(异性为合 ⇒ 五合成立), 里面**没有**
    //   「异阴阳相克仍成立, 只是分正偏」这句话。
    //   而老板 10-22 原话「阳火用阴水可能就克不了」的正确读法恰恰要靠这段:
    //   3824-3825 行写「辛克甲, 庚克乙…是阴克阳, 阳克阴…故甲见辛为正官, 见庚为偏官」
    //   ⇒ **异性照样克**, 只是分正偏。
    //   两段合起来才是对的读法(1753 讲合的前提, 3825 讲克照样成立)。
    //   硬塞进 smt_gan_wuhe 会让「出处切片 = 原文连续段」这条纪律破掉。
    note: '《三命通会》论克分正偏: 辛克甲/庚克乙…是阴克阳阳克阴, 乃阴阳配合之理; 故甲见辛为正官, 见庚为偏官。',
  },
  {
    id: 'smt_liuchong',
    origin: '<course-source>/<course-file>',
    from: 2095,
    to: 2100,
    tier: 'classic',
    note: '《三命通会》「论冲击」: 地支取七位为冲, 子午对冲; 冲处相生/相克另有吉凶。',
  },
  {
    id: 'smt_gan_yinyang_pos',
    origin: '<course-source>/<course-file>',
    from: 2700,
    to: 2706,
    tier: 'classic',
    note: '《三命通会》十干正位: 卯=阳木之极/辰=阴木之极/午=阳火/未=阴火/酉=阳金/戌=阴金/子=阳水 —— 天干阴阳的分判依据。'
      + '⚠️ 本段末句「乙丁巳辛癸五阴干」的「巳」是原书排印讹字(应为己), 切片按原文保留, '
      + '引用时以「甲阳而乙阴也」与正位段为准。',
  },
  {
    id: 'smt_gan_yinyang_list',
    origin: '<course-source>/<course-file>',
    from: 5745,
    to: 5750,
    tier: 'classic',
    note: '《三命通会》「论阳刃」: 「惟甲丙戊庚壬五阳干有刃, 乙丁己辛癸五阴干无刃」'
      + '—— 五阳干/五阴干的**完整名单**(同书 2706 行那处把「己」排成了「巳」, 以本处为准)。',
  },
  {
    id: 'smt_gan_liuge',
    origin: '<course-source>/<course-file>',
    from: 3794,
    to: 3800,
    tier: 'classic',
    note: '《三命通会》「论古人立印食官财名义」: 甲阳而乙阴也; 生我者/我生者/克我者/我克者 四格原文。',
  },
  {
    id: 'smt_wangxiang_xiuqiu_si',
    origin: '<course-source>/<course-file>',
    from: 1500,
    to: 1511,
    tier: 'classic',
    // ⚠️ 为什么单开一份切片 (2026-10-23 第 66 批):
    //   纳甲搭桥要判「爻的纳甲地支五行在月令下是什么处境」, 用的是
    //   《三命通会》「论五行旺相休囚死并寄生十二宫」这一段:
    //     「盛德乘时曰旺。如春木旺, 旺则生火…故火相; 木用水生…故水休。
    //       火能克金…故金囚; 火能生土…所以春木克土则死。」
    //   ⇒ 相对月令五行: 同我=旺 / 我生者=相 / 生我者=休 / 克我者=囚 / 我克者=死。
    //   这一段此前**没有任何切片收录** ⇒ 判据有出处却查不到原文,
    //   出处守卫直接报红(引文不在源文件里)。补这份切片, 让判据可逐字核。
    //   ⚠️ 切片按原文保留: 原书排印里夹着「国学进阶课程之命书资料」这类页眉行,
    //   本切片**不**包含它(1500 行是标题行, 1511 行止于「水克火则火死」),
    //   中间页眉行(1504)按原文保留在切片内 —— 它是**原文的一部分**, 不许删。
    note: '《三命通会》「论五行旺相休囚死并寄生十二宫」: 旺相休囚死五态的完整判据'
      + ' (同我者旺/我生者相/生我者休/克我者囚/我克者死) + 四时五行旺相逐条 + 「见生旺者未必便作吉论」告诫。',
  },
  {
    id: 'course_yuanri_liuge',
    origin: '<course-source>/<course-file>',
    from: 40,
    to: 52,
    tier: 'course',
    note: '课程讲义「六格」定义: 生我者为生/同我者为比/克我者为克/我生者为泄/我克者为耗。',
  },
  {
    // 第 131 批 (2026-10-28): 旺衰/喜忌内核重写后要用的三段判据,
    //   此前仓里**只有 L40-52 的六格定义切片** —— 代码引用的
    //   「三要素 L57-88 / 等级表 L97-112 / 扶抑法 L133-164」全是**查不到原文**的,
    //   等于判据有出处却不可逐字核(注释里写着行号, 仓里却没这几行)。
    //   补这份切片, 让旺衰判据真的可核。
    id: 'course_yuanri_wangshuai',
    origin: '<course-source>/<course-file>',
    from: 53,
    to: 165,
    tier: 'course',
    sliced_at: '2026-10-28',
    note: '课程讲义「日元强弱与喜忌」: 三要素(得令/得地/得势) + 强弱等级表(极强~极弱) '
      + '+ 扶抑法取喜忌(身强喜克泄耗忌生比 / 身弱喜生比忌克泄耗 / 优先用命局已出现的喜用)。',
  },
  {
    id: 'course_zhi_chong_he',
    origin: '<course-source>/<course-file>',
    from: 1,
    to: 95,
    tier: 'digest',
    note: '第五课「刑冲合害」小妙招: 三会/三合/六合 + 六冲/三刑/六害/六破 全部组合。',
  },
  {
    id: 'digest_bagua_wuxing',
    origin: '<course-source>/<course-file>',
    from: 242,
    to: 254,
    tier: 'digest',
    note: '八卦五行对照表(卦/五行/阴阳/方向/季节) —— 8 卦公理层的五行+方位+季节出处。',
  },
  {
    id: 'course_bagua_fundamental',
    origin: '<course-source>/<course-file>',
    from: 1,
    to: 260,
    tier: 'course',
    note: '《八卦》1-18 行 = 基础: 八卦名单 + 阴阳(乾坎震艮阳/坤巽离兑阴) + 先天序(乾一兑二…坤八) '
      + '+ 先天方位(乾南兑东南离东震东北巽西南坎西艮西北坤北) + 后天方位(离南巽东南震东艮东北坎北乾西北兑西坤西南) '
      + '+ 八卦五行(乾兑金/艮坤土/坎水/离火/震巽木); 19-229 行 = 八卦逐一详述(方位/时间/家庭/人体/颜色/五味) '
      + '—— 八卦方位层与 8 卦公理层的主出处。',
  },
  {
    id: 'zhougui_shangjing',
    origin: '<course-source>/<course-file>《易经》全文、全文翻译（上）.txt',
    from: 1,
    to: 3868,
    tier: 'classic',
    // ⚠️ 2026-10-23 第 51 批: 这段 note 原来是「上经 30 卦(180 爻位)逐字可比,
    //   …已查出 12 处录入/白话串字」—— **三处都是错的**, 而且因为它是生成物里的
    //   一句散文, 从来没人核过:
    //     ① 「30 卦」: 随卦(卦17)在这份文件里**没有**, 有源的是上经 29 卦 + 咸卦 = 30 卦。
    //     ② 「180 逐字可比」: 180 是**有源**爻位数, 里面只有 **166** 逐字, 另 14 条是异文。
    //        异文被台账"顺带"盖住, 于是「逐字可比」这句一直挂着假。
    //     ③ 「12 处」: 实算 8 local + 6 variant = 14。12 是拍的。
    //   第 51 批把这 7 个数字全部纳入 provenance.js 的 checkYaoCiSourceCoverage() 对账。
    //
    // ⚠️ 2026-10-23 第 52 批: ① 是**当时的误判, 现已改正** —— 随卦的爻辞
    //   **一直在本地文件里**(第 2022 行起), 只是缺 `第十七卦：《随卦》` 那行标题,
    //   导致切片器切不出它。修好切片器后随卦 6 条全部有源, 数字随之全变。
    //   ⇒ 下文的「上经 29 卦」现在是**上经 30 卦(随卦已补回)**。
    note: '《周易》全文(上经 30 卦 + 咸卦)含白话翻译。384 爻位爻辞的核验原文: '
      + '186 爻位有原文, 其中 169 逐字可核、17 条登记异文'
      + '(8 条是本地录入/白话串字, 6 条是通行本异文, 3 条是异体写法(係/系), '
      + '逐条见 provenance.js 的 VARIANT_LEDGER); '
      + '下经 33 卦的 198 爻位无独立第三方原文(本机唯一有下经爻辞的文本是盘古自己的下游产物, 循环证据不算)。',
  },
  {
    // 第 55 批加: 体用生克吉凶方向的出处。
    //
    // 为什么现在才补: `modules/gua_engine.js` 的 `TIYONG_TABLE` 一直在产出
    // 「用克体 · 大凶 · 事不成」这种**决定性断语**, 而 DIGEST_FEED 里
    // 梅花那三份写的是「起卦的随机数/时间起卦法在 gua_engine.js, **不在 64i 公理层**」
    // —— 也就是说这块**被记下了但没堵**。台账上有梅花, 但梅花讲体用吉凶的那段没进过核。
    //
    // 这段原文能核的只有**方向**(哪几支吉、哪几支凶):
    //   「体克用, 诸事吉; 用克体, 诸事凶。体生用, 有耗失之患; 用生体, 有进益之喜。
    //     体用比和, 则百事顺遂。」
    //
    // ⚠️ 原文**通篇没有百分比, 也没有大吉/次吉/中吉这种分级**。
    //   表里的 level(大吉/次吉/…)和 pct(90%/70%/…)是课件加的量化, 核不了 ⇒
    //   台账里必须把那部分单列 interpretive, 不许混在 sourced 里蒙混过关。
    id: 'meihua_tiyong',
    origin: '<course-source>/<course-file>',
    from: 190,
    to: 204,
    // tier = digest 而不是 course: 这是《梅花易数》的**白话解释**, 不是课件讲义。
    //   tier 记的是**来源类型**不是权威度 —— 白话解释相对宋本原文是二手, 归 digest 诚实。
    //   ⚠️ 别跟第 43 批那个「拿盘古自己的 digest 核盘古」的坑混为一谈:
    //      那批的问题是**作者循环**(文件自己写着与 hexagrams.js 同源),
    //      这份是**上游**材料(在 extracted/, 不是 pangu 产的), 方向相反。
    tier: 'digest',
    note: '《梅花易数》课外阅读资料(白话解释)「体用总决」段: '
      + '体用主客定义(体卦为主/用卦为事/互卦为事的之间/变卦为事之终)与体用生克吉凶**方向**: '
      + '体克用诸事吉/用克体诸事凶/体生用有耗失之患/'
      + '用生体有进益之喜/体用比和则百事顺遂。'
      + '⚠️ 这段**没有**吉凶分级和百分比 —— 那部分是课件量化, 台账里单列 interpretive。',
  },
  {
    // 第 55 批加: **动爻定主客**的出处(总决段说「体卦为主, 用卦为事」,
    //   但没说清「哪个卦是用卦」—— 那一半在这段**具体占例**里)。
    //
    // 为什么单独切一段而不是并进 meihua_tiyong: 两段在原文里相隔 390 行,
    //   合并会让切片横跨半个文件, 引文可读性和逐字核对的边界都变差。
    //
    // 这段特别有用: 它给了**三爻**的实例, 下卦组(第三爻动→下卦变)
    // 和上卦组(第四爻动、第五爻动→上卦变)各有一例 ⇒ 动爻定主客这条规则
    // 两组都有原文印证, 不是只从一个例子推出来的。
    id: 'meihua_tiyong_yao',
    origin: '<course-source>/<course-file>',
    from: 594,
    to: 600,
    tier: 'digest',
    note: '《梅花易数》疾病占的具体断例: 「第三爻动, 下卦坤土变艮土…」(下卦为用) / '
      + '「第四爻动, 上卦乾金变为巽木…」(上卦为用) / '
      + '「第五爻动, 乾金变离卦…」(上卦为用)。'
      + '⇒ 动爻所在之卦为用卦(变卦), 另一卦为体卦 —— 这是 `tiYongFromMovingYao` 的出处。',
  },
];

/**
 * PDF 讲义的**全文文本源** (第 68 批立)。
 *
 * ## 为什么单开一类
 *   SLICES 那一套是「按行号切 txt」—— 它假设原文是**可按行寻址的文本**。
 *   但风水查法资料这四份课程资料(八宅八命 / 立极定向 / 阳宅四要 / 阶段性实操案例课)
 *   **只有 PDF**, 本机没有任何文本孪生文件:
 *     grep 整棵「易经」树, 「伏延生祸绝五天六」「用11减」「东四命：坎(1)」
 *     这些关键判据**一个文本孪生都搜不到**。
 *   ⇒ 不开这一类, 风水这一门的判据就只能挂一个查不到原文的出处 ——
 *     那正是第 66 批在旺相休囚死上踩过的坑(判据有出处, 切片查不到 ⇒ 守卫报红)。
 *
 * ## 这一类怎么保证「不是手抄」
 *   文本由 `pdftotext` **机械抽取**, 一字不改; 抽取命令写进文件头。
 *   `--check` 会重新跑一遍 pdftotext, 逐字节比对 ——
 *   PDF 换了 / 被人改过 ⇒ 立刻报「不再一致」。
 *
 * ## 缺 pdftotext 怎么办
 *   **降级成警告, 不降级成假绿**:
 *   缺 pdftotext 时这一类**跳过比对**并**大声打印**「未校验」,
 *   但链**不因此变红** —— 因为出处的真源在那台机器上本来就读不出来,
 *   拿「读不出」当失败会让整条链在别的机器上一直接红, 反而没人看它。
 *   ⚠️ 这条降级**只在这台机器没有 poppler 时**生效; 本机有 ⇒ 守卫是真的。
 */
const PDF_TEXT_SOURCES = [
  {
    id: 'course_env_bazhai',
    pdf: '<course-source>/<course-file>',
    tier: 'course',
    title: '风水查法资料 · 八宅八命(命卦算法/东西四命/宅命相配/大游年指引)',
    note: '八宅派讲义: 命卦计算公式(男11减/女4加) + 5黄星特殊处理(男坤女艮) + '
      + '东西四命卦名单 + 宅命相配规则 + 三元九运(九紫离火运 2024-2043) + 实战流程。',
  },
  {
    id: 'course_env_lijidingxiang',
    pdf: '<course-source>/<course-file>',
    tier: 'course',
    title: '风水查法资料 · 立极定向(二十四向山配八卦/纳气口定朝向)',
    note: '二十四向山与八卦的完整对应(正北坎:壬子癸 … 西北乾:戌乾亥) + 立极点五种户型取法 + '
      + '纳气口优先级(阳台>大门>客厅)与四条否决条件 + 罗盘三要素。',
  },
  {
    id: 'course_env_sizhaoyaou',
    pdf: '<course-source>/<course-file>',
    tier: 'course',
    title: '风水查法资料 · 阳宅四要(门主灶厕/催文昌催财催桃花的三层优先级)',
    note: '阳宅四要四条规则(门开四吉方/主卧在吉方/灶坐凶向吉/厕设在凶方以凶制凶) + '
      + '四凶位卧室化解法 + 催文昌/催财/催桃花的「本命>八宅>流年」优先级 + 十二长生财位表。',
  },
  {
    id: 'course_env_shijianli',
    pdf: '<course-source>/<course-file>',
    tier: 'course',
    title: '风水查法资料 · 三元九运与案例(大游年歌诀/堪舆六步/阳宅四要复盘)',
    note: '**大游年歌诀八条全文**(震巽离坤兑乾坎艮) + 排列规则(伏位起、顺时针) + '
      + '风水堪舆六步流程 + 阳宅四要复盘 + 实战案例二的判词。',
  },
];

/**
 * 查法资料随堂表格 (第 68 批立) —— xlsx 真源。
 *
 * ## 为什么单开一类
 *   风水查法资料第 3 课的「命卦速查表」在 PDF 里是**一张图片**, 文字层抽不出来
 *   (pdftotext 只能拿到「命卦速查表：」这一行标题)。
 *   同一份课, 桌面上**另有一份同口径的 xlsx**: `2001-2040男女命卦速查表(2).xlsx`
 *   ⇒ 命卦规则**有机器可读的对照表**, 不用 OCR(OCR 把「壬午」读成「王午」、
 *   把「艮」读成「長」, 拿它当判据基线 = 把噪声写进基准)。
 *
 * ## 为什么自己解析 xlsx, 不引第三方库
 *   内核要**零外依赖**。xlsx 本身是个 zip, `unzip -p` 能取到两个 XML:
 *   `xl/sharedStrings.xml` (字符串池) + `xl/worksheets/sheet1.xml` (单元格)。
 *   一百来行就能读全, 比引一个 npm 包更配这个仓库的规矩。
 *
 * ## 这一类怎么保证「不是手抄」
 *   表格**逐格**从 XML 里读出来, 一个字不改; 抽取方式写进文件头。
 *   `--check` 会重新解析一遍, 逐字节比对 —— xlsx 被换过/被手改 ⇒ 立刻报出来。
 *
 * ## 缺 unzip 怎么办
 *   与 PDF 类同: **降级成警告, 不降级成假绿**(理由见 PDF_TEXT_SOURCES 顶上那段)。
 */
const XLSX_TABLE_SOURCES = [
  {
    id: 'course_env_bazhai_minggua_table',
    xlsx: '<course-source>/<course-file>',
    tier: 'course',
    title: '风水查法资料 · 2001-2040 男女命卦速查表 (查法资料随堂对照表)',
    note: '每年一格: 出生年份 / 男性命卦 / 男东西四命 / 女性命卦 / 女东西四命。'
      + '原表是**两栏并排**(左栏 2001-2020, 右栏 2021-2040), 切片保持原行序, '
      + '换序由内核自己做(并在 64i/fengshui/ming_gua.js 里写明)。'
      + '5 黄星特殊处理在表里写成「5土坤卦」「5土艮卦」, 保留数字 5。',
  },
];

/** 切片文件头部 —— 机器可读(字段名固定), 人也读得懂。 */
function header(slice, slicedAt) {
  return [
    '# ===== PROVENANCE SLICE =====',
    '# source_id: ' + slice.id,
    '# tier: ' + slice.tier,
    '# origin: ' + slice.origin,
    '# lines: ' + slice.from + '-' + slice.to,
    '# sliced_at: ' + slicedAt,
    '# extractor: apps/core/scripts/extract_provenance_sources.js',
    '# note: ' + slice.note,
    '# 规则: 正文为原文件 ' + slice.from + '-' + slice.to + ' 行的**逐字拷贝**, 一字未改。',
    '#      头部为抽取器生成, 与原文无关。',
    '# ===== /PROVENANCE SLICE =====',
    '',
  ].join('\n');
}

function bodyOf(origin, from, to) {
  const raw = fs.readFileSync(origin, 'utf8');
  const lines = raw.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (from < 1 || to > lines.length) {
    throw new Error('切片越界: ' + origin + ' ' + from + '-' + to + ' (文件 ' + lines.length + ' 行)');
  }
  return lines.slice(from - 1, to).join('\n');
}

/** PDF 全文文本源的文件头 —— 与切片头同一套机器可读格式。 */
function pdfHeader(entry, slicedAt) {
  return [
    '# ===== PROVENANCE SOURCE (PDF TEXT) =====',
    '# source_id: ' + entry.id,
    '# tier: ' + entry.tier,
    '# origin: ' + entry.pdf,
    '# extracted_by: pdftotext -enc UTF-8 <pdf> -',
    '# sliced_at: ' + slicedAt,
    '# extractor: apps/core/scripts/extract_provenance_sources.js',
    '# note: ' + entry.note,
    '# 规则: 正文为该 PDF 的 pdftotext 全文抽取, 一字未改(仅去掉分页符与行尾空白)。',
    '#      头部为抽取器生成, 与原文无关。',
    '# ===== /PROVENANCE SOURCE (PDF TEXT) =====',
    '',
  ].join('\n');
}

/**
 * 把 PDF 机械抽成文本。**一个字都不改** ——
 * 只去掉分页符(\f)与行尾空白, 那两样不是内容。
 * 抽不动就返回 ok:false, **不抛** —— 调用方决定怎么报(降级成警告还是失败)。
 */
function pdfTextOf(entry, absPath) {
  let out;
  try {
    out = execFileSync('pdftotext', ['-enc', 'UTF-8', absPath, '-'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    return { ok: false, detail: String((e && e.message) || e).split('\n')[0] };
  }
  const text = out.replace(/\f/g, '\n').replace(/[ \t]+$/gm, '');
  return { ok: true, text };
}

/**
 * 读一个 xlsx 的第一个工作表, 返回**逐行**的单元格数组。
 *
 * 纯 Node: `unzip -p` 取两个 XML, 自己做最小解析。
 *   · sharedStrings.xml —— 字符串池(`<si><t>…</t></si>`)
 *   · worksheets/sheet1.xml —— 单元格(`<c r="A1" t="s"><v>0</v></c>`)
 *
 * ⚠️ 只解析本仓库真源需要的那几种形态, 不做通用 excel 解析:
 *   数字(`<v>2001</v>`) / 共享字符串(`t="s"`) / 内联字符串(`t="inlineStr"`)。
 *   遇到不认识的形态 ⇒ **报错**, 不静默当空 —— 静默当空 = 表少一行而没人知道。
 */
function readXlsxSheet(xlsxPath) {
  let sharedXml;
  let sheetXml;
  try {
    sharedXml = execFileSync('unzip', ['-p', xlsxPath, 'xl/sharedStrings.xml'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    sheetXml = execFileSync('unzip', ['-p', xlsxPath, 'xl/worksheets/sheet1.xml'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    return { ok: false, detail: String((e && e.message) || e).split('\n')[0] };
  }

  // 字符串池
  const shared = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(sharedXml)) !== null) {
    const parts = [];
    const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tRe.exec(m[1])) !== null) parts.push(t[1]);
    shared.push(decodeXml(parts.join('')));
  }

  // 单元格 → 按列号归位
  const rows = [];
  const rowRe = /<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  while ((m = rowRe.exec(sheetXml)) !== null) {
    const rowNum = Number(m[1]);
    const cells = [];
    const cRe = /<c([^>]*)>([\s\S]*?)<\/c>|<c([^>]*)\/>/g;
    let c;
    while ((c = cRe.exec(m[2])) !== null) {
      const attrs = c[1] || c[3] || '';
      const body = c[2] || '';
      const refM = /r="([A-Z]+)(\d+)"/.exec(attrs);
      const col = refM ? colIndex(refM[1]) : cells.length;
      const typeM = /t="([^"]+)"/.exec(attrs);
      const type = typeM ? typeM[1] : 'n';
      let value = '';
      if (type === 's') {
        const vM = /<v>([\s\S]*?)<\/v>/.exec(body);
        const idx = vM ? Number(vM[1]) : -1;
        if (!(idx >= 0 && idx < shared.length)) {
          return { ok: false, detail: '共享字符串下标越界: ' + idx + ' (行 ' + rowNum + ')' };
        }
        value = shared[idx];
      } else if (type === 'inlineStr') {
        const parts = [];
        const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
        let t;
        while ((t = tRe.exec(body)) !== null) parts.push(t[1]);
        value = decodeXml(parts.join(''));
      } else if (type === 'n' || type === '') {
        const vM = /<v>([\s\S]*?)<\/v>/.exec(body);
        value = vM ? decodeXml(vM[1]) : '';
      } else {
        return { ok: false, detail: '不认识的单元格类型 t="' + type + '" (行 ' + rowNum + ')' };
      }
      while (cells.length < col) cells.push('');
      cells[col] = value;
    }
    rows[rowNum - 1] = cells;
  }
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return { ok: true, rows };
}

/** 「AA」→ 26(0 基)。 */
function colIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** XML 实体反转义 —— 只处理 xlsx 里真会出现的五个。 */
function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** xlsx 表格源的文件头 —— 与 txt / PDF 两类同一套机器可读格式。 */
function xlsxHeader(entry, slicedAt) {
  return [
    '# ===== PROVENANCE SOURCE (XLSX TABLE) =====',
    '# source_id: ' + entry.id,
    '# tier: ' + entry.tier,
    '# origin: ' + entry.xlsx,
    '# extracted_by: unzip -p <xlsx> xl/sharedStrings.xml xl/worksheets/sheet1.xml (纯 Node 解析)',
    '# sliced_at: ' + slicedAt,
    '# extractor: apps/core/scripts/extract_provenance_sources.js',
    '# note: ' + entry.note,
    '# 规则: 每行 = 原表一行, 单元格间用制表符分隔; 行序 = 原表行序; 空单元格 = 空串。',
    '#      头部为抽取器生成, 与原文无关。',
    '# ===== /PROVENANCE SOURCE (XLSX TABLE) =====',
    '',
  ].join('\n');
}

function run(checkOnly) {
  const slicedAt = '2026-10-22';
  const pdfSlicedAt = '2026-10-23';
  if (!checkOnly) fs.mkdirSync(OUT_DIR, { recursive: true });
  const problems = [];
  const written = [];
  const warnings = [];

  for (const slice of SLICES) {
    const abs = corpusPath(slice.origin);
    if (!abs || !fs.existsSync(abs)) {
      problems.push('原文件不存在: ' + slice.origin + ' (切片 ' + slice.id + ')'
        + (abs ? '' : ' —— 未设 PANGU_CORPUS_ROOT, 语料不在本机'));
      continue;
    }
    const body = bodyOf(abs, slice.from, slice.to);
    const outPath = path.join(OUT_DIR, slice.id + '.txt');
    // 每份切片可以自带 sliced_at —— 新增的切片用它自己那天,
    // 免得新切片盖着一个批次常量日期(那就成了一句假话)。
    const expected = header(slice, slice.sliced_at || slicedAt) + body + '\n';
    if (checkOnly) {
      if (!fs.existsSync(outPath)) {
        problems.push('切片缺失: ' + slice.id + '.txt');
        continue;
      }
      const actual = fs.readFileSync(outPath, 'utf8');
      if (actual !== expected) {
        problems.push('切片与原文不再一致(原文件被改过或切片被手改): ' + slice.id + '.txt');
      }
    } else {
      fs.writeFileSync(outPath, expected, 'utf8');
      written.push(slice.id + '.txt (' + body.split('\n').length + ' 行)');
    }
  }

  // ── PDF 全文文本源 ──
  //   缺 pdftotext / PDF 不在本机 ⇒ **降级成警告**, 不当失败。
  //   理由见 PDF_TEXT_SOURCES 顶上那段: 真源读不出来时把整条链搞红,
  //   只会让人从此不看它; 大声打印「未校验」才是诚实的做法。
  for (const entry of PDF_TEXT_SOURCES) {
    const abs = corpusPath(entry.pdf);
    if (!abs || !fs.existsSync(abs)) {
      warnings.push('PDF 不在本机, 未校验: ' + entry.pdf + ' (源 ' + entry.id + ')');
      continue;
    }
    const r = pdfTextOf(entry, abs);
    if (!r.ok) {
      warnings.push('pdftotext 不可用, 未校验: ' + entry.id + ' — ' + r.detail);
      continue;
    }
    const outPath = path.join(OUT_DIR, entry.id + '.txt');
    const expected = pdfHeader(entry, pdfSlicedAt) + r.text.replace(/\n+$/, '') + '\n';
    if (checkOnly) {
      if (!fs.existsSync(outPath)) {
        problems.push('PDF 文本源缺失: ' + entry.id + '.txt');
      } else if (fs.readFileSync(outPath, 'utf8') !== expected) {
        problems.push('PDF 文本源与原文不再一致(PDF 被换过或文件被手改): ' + entry.id + '.txt');
      }
    } else {
      fs.writeFileSync(outPath, expected, 'utf8');
      written.push(entry.id + '.txt (PDF 全文)');
    }
  }

  // ── 查法资料 xlsx 表格源 ──
  for (const entry of XLSX_TABLE_SOURCES) {
    const abs = corpusPath(entry.xlsx);
    if (!abs || !fs.existsSync(abs)) {
      warnings.push('xlsx 不在本机, 未校验: ' + entry.xlsx + ' (源 ' + entry.id + ')');
      continue;
    }
    const r = readXlsxSheet(abs);
    if (!r.ok) {
      warnings.push('xlsx 解析失败, 未校验: ' + entry.id + ' — ' + r.detail);
      continue;
    }
    const body = renderXlsxBody(r.rows);
    const outPath = path.join(OUT_DIR, entry.id + '.txt');
    const expected = xlsxHeader(entry, pdfSlicedAt) + body + '\n';
    if (checkOnly) {
      if (!fs.existsSync(outPath)) {
        problems.push('xlsx 表格源缺失: ' + entry.id + '.txt');
      } else if (fs.readFileSync(outPath, 'utf8') !== expected) {
        problems.push('xlsx 表格源与原文不再一致(xlsx 被换过或文件被手改): ' + entry.id + '.txt');
      }
    } else {
      fs.writeFileSync(outPath, expected, 'utf8');
      written.push(entry.id + '.txt (xlsx 表格 ' + r.rows.length + ' 行)');
    }
  }

  if (checkOnly) {
    const pdfChecked = PDF_TEXT_SOURCES.length - warnings.filter((w) => w.indexOf(entry0Id(w)) >= 0).length;
    console.log(problems.length
      ? '❌ 切片校验失败:'
      : '✅ 全部切片与原文一致 (txt ' + SLICES.length + ' 份 + PDF 全文 '
        + (PDF_TEXT_SOURCES.length - warnings.length) + ' 份 + xlsx 表格 '
        + (XLSX_TABLE_SOURCES.length - warnings.length) + ' 份)');
    for (const p of problems) console.log('  - ' + p);
    if (warnings.length) {
      console.log('⚠️ 有 ' + warnings.length + ' 份**未校验**(不是通过, 是没验):');
      for (const w of warnings) console.log('  - ' + w);
    }
  } else {
    console.log('✅ 写出 ' + written.length + ' 份切片 → ' + OUT_DIR);
    for (const w of written) console.log('  - ' + w);
    if (warnings.length) {
      console.log('⚠️ 有 ' + warnings.length + ' 份未写(见下):');
      for (const w of warnings) console.log('  - ' + w);
    }
  }
  return problems.length;
}

/**
 * 表格行 → 切片正文(制表符分隔)。**导出**, 好让判据能直接验它 ——
 *   「切片文件 = 这段渲染的产物」这条自洽性, 只有在渲染函数可被调用时才验得了。
 */
function renderXlsxBody(rows) {
  return rows
    .map((cells) => cells.map((c) => String(c === undefined ? '' : c)).join('\t'))
    .join('\n');
}

if (require.main === module) {
  const checkOnly = process.argv.includes('--check');
  process.exit(run(checkOnly) ? 1 : 0);
}

module.exports = {
  SLICES,
  PDF_TEXT_SOURCES,
  XLSX_TABLE_SOURCES,
  OUT_DIR,
  run,
  // 第 68 批: 把读取与渲染导出, 好让判据直接验「切片 = 抽取器的产物」这条自洽性
  //   (M13 变异把正文渲染改空, 之前**没有判据够得着它** ⇒ 空枪)
  readXlsxSheet,
  renderXlsxBody,
  xlsxHeader,
  pdfHeader,
  header,
};
