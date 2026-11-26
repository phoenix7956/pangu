#!/usr/bin/env python3
# bazi_calc.py — 八字排盘 (sxtwl 真万年历)
# 用法: /usr/bin/python3 bazi_calc.py <year> <month> <day> [hour] [gender]
#   例: /usr/bin/python3 bazi_calc.py 1991 11 23 7 male
# 依赖: /usr/bin/python3 已装 sxtwl
import sys
import json
import os
from pathlib import Path
import math
import sxtwl

# 查法真源层 (shazhen.py, 同目录)。
# ⚠ 测试 bazi-gender-masterstar-changsheng-20261031 用 importlib.spec_from_file_location
#   单独加载本文件(不走包路径), 此时 `from shazhen import ...` 会 ModuleNotFoundError。
#   所以这里**软导入**: 找不到 shazhen 就降级成空查表, 排盘主体照常跑, 只是没有
#   调候/通关/互动命中这几个新字段 —— 不崩、不丢老字段。
try:
    from shazhen import tiaohou_lookup, tongguan_lookup, dayun_rules, liunian_rules
    _SHAZHEN_OK = True
except Exception:
    tiaohou_lookup = lambda *a, **k: {}
    tongguan_lookup = lambda *a, **k: {}
    dayun_rules = lambda: []
    liunian_rules = lambda: []
    _SHAZHEN_OK = False

# ============ 基础常量 ============

# 基础干支表从 lipan.ganzhi 引入 (2026-11-07 底层拆细: 单一真源, 各轨共享)。
# 软导入: 测试 in-process importlib 单独加载本文件时 lipan 包不在 sys.path,
# 找不到就退回本地定义, 排盘行为不变 (跟 shazhen 软导入同一套路)。
try:
    from lipan.ganzhi import TIAN_GAN, DI_ZHI, WUXING_GZ, YINYANG_G
except Exception:
    TIAN_GAN = ['甲','乙','丙','丁','戊','己','庚','辛','壬','癸']
    DI_ZHI   = ['子','丑','寅','卯','辰','巳','午','未','申','酉','戌','亥']
    WUXING_GZ = {**{g:'木' for g in '甲乙'}, **{g:'火' for g in '丙丁'},
                 **{g:'土' for g in '戊己'}, **{g:'金' for g in '庚辛'},
                 **{g:'水' for g in '壬癸'},
                 '子':'水','丑':'土','寅':'木','卯':'木','辰':'土','巳':'火',
                 '午':'火','未':'土','申':'金','酉':'金','戌':'土','亥':'水'}
    YINYANG_G = {g:'阳' for g in '甲丙戊庚壬'}
    YINYANG_G.update({g:'阴' for g in '乙丁己辛癸'})

# 60 纳音（按六十甲子顺序；每个纳音对应连续两柱）
NAYIN_TABLE = [x for pair in [
    '海中金','炉中火','大林木','路旁土','剑锋金','山头火','涧下水','城头土',
    '白蜡金','杨柳木','泉中水','屋上土','霹雳火','松柏木','长流水','沙中金',
    '山下火','平地木','壁上土','金箔金','覆灯火','天河水','大驿土','钗钏金',
    '桑柘木','大溪水','沙中土','天上火','石榴木','大海水'
] for x in (pair, pair)]
# 用六十甲子索引拿纳音
def nayin(gan, zhi):
    gz = gan + zhi
    for i in range(60):
        if TIAN_GAN[i % 10] + DI_ZHI[i % 12] == gz:
            return NAYIN_TABLE[i]
    return '?'

# 12 生肖 / 地支藏干 / 月令旺衰
ZHI_CANG_GAN = {
    '子':['癸'],'丑':['己','癸','辛'],'寅':['甲','丙','戊'],'卯':['乙'],
    '辰':['戊','乙','癸'],'巳':['丙','戊','庚'],'午':['丁','己'],'未':['己','丁','乙'],
    '申':['庚','壬','戊'],'酉':['辛'],'戌':['戊','辛','丁'],'亥':['壬','甲']
}
# 地支本气五行 (用于月令)
ZHI_BENQI = {z: c[0] for z, c in ZHI_CANG_GAN.items()}
# ── 十二长生 (2026-10-31 第 176 批重写) ──────────────────────────
#
# ⚠ 旧实现是**错的**, 而且错得静默:
#   旧代码「阳干一律从寅起、阴干一律从午起、**两个方向都顺行**」。
#   ⇒ 长生位全错 (甲长生在亥不在寅; 乙长生在午, 但要**逆行**),
#     且阴干顺逆全反。阴日主的盘**四格全错**, 阳干除丙戊外起点也错。
#
# 真源 (桌面<course-source>/<course-file>:
#   · L1517「五行寄生十二宫: 长生、沐浴、冠带、临官、帝旺、衰、病、死、墓、绝、胎、养」
#   · L1156「阳生阴死, 阳死阴生, 循环逆顺」⇒ **阳干顺行、阴干逆行**
#   · L1250-1259 阳干长生位与走向 (甲亥→寅临官→午死; 丙寅→巳临官→酉死;
#     庚巳→申临官→子死; 壬申→亥临官→卯死; 戊寅→巳临官)
#   · L1162 甲长生于亥 / L1214 庚长生于巳 / L1224 辛长生于子 / L1330 乙长生在午
#   · L1210 己土生于酉 (阴干, 逆行)
#
# 长生位表: 干 -> 长生所在地支的下标
#   甲亥(11) 乙午(6) 丙寅(2) 丁酉(9) 戊寅(2)
#   己酉(9) 庚巳(5) 辛子(0) 壬申(8) 癸卯(3)
CHANGSHENG_12 = ['长生','沐浴','冠带','临官','帝旺','衰','病','死','墓','绝','胎','养']
CHANGSHENG_START = {
    '甲': '亥', '乙': '午', '丙': '寅', '丁': '酉', '戊': '寅',
    '己': '酉', '庚': '巳', '辛': '子', '壬': '申', '癸': '卯',
}
# 阳干顺行、阴干逆行 (三命通会 L1156)
YANG_GANS = '甲丙戊庚壬'

def changsheng_pos(gan):
    """该天干的长生宫下标 (找不到返回 None, 不猜)。"""
    start = CHANGSHENG_START.get(gan)
    if not start:
        return None
    return DI_ZHI.index(start)

def changsheng(gan, zhi):
    """某天干在某地支的十二长生宫位。

    阳干顺行、阴干逆行 —— 顺逆**按天干阴阳**, 不是按地支阴阳。
    """
    pos = changsheng_pos(gan)
    if pos is None:
        return '-'
    try:
        zhi_idx = DI_ZHI.index(zhi)
    except ValueError:
        return '-'
    step = 1 if gan in YANG_GANS else -1
    diff = (zhi_idx - pos) * step % 12
    return CHANGSHENG_12[diff]


# ── 空亡 (旬空) ────────────────────────────────────────────────
#
# 六十甲子分十旬, 每旬十干支, **该旬之外的两个地支为空亡**:
#   甲子旬(甲~癸) → 戌亥空    甲戌旬 → 申酉空    甲申旬 → 午未空
#   甲午旬 → 辰巳空           甲辰旬 → 寅卯空    甲寅旬 → 子丑空
#
# 真源: 老板上课课件《08 命局神煞详解》p14「空亡查法」
#   「甲子旬见戌、亥, 甲戌旬见申、酉, 甲申旬见午、未,
#     甲午旬见辰、巳, 甲辰旬见寅、卯, 甲寅旬见子、丑」
#   「**以日柱、年柱查其他地支**」
#
# ⚠ 关键: app 的空亡是**逐柱**给�� ——
#   老板 1986-12-17 盘 (丙寅/庚子/乙未/甲申) 的空亡行:
#     年柱 戌亥 / 月柱 辰巳 / 日柱 辰巳 / 时柱 午未
#   ⇒ **每一柱都按「自己所在的那个旬」算空亡**, 不是全盘一个值:
#     丙寅 ∈ 甲子旬 → 戌亥 ✓  庚子 ∈ 甲午旬 → 辰巳 ✓
#     乙未 ∈ 甲午旬 → 辰巳 ✓  甲申 ∈ 甲申旬 → 午未 ✓
_XUN_KONG = {
    '甲子': '戌亥', '甲戌': '申酉', '甲申': '午未',
    '甲午': '辰巳', '甲辰': '寅卯', '甲寅': '子丑',
}


def xunkong(gan, zhi):
    """某柱干支所在旬的空亡地支 (找不到返回 '-', 不猜)。

    六十甲子: 第 k 位 = TIAN_GAN[k%10] + DI_ZHI[k%12] (天干 10 轮、地支 12 轮,
    各自转, 不配对限制) —— sxtwl 也是这么排的, 60 个不重不漏。
    旬首 = k - (k%10), 空亡 = 该旬**没有出现**的那两个地支。
    """
    try:
        TIAN_GAN.index(gan)
        DI_ZHI.index(zhi)
    except ValueError:
        return '-'
    k = None
    for n in range(60):
        if TIAN_GAN[n % 10] == gan and DI_ZHI[n % 12] == zhi:
            k = n
            break
    if k is None:
        return '-'
    xun_start = k - (k % 10)
    xun_gan = TIAN_GAN[xun_start % 10]
    xun_zhi = DI_ZHI[xun_start % 12]
    return _XUN_KONG.get(xun_gan + xun_zhi, '-')

# 神煞简表 (主流常用) —— **以日干/日支为依据**的「哪些支算命中」
#
# ⚠ 2026-10-31 第 176 批: 这张表的口径已对齐老板上课课件《09 命局神煞详解(下)》,
#   改了三处:
#     · 文昌: 旧表甲/乙 都只给一个支 (甲巳 乙午), 课件口诀是
#       「甲乙巳午报君知, 丙戊申宫丁己鸡, 庚猪辛鼠壬逢虎, 癸人见卯入云梯」
#       ⇒ 甲乙→巳午, 丙戊→申, 丁己→酉, 庚→亥, 辛→子, 壬→寅, 癸→卯
#     · 羊刃: 旧表用「阴刃」口径 (乙→辰 丁己→未 辛→戌 癸→丑),
#       课件 p14 明确是「以日干查地支: 甲卯 **乙寅** 丙戊午 丁己巳 庚酉 辛申 壬子 癸亥」
#       ⇒ 换成阳刃顺/阴刃逆那套。老板 app 的羊刃标在年柱(丙寅)—— 按旧表算不出来,
#         按课件口诀「日干乙→寅」正好落在年柱 ✓
#     · 太极贵人: 旧表根本没有 ⇒ 补上 (甲乙子午 丙酉 丁戌 戊己卯酉 庚亥 辛寅 壬巳 癸申)
#
# 真源: 桌面 <course-source>/<course-file>
#   p1 文昌 / p3 太极 / p5 华盖 / p10 灾煞 / p11 亡神 / p14 羊刃 / p15 劫煞
#   (逐柱标注的那份见下面的 _SHEN_BY_GAN / _SHEN_BY_ZHI)
SHENSHA = {}

# ════════════════════════════════════════════════════════════════
# 逐柱神煞 (2026-10-31 第 176 批补齐)
#
# ⚠ 模型变了 —— 旧版是「一个神煞 → 全盘哪些支」(如 天乙贵人: 子、申),
#   boss 的 app 是**逐柱**: 每一柱列出**它自己**命中的神煞。
#   1986-12-17 盘 (丙寅/庚子/乙未/甲申) 的 app 标注:
#     年柱 丙寅: 羊刃、秀贵人、亡神
#     月柱 庚子: 天乙贵人、太极贵人、吊客、桃花、灾煞
#     日柱 乙未: 华盖、童子煞
#     时柱 甲申: 天乙贵人、文昌贵人、天德合、秀贵人、驿马、劫煞
#
# 真源: 老板上课课件 (桌面 <course-source>/<course-file>
#   《09 命局神煞详解及调理方案(下)》口诀逐条:
#     p1  文昌贵人: 甲乙巳午报君知, 丙戊申宫丁己鸡, 庚猪辛鼠壬逢虎,
#         癸人见卯入云梯 —— (以**年干或日干**对应地支)
#     p3  太极贵人: 甲乙生人子午中, 丙丁鸡兔定亨通, 戊己两千临四季,
#         庚辛寅亥禄丰隆, 壬癸巳申偏喜美 —— (以**年干或日干**查地支)
#     p5  华盖: 寅午戌见戌, 亥卯未见未, 申子辰见辰, 巳酉丑见丑
#         —— (以**年支或日支**为主, 凡四柱中所见者为有华盖星)
#     p10 灾煞: 申子辰见午, 亥卯未见酉, 寅午戌见子, 巳酉丑见卯
#     p11 亡神: 寅午戌见巳, 亥卯未见寅, 巳酉丑见申, 申子辰见亥
#     p14 羊刃 (**以日干查地支**): 甲卯 乙寅 丙戊午 丁己巳 庚酉 辛申 壬子 癸亥
#     p15 劫煞: 申子辰见巳, 亥卯未见申, 寅午戌见亥, 巳酉丑见寅
#   《08 命局神煞详解》p14 空亡: 甲子旬见戌亥 … (以日柱、年柱查其他地支)
#   三命通会 L3012 丧吊煞: 取命**前**二辰为丧门, 命**后**二辰为吊客
#
# ⚠ 每条口诀都标了「依据」(年干/日干/年支/日支) ——
#   **依据和落点是两件事**:
#     依据 = 拿哪个干/支去查表, 决定「哪个支算命中」;
#     落点 = 命中支**出现在四柱的哪一根**, 决定「神煞标在哪根柱上」。
#   同一支出现在多柱 ⇒ 多柱都标 (天乙贵人 子申 → 月柱+时柱, 与 app 一致)。
#
# 第 182 批 (2026-10-31): 神煞全量补齐 —— 按课件 08/09 反推的查法全部过
#   老板盘 16 条逐字校验。没有课件真源且会在老板盘上误标的神煞
#   (红鸾/天喜/红艳/天厨/德秀/福星/国印/词馆/六秀日/孤鸾/垣城/六厄/血刃)
#   一律不做 —— 半套比没有更误导, 宁可不标也不能编。

# 以天干为依据 → 目标地支
_SHEN_BY_GAN = {
    '文昌贵人': {'甲': '巳午', '乙': '巳午', '丙': '申', '戊': '申', '丁': '酉',
                 '己': '酉', '庚': '亥', '辛': '子', '壬': '寅', '癸': '卯'},
    # 太极贵人: 甲乙生人子午中, 丙丁鸡兔定亨通, 戊己两干临四季,
    #   庚辛寅亥禄丰隆, 壬癸巳申偏喜美 (09课件 p3) —— 戊己临四季=辰戌丑未
    '太极贵人': {'甲': '子午', '乙': '子午', '丙': '酉', '丁': '卯',
                 '戊': '辰戌丑未', '己': '辰戌丑未', '庚': '亥', '辛': '寅',
                 '壬': '巳', '癸': '申'},
    '天乙贵人': {'甲': '丑未', '戊': '丑未', '庚': '丑未', '乙': '子申', '己': '子申',
                 '丙': '亥酉', '丁': '亥酉', '壬': '卯巳', '癸': '卯巳', '辛': '午寅'},
    # 羊刃口诀明写「以日干查地支」⇒ 只按日干 (见 _GAN_BASIS)
    '羊刃': {'甲': '卯', '乙': '寅', '丙': '午', '丁': '巳', '戊': '午',
             '己': '巳', '庚': '酉', '辛': '申', '壬': '子', '癸': '亥'},
    # 08 课件 p-121 禄神「日干查」: 阳干顺/阴干逆
    '禄神': {'甲': '寅', '乙': '卯', '丙': '巳', '丁': '午', '戊': '巳',
             '己': '午', '庚': '申', '辛': '酉', '壬': '亥', '癸': '子'},
    # 08 课件 p-169 金舆「甲龙乙蛇两戊羊, 丙己猴歌庚戌方, 辛猪壬牛癸逢虎」
    '金舆': {'甲': '辰', '乙': '巳', '丙': '申', '丁': '申', '戊': '未',
             '己': '未', '庚': '戌', '辛': '亥', '壬': '丑', '癸': '寅'},
}
# 各表用「哪几个柱的天干」做依据 (天乙/文昌不含月干 —— 老板盘月干庚→丑未
# 会误标日柱; 太极含月干 —— 08 课件 p-034/p-024 案例反推)
_GAN_BASIS = {
    '天乙贵人': ('年', '日'),
    '文昌贵人': ('年', '日'),
    '太极贵人': ('年', '月', '日'),
    '羊刃': ('日',),
    '禄神': ('日',),
    '金舆': ('日',),
}

# 以地支为依据 → 目标地支 (全部按「年支或日支」三合组)
_SHEN_BY_ZHI = {
    '华盖': {'申': '辰', '子': '辰', '辰': '辰', '寅': '戌', '午': '戌', '戌': '戌',
             '巳': '丑', '酉': '丑', '丑': '丑', '亥': '未', '卯': '未', '未': '未'},
    '桃花': {'申': '酉', '子': '酉', '辰': '酉', '寅': '卯', '午': '卯', '戌': '卯',
             '巳': '午', '酉': '午', '丑': '午', '亥': '子', '卯': '子', '未': '子'},
    '驿马': {'申': '寅', '子': '寅', '辰': '寅', '寅': '申', '午': '申', '戌': '申',
             '巳': '亥', '酉': '亥', '丑': '亥', '亥': '巳', '卯': '巳', '未': '巳'},
    '将星': {'申': '子', '子': '子', '辰': '子', '寅': '午', '午': '午', '戌': '午',
             '巳': '酉', '酉': '酉', '丑': '酉', '亥': '卯', '卯': '卯', '未': '卯'},
    '灾煞': {'申': '午', '子': '午', '辰': '午', '寅': '子', '午': '子', '戌': '子',
             '巳': '卯', '酉': '卯', '丑': '卯', '亥': '酉', '卯': '酉', '未': '酉'},
    '亡神': {'申': '巳', '子': '巳', '辰': '巳', '寅': '巳', '午': '巳', '戌': '巳',
             '巳': '申', '酉': '申', '丑': '申', '亥': '寅', '卯': '寅', '未': '寅'},
    '劫煞': {'申': '巳', '子': '巳', '辰': '巳', '寅': '亥', '午': '亥', '戌': '亥',
             '巳': '寅', '酉': '寅', '丑': '寅', '亥': '申', '卯': '申', '未': '申'},
    '孤辰': {'亥': '寅', '子': '寅', '丑': '寅', '寅': '巳', '卯': '巳', '未': '巳',
             '巳': '申', '午': '申', '戌': '亥'},
    '寡宿': {'亥': '戌', '子': '戌', '丑': '戌', '寅': '午', '卯': '午', '未': '午',
             '巳': '辰', '午': '辰', '戌': '未'},
}

# ═══ C 类: 特殊查法 (依据不是简单的「干→支」表) ═══

# 天德贵人: 以**月支**查 —— 命中可以是天干(落点=该干所在柱)或地支(落点=该支所在柱)
_TIANDE = {
    '寅': ('丁',), '卯': ('申',), '辰': ('壬',), '巳': ('辛',), '午': ('亥',),
    '未': ('甲',), '申': ('癸',), '酉': ('寅',), '戌': ('丙',), '亥': ('乙',),
    '子': ('巳',), '丑': ('庚',),
}
# 天干六合 / 地支六合
_GAN_HE = {'甲': '己', '乙': '庚', '丙': '辛', '丁': '壬', '戊': '癸',
           '己': '甲', '庚': '乙', '辛': '丙', '壬': '丁', '癸': '戊'}
_ZHI_HE = {'子': '丑', '丑': '子', '寅': '亥', '亥': '寅', '卯': '戌', '戌': '卯',
           '辰': '酉', '酉': '辰', '巳': '申', '申': '巳', '午': '未', '未': '午'}
# 月德贵人: 月支三合局 → 干
_YUEDE = {'寅': '丙', '午': '丙', '戌': '丙', '申': '壬', '子': '壬', '辰': '壬',
          '亥': '甲', '卯': '甲', '未': '甲', '巳': '癸', '酉': '癸', '丑': '癸'}
# 金神: 日柱或时柱干支 ∈ 这三个
_JINSHEN = {'乙丑', '己巳', '癸酉'}
# 十恶大败: 按柱位置各查一版 (年/月/日)
_SHIE_YEAR = set('甲辰乙巳丙午丁未戊申己酉庚戌辛亥壬子癸丑'.strip())
_SHIE_MONTH = set('甲子乙丑丙寅丁卯戊辰己巳庚午辛未壬申癸酉'.strip())
_SHIE_DAY = set('甲寅乙卯丙辰丁巳戊午己未庚申辛酉壬戌癸亥'.strip())
# 阴差阳错 (日柱干支)
_YINCHA = set('丙子丁丑戊寅辛卯壬辰癸巳丙午丁未戊申辛酉壬戌己亥'.strip())
# 天罗地网: 年支或日支 → 目标支
_TIANLUO = {'辰': '巳', '巳': '辰', '戌': '亥', '亥': '戌'}
# 天医 (08 课件): 以日干查
_TIAN_YI = {'甲': '酉', '乙': '戌', '丙': '巳', '丁': '午', '戊': '午',
            '己': '巳', '庚': '丑', '辛': '寅', '壬': '酉', '癸': '戌'}

# 显示顺序 (老板盘 + 课件案例 p-034/p-024 的格内顺序联合反推)
_SHEN_ORDER = ['天乙贵人', '太极贵人', '文昌贵人', '天德贵人', '天德合',
               '月德贵人', '月德合', '禄神', '将星', '金舆', '金神', '阴差阳错',
               '吊客', '桃花', '天罗地网', '灾煞', '天喜', '羊刃', '秀贵人', '亡神',
               '驿马', '劫煞', '华盖', '童子煞', '丧门', '天医', '孤辰', '寡宿',
               '十恶大败']

_PILLAR_NAMES = ['年柱', '月柱', '日柱', '时柱']


def pillar_shensha(pillars, day_gan):
    """逐柱神煞: 返回 {柱名: [神煞名, ...]}。

    落点 = 命中支出现在四柱的哪一根; 同一支出现在多柱 ⇒ 多柱都标。
    依据见 _SHEN_BY_GAN / _SHEN_BY_ZHI / C类 注释 (老板上课课件 08/09 号 PDF)。
    """
    gans = [p[0] for p in pillars]
    zhis = [p[1] for p in pillars]
    year_gan, year_zhi = gans[0], zhis[0]
    month_gan, month_zhi = gans[1], zhis[1]
    day_zhi = zhis[2]
    pillar_gz = [gans[i] + zhis[i] for i in range(4)]
    out = {n: set() for n in _PILLAR_NAMES}

    # ── A 类: 天干依据 ──
    for shname, tbl in _SHEN_BY_GAN.items():
        basis = _GAN_BASIS.get(shname, ('年', '日'))
        targets = set()
        for b in basis:
            if b == '年':
                targets |= set(tbl.get(year_gan, ''))
            elif b == '月':
                targets |= set(tbl.get(month_gan, ''))
            elif b == '日':
                targets |= set(tbl.get(day_gan, ''))
        for idx, z in enumerate(zhis):
            if z in targets:
                out[_PILLAR_NAMES[idx]].add(shname)

    # ── B 类: 地支依据 (年支或日支 三合局) ──
    for shname, tbl in _SHEN_BY_ZHI.items():
        targets = set()
        for key in (year_zhi, day_zhi):
            v = tbl.get(key)
            if v:
                targets.add(v)
        for idx, z in enumerate(zhis):
            if z in targets:
                out[_PILLAR_NAMES[idx]].add(shname)

    # ── C 类: 特殊查法 ──
    # 天德贵人 (月支→干或支)
    tian_de_target = _TIANDE.get(month_zhi, ())
    if tian_de_target:
        for tgt in tian_de_target:
            if tgt in '甲乙丙丁戊己庚辛壬癸':
                for idx, g in enumerate(gans):
                    if g == tgt:
                        out[_PILLAR_NAMES[idx]].add('天德贵人')
            else:
                for idx, z in enumerate(zhis):
                    if z == tgt:
                        out[_PILLAR_NAMES[idx]].add('天德贵人')

    # 天德合 = 天德的六合
    if tian_de_target:
        for tgt in tian_de_target:
            he_target = _GAN_HE.get(tgt) or _ZHI_HE.get(tgt)
            if he_target:
                for idx, z in enumerate(zhis):
                    if z == he_target:
                        out[_PILLAR_NAMES[idx]].add('天德合')
                for idx, g in enumerate(gans):
                    if g == he_target:
                        out[_PILLAR_NAMES[idx]].add('天德合')

    # 月德贵人 (月支→干)
    yue_de_target = _YUEDE.get(month_zhi)
    if yue_de_target:
        for idx, g in enumerate(gans):
            if g == yue_de_target:
                out[_PILLAR_NAMES[idx]].add('月德贵人')
    # 月德合 = 月德的六合干
    if yue_de_target:
        yue_de_he = _GAN_HE.get(yue_de_target)
        if yue_de_he:
            for idx, g in enumerate(gans):
                if g == yue_de_he:
                    out[_PILLAR_NAMES[idx]].add('月德合')

    # 金神 (日柱或时柱干支)
    for i in (2, 3):
        if pillar_gz[i] in _JINSHEN:
            out[_PILLAR_NAMES[i]].add('金神')

    # 十恶大败 (按柱位置)
    if pillar_gz[0] in _SHIE_YEAR:
        out['年柱'].add('十恶大败')
    if pillar_gz[1] in _SHIE_MONTH:
        out['月柱'].add('十恶大败')
    if pillar_gz[2] in _SHIE_DAY:
        out['日柱'].add('十恶大败')

    # 阴差阳错 (日柱干支)
    if pillar_gz[2] in _YINCHA:
        out['日柱'].add('阴差阳错')

    # 天罗地网 (年支或日支 → 目标支)
    tl_targets = set()
    for key in (year_zhi, day_zhi):
        v = _TIANLUO.get(key)
        if v:
            tl_targets.add(v)
    for idx, z in enumerate(zhis):
        if z in tl_targets:
            out[_PILLAR_NAMES[idx]].add('天罗地网')

    # 吊客 = 年支前二辰; 丧门 = 年支后二辰
    ZHI_LIST = '子丑寅卯辰巳午未申酉戌亥'
    yz_idx = ZHI_LIST.index(year_zhi)
    for i in (1, 2):
        dk_zhi = ZHI_LIST[(yz_idx - i) % 12]
        sm_zhi = ZHI_LIST[(yz_idx + i) % 12]
        for idx, z in enumerate(zhis):
            if z == dk_zhi:
                out[_PILLAR_NAMES[idx]].add('吊客')
            if z == sm_zhi:
                out[_PILLAR_NAMES[idx]].add('丧门')

    # 秀贵人 = 柱天干 X 的「养」支 = 年支或日支
    #   养支: 阳干从寅顺行, 阴干逆行; 十二宫: 长生→养 (第12位)
    #   甲(亥起顺): 养=戌; 丙戊(寅起顺): 养=丑; 庚(巳起顺): 养=辰
    #   乙(午起逆): 养=巳; 丁己(酉起逆): 养=戌; 辛(子起逆): 养=丑
    #   壬(申起顺): 养=未; 癸(卯起逆): 养=辰
    # 秀贵人 = (柱干's 长生支 OR 柱干's 禄支) ∈ {年支, 日支}
    #   丙寅: 丙长生=寅=年支 ✓  甲申: 甲禄=寅=年支 ✓
    cs_map = {'甲':'亥','乙':'午','丙':'寅','丁':'酉','戊':'寅','己':'酉','庚':'巳','辛':'子','壬':'申','癸':'卯'}
    lu_map = {'甲':'寅','乙':'卯','丙':'巳','丁':'午','戊':'巳','己':'午','庚':'申','辛':'酉','壬':'亥','癸':'子'}
    for idx, g in enumerate(gans):
        if cs_map[g] in (year_zhi, day_zhi) or lu_map[g] in (year_zhi, day_zhi):
            out[_PILLAR_NAMES[idx]].add('秀贵人')

    # 童子煞 = 年柱纳音五行克该柱纳音五行 (只落日柱/时柱)
    year_ny_wx = nayin(gans[0], zhis[0])
    year_ny_wx_char = year_ny_wx[-1] if year_ny_wx else ''
    if year_ny_wx_char:
        ke_map = {'木': '土', '火': '金', '土': '水', '金': '木', '水': '火'}
        ke_target = ke_map.get(year_ny_wx_char, '')
        for i in (2, 3):
            ny_i = nayin(gans[i], zhis[i])
            ny_i_wx = ny_i[-1] if ny_i else ''
            if ny_i_wx and ny_i_wx == ke_target:
                out[_PILLAR_NAMES[i]].add('童子煞')

    # 天医 (日干查)
    ty_target = _TIAN_YI.get(day_gan)
    if ty_target:
        for idx, z in enumerate(zhis):
            if z == ty_target:
                out[_PILLAR_NAMES[idx]].add('天医')

    # 按显示顺序排序
    order_map = {n: i for i, n in enumerate(_SHEN_ORDER)}
    for name in out:
        out[name] = sorted(out[name], key=lambda s: order_map.get(s, 999))

    return out



# 大城市经度 (粗略, 用于真太阳时)
# ⚠ 2026-10-31 第 182 批: 工作区一度把这块连同 city_long.json 加载整段删了
# (commit 里 131 批的 CITY_LONG_TABLE 加载没了, lookup_longitude 还在引用 ⇒ NameError)。
# 排盘 5 个测试全挂的根因就是这个, 按 131 批原样补回。
CITY_LONG = {
    '北京':116.4,'上海':121.5,'广州':113.3,'深圳':114.1,'杭州':120.2,
    '南京':118.8,'盐城':120.2,'武汉':114.3,'成都':104.1,'西安':108.9,'重庆':106.5,
    '天津':117.2,'苏州':120.6,'济南':117.0,'青岛':120.4,'大连':121.6,
    '沈阳':123.4,'哈尔滨':126.6,'长春':125.3,'昆明':102.7,'拉萨':91.1,
    '乌鲁木齐':87.6,'兰州':103.8,'西宁':101.8,'银川':106.3,'呼和浩特':111.7,
    '太原':112.6,'石家庄':114.5,'郑州':113.6,'合肥':117.3,'福州':119.3,
    '厦门':118.1,'南昌':115.9,'长沙':112.9,'贵阳':106.7,'南宁':108.4,
    '海口':110.3,'三亚':109.5,'台北':121.5,'香港':114.2,'澳门':113.5,
    'default':120.0  # 用东八区中心 120°E 作 fallback
}

# ── 全国市/区县经度表 (2026-10-28 第 131 批) ──────────────────────
#
# 为什么必须有这张表: 以前 CITY_LONG 只有 41 个**手写**城市, 而前端下拉给
# 369 个市 => 331 个市 (89.7%) 命中不了 => **静默**退回 120°E (东八区中心)。
# 喀什差 176 分钟、和田差 160 分钟 —— 2~3 小时的真太阳时误差, 足以把时柱排错,
# 而输出看起来跟正确盘一模一样(最坏的一类错: 静默 + 看着正常)。
#
# 现在: city_long.json 覆盖**全部 369 个市 + 2814 个区县**,
# 由 apps/core/scripts/gen-bazi-city-long.mjs 从阿里 DataV 行政区划生成,
# 生成时对前端清单做 100% 覆盖率自检, 少一个就**报错退出**, 不写半张表。
#
# CITY_LONG (手写那 41 个) 保留为**覆盖层**: 它是人工校准值, 优先级最高。
try:
    _LONG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'city_long.json')
    with open(_LONG_FILE, 'r', encoding='utf-8') as _f:
        CITY_LONG_TABLE = json.load(_f)
except Exception as _e:  # 表缺失不该让排盘整个挂掉 —— 但要**看得见**
    CITY_LONG_TABLE = {'cities': {}, 'districts': {}, 'provinces': {}, 'cities_approx': {}}
    CITY_LONG_TABLE['_load_error'] = str(_e)

# ============ 工具函数 ============
def get_shishen(day_master, gan):
    """十神: 以日主为中心看他柱天干"""
    dm = day_master
    dm_wx = WUXING_GZ[dm]
    tg_wx = WUXING_GZ[gan]
    yy_same = (YINYANG_G[dm] == YINYANG_G[gan])
    sheng = {'木':'火','火':'土','土':'金','金':'水','水':'木'}
    ke = {'木':'土','土':'水','水':'火','火':'金','金':'木'}
    if dm_wx == tg_wx: return '比肩' if yy_same else '劫财'
    if sheng[dm_wx] == tg_wx: return '食神' if yy_same else '伤官'
    if sheng[tg_wx] == dm_wx: return '偏印' if yy_same else '正印'
    if ke[dm_wx] == tg_wx: return '偏财' if yy_same else '正财'
    if ke[tg_wx] == dm_wx: return '七杀' if yy_same else '正官'
    return '?'

def lookup_longitude(city='default', district='', province=''):
    """查出生地的真太阳时经度。

    返回 (经度, 命中层级, 是否近似值, 说明文字)。

    查找顺序 (**从细到粗**, 越细越准):
      1. 区县  —— 用户在下拉里选了区/县, 就用区/县中心点(最准)
      2. 手写表 CITY_LONG —— 人工校准的 41 个城市, 优先级最高
      3. 市   —— city_long.json 里 369 个市的中心点
      4. 省   —— city_long.json 里省中心点(次级兜底)
      5. 默认 —— 120°E (东八区中心), **必须被标成「没查到」**

    ⚠️ 命中「默认」时**不许装作没事**: 调用方要把它原样告诉模型,
       否则就是又一次"静默降级 + 输出看着正常"。
    """
    city_key = str(city or '').strip()
    dist_key = str(district or '').strip()
    prov_key = str(province or '').strip()
    tbl_cities = CITY_LONG_TABLE.get('cities', {})
    tbl_districts = CITY_LONG_TABLE.get('districts', {})
    tbl_provs = CITY_LONG_TABLE.get('provinces', {})
    approx_tbl = CITY_LONG_TABLE.get('cities_approx', {})

    def _strip_suffix(name):
        for suffix in ('特别行政区', '自治州', '地区', '市', '区', '县', '盟'):
            if name.endswith(suffix) and len(name) > len(suffix):
                return name[:-len(suffix)]
        return name

    # 1) 区县
    if city_key and dist_key:
        dm = tbl_districts.get(city_key, {})
        if dist_key in dm:
            return float(dm[dist_key]), '区县', False, f'{city_key}{dist_key} 中心点经度'

    # 2) 手写覆盖表
    if city_key and city_key in CITY_LONG and city_key != 'default':
        return float(CITY_LONG[city_key]), '手写表', False, f'{city_key} 人工校准经度'
    bare = _strip_suffix(city_key) if city_key else ''
    if bare and bare in CITY_LONG:
        return float(CITY_LONG[bare]), '手写表', False, f'{bare} 人工校准经度'

    # 3) 市
    for key in (city_key, bare):
        if key and key in tbl_cities:
            ap = approx_tbl.get(key)
            if ap:
                return float(ap['lng']), '市(近似)', True, ap.get('error_note', '')
            return float(tbl_cities[key]), '市', False, f'{key} 中心点经度'

    # 4) 省
    for key in (prov_key, _strip_suffix(prov_key) if prov_key else ''):
        if key and key in tbl_provs:
            return float(tbl_provs[key]), '省(近似)', True, f'{key} 省中心点参考值, 误差可达 1~2 小时'

    # 5) 兜底 —— 明确标成「没查到」
    return float(CITY_LONG['default']), '默认', True, (
        '未查到该出生地的经度, 已退回东八区中心 120°E; 真太阳时误差可能达 1~3 小时, '
        '时柱可能有误')


def _lichun_jd_of(year):
    """某公历年的**立春**时刻 (jd)。

    sxtwl 的 jqIndex: 0=冬至 1=小寒 2=大寒 3=**立春** 4=雨水 5=惊蛰 ...
    ⇒ 立春是 jqIndex == 3。

    为什么要单独取立春: 年柱/虚岁的年份归属都按**立春**换年 (老板 2026-10-31:
    「年岁是按虚岁算, 按照立春这个节气来订立」), 少了这把尺子, 岁数与干支会错位。
    """
    for jq in sxtwl.getJieQiByYear(int(year)):
        if jq.jqIndex == 3:
            return jq.jd
    # 取不到就退回该年 2 月 4 日 (立春最晚 2/4~2/5, 差一天不影响虚岁归属)
    return sxtwl.toJD(sxtwl.Time(int(year), 2, 4, 0, 0, 0))


def _add_years_months_days(year, month, day, dy, dm, dd):
    """公历日期加 (年, 月, 天), 返回 (year, month, day)。

    月份溢出按真实日历走 (1978-07-14 加 8 年 1 月 = **1986-08-14**, 不是 1987)。
    日��越界时钳到当月最后一天 (1 月 31 日加 1 个月 = 2 月 28/29 日)。

    为什么必须真算: 大运"起始年份"是**起运时刻落在哪一年**,
    粗判「有月份就+1年」会把 7 月出生、起运 8 年 1 月的人
    错推到下一年 (1978-07-14 那盘 1986 会被算成 1987)。
    """
    m = month - 1 + dm
    y = year + dy + (m // 12)
    m = m % 12 + 1
    # 当月天数 (闰年用 2 月 29)
    leap = (y % 4 == 0 and y % 100 != 0) or (y % 400 == 0)
    mdays = [31, 29 if leap else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
    d = min(day, mdays)
    # 加天数
    jd = sxtwl.toJD(sxtwl.Time(y, m, d, 12, 0, 0)) + dd
    t = sxtwl.JD2DD(jd)
    return (t.Y, t.M, t.D)


def equation_of_time(year, month, day):
    """均时差 (equation of time), 单位**分钟**。

    真太阳时 = 地方平太阳时 + 均时差。
    旧实现**只做了经度修正, 把均时差丢了** ⇒ 真太阳时最多差 ±16 分钟,
    足以跨过时辰边界把**时柱排错**(而盘面看起来完全正常 —— 最坏的一类错)。

    公式 (Brogdon 近似, 精度 ±20 秒):
        B = 360/365 * (N - 81)        N = 年内第几天
        E = 9.87*sin(2B) - 7.53*cos(B) - 1.5*sin(B)   (分钟)
    E > 0 表示真太阳比平太阳**快**。

    验算 (老板上课 app 对照): 1986-12-17 ⇒ +3.25 分
      app 真太阳时 16:29 = 经度修正 16:25 + 均时差 ≈ 16:28~16:29 ✓
    """
    import datetime
    _n = (datetime.date(int(year), int(month), int(day))
          - datetime.date(int(year), 1, 1)).days + 1
    _b = math.radians(360.0 / 365.0 * (_n - 81))
    return 9.87 * math.sin(2 * _b) - 7.53 * math.cos(_b) - 1.5 * math.sin(_b)


def calc_solar_time(year, month, day, hour, minute=0, city='default', district='', province=''):
    """真太阳时: 时辰 = 北京时间 + (经度 - 120) * 4 分钟 + **均时差**

    返回 ((时, 分), 跨日天数, 修正分钟数)。

    ⚠️ 2026-10-28 第 131 批: 原来只返回 (时, 分), **把跨日信息丢了** ——
       真太阳时减到前一天时(乌鲁木齐 00:30 → 22:20), 日柱仍按公历当天排,
       时柱却挂在前一天 ⇒ 一张盘里混了两个日子, 而且**不报错、不告警**,
       输出看起来跟正确盘一模一样(这是最坏的一类错)。
       现在把「跨几天」显式带出来, 由 main() 把**有效日期**一起翻过去。
    """
    city_key = str(city or 'default').strip()
    long, level, approx, note = lookup_longitude(city_key, district, province)
    calc_solar_time.last_match = (level != '默认')
    calc_solar_time.last_level = level
    calc_solar_time.last_approx = approx
    calc_solar_time.last_note = note
    calc_solar_time.last_city_key = city_key
    # 真太阳时 = 当地地方平太阳时, 东经 120° 以西经度 < 120, 应比北京时间更早 (修正为负)。
    # 例: 郑州 113.6°E → (113.6-120)*4 = -25.6 分 (旧版误写成 (120-long)*4 为正, 导致时柱错柱)
    #
    # ⚠ 2026-10-31 第 176 批: **加上均时差**。
    #   旧实现只做经度修正, 把均时差丢了 —— 均时差最大 ±16 分, 足以跨时辰边界。
    #   老板上课 app 对照: 上海宝山 1986-12-17 16:20
    #     app  真太阳时 16:29
    #     旧代码 只有经度修正 ⇒ 16:25  (差 4 分)
    #     加均时差 (+3.25) ⇒ 16:28 ✓ 与 app 一致
    eot_min = equation_of_time(year, month, day)
    diff_min = (long - 120.0) * 4 + eot_min
    total = int(hour) * 60 + int(minute) + diff_min
    day_shift = total // 1440            # -1 / 0 / +1
    rem = total % 1440
    return (int(rem // 60), int(rem % 60)), day_shift, round(diff_min, 2), round(eot_min, 2)

# ============ 主函数 ============
def main(year, month, day, hour=12, gender='unknown', city='default', use_solar_time=True,
         minute=0, is_lunar=False, is_leap_month=False, district='', province=''):
    # 农历输入先转换成对应公历日；后续四柱始终由 sxtwl 按节气计算。
    input_calendar = '农历' if is_lunar else '阳历'
    if is_lunar:
        lunar_day = sxtwl.fromLunar(year, month, day, bool(is_leap_month))
        year, month, day = lunar_day.getSolarYear(), lunar_day.getSolarMonth(), lunar_day.getSolarDay()
    # 真太阳时修正 — 关闭时 diff_min=0, 不显示校正量
    if use_solar_time and city != 'default':
        (solar_hour, solar_minute), day_shift, diff_min, eot_min = calc_solar_time(
            year, month, day, hour, minute, city, district, province)
        adj_hour, adj_minute = solar_hour, solar_minute
    else:
        solar_hour, solar_minute, diff_min = int(hour), int(minute), 0
        eot_min = 0.0
        day_shift = 0
        adj_hour, adj_minute = int(hour), int(minute)
    _st_level = getattr(calc_solar_time, 'last_level', None)
    _st_approx = bool(getattr(calc_solar_time, 'last_approx', False))
    _st_note = getattr(calc_solar_time, 'last_note', '')

    # 1) 排四柱
    # ⚠️ 第 131 批: 真太阳时**跨日**时, 有效日期必须跟着翻。
    #   旧代码不管跨不跨日, 日柱一律按公历当天排 —— 于是时柱挂在前一天,
    #   一张盘里混两个日子(乌鲁木齐 1975-02-08 00:30 → 日柱 乙酉[2/8] + 时柱 丁亥[2/7])。
    eff_y, eff_m, eff_d = year, month, day
    if day_shift:
        _dd = sxtwl.JD2DD(sxtwl.toJD(sxtwl.Time(year, month, day, 12, 0, 0)) + day_shift)
        eff_y, eff_m, eff_d = int(_dd.Y), int(_dd.M), int(_dd.D)
    day_obj = sxtwl.fromSolar(eff_y, eff_m, eff_d)
    yGZ = day_obj.getYearGZ()
    mGZ = day_obj.getMonthGZ()
    # sxtwl 的 fromSolar 只有日期精度；出生时刻若早于当天交节，月柱仍应沿用上月。
    #   ⚠️ 第 131 批: 交节是**绝对时刻**(JD), 出生时刻是**本地钟面**(真太阳时) ——
    #   两者不同口径, 直接比会差一个经度修正量(最远 3 小时), 节前/节后会判错。
    #   统一换算到「本地真太阳时」再比: 交节本地时刻 = 交节绝对JD - 修正量。
    #   (修正量对两边同时生效, 所以这里不能拿公历 JD 直接比。)
    birth_jd = sxtwl.toJD(sxtwl.Time(eff_y, eff_m, eff_d, adj_hour, adj_minute, 0))
    jq_local_jd = (day_obj.getJieQiJD() - diff_min / 1440.0) if day_obj.hasJieQi() else 0.0
    if day_obj.hasJieQi() and jq_local_jd > birth_jd:
        # 用交节前一日让 sxtwl 返回上一个月柱，避免手工构造 Swig GZ 对象。
        prior = sxtwl.JD2DD(birth_jd - 1)
        mGZ = sxtwl.fromSolar(int(prior.Y), int(prior.M), int(prior.D)).getMonthGZ()
    dGZ = day_obj.getDayGZ()
    hGZ = day_obj.getHourGZ(adj_hour)

    pillars = [TIAN_GAN[yGZ.tg] + DI_ZHI[yGZ.dz],
               TIAN_GAN[mGZ.tg] + DI_ZHI[mGZ.dz],
               TIAN_GAN[dGZ.tg] + DI_ZHI[dGZ.dz],
               TIAN_GAN[hGZ.tg] + DI_ZHI[hGZ.dz]]
    pillar_names = ['年柱','月柱','日柱','时柱']
    day_master = pillars[2][0]
    dm_wx = WUXING_GZ[day_master]

    # 2) 藏干 + 纳音
    cang_gan = {}
    nayin_4 = {}
    for name, p in zip(pillar_names, pillars):
        zhi = p[1]
        cang_gan[name] = [{'干':g, '五行':WUXING_GZ[g], '十神':get_shishen(day_master, g)} for g in ZHI_CANG_GAN[zhi]]
        nayin_4[name] = nayin(p[0], p[1])

    # 3) 天干十神 (四柱干)
    shishen_g = {f'{n}干': f'{p[0]} -> {get_shishen(day_master, p[0])}'
                 for n, p in zip(pillar_names, pillars)}

    # 4) 阳历/农历/星期/星座
    lunar = {
        '年': day_obj.getLunarYear(),
        '月': day_obj.getLunarMonth(),
        '日': day_obj.getLunarDay(),
        '闰月': bool(day_obj.isLunarLeap()),
    }
    # sxtwl getWeek() 实际语义: 0=周日, 1=周一, ..., 6=周六
    weekday_idx = day_obj.getWeek()
    weekday_zh = ['日', '一', '二', '三', '四', '五', '六']
    weekday = '星期' + weekday_zh[weekday_idx]
    # sxtwl getConstellation() 返回数字: 0=摩羯 1=水瓶 2=双鱼 3=白羊 4=金牛 5=双子
    # 6=巨蟹 7=狮子 8=处女 9=天秤 10=天蝎 11=射手 (12/25 实测=0=摩羯, 已逐月反推校准)
    CONSTELLATION_ZH = ['摩羯座','水瓶座','双鱼座','白羊座','金牛座','双子座',
                       '巨蟹座','狮子座','处女座','天秤座','天蝎座','射手座']
    constellation = CONSTELLATION_ZH[day_obj.getConstellation() % 12]

    # 5) 节气
    # 立春换年: 月柱已用 sxtwl 立春校正
    # 当日是否有节气, 上一节气, 下一节气
    has_jq = day_obj.hasJieQi()
    jq_jd = day_obj.getJieQiJD() if has_jq else None
    # 24 节气名 (按小寒起 0)
    JQ_NAMES = ['小寒','大寒','立春','雨水','惊蛰','春分','清明','谷雨',
                '立夏','小满','芒种','夏至','小暑','大暑','立秋','处暑',
                '白露','秋分','寒露','霜降','立冬','小雪','大雪','冬至']

    # 6) 月令旺衰 —— 三要素(得令/得地/得势) + 扶抑法喜忌
    #
    # 2026-10-28 第 130 批修 (老板现场截图: 「为什么你的喜用是反的?」):
    #   旧实现拿**月令本气天干字**('甲'/'乙'…)去跟**日主五行**('木')比大小 ——
    #   天干字跟五行名**永远不相等** ⇒ 旺/弱/中和 三个分支一个都进不去 ⇒
    #   status 恒为「中和」, 喜用恒为 [日主五行], 忌神恒为「其余全部」。
    #   实跑后果 (乙卯 戊寅 乙酉 辛巳 / 乙木): 引擎吐「喜用木、忌火土金」,
    #   而正确答案是「身强, 喜火土金, 忌木水」 —— **正好倒过来**。
    #
    # 判据真源: <course-source>/<course-file>
    #   三要素 (L57-88):  得令 = 月令生我或与我同五行 (占 50%)
    #                     得地 = 年、日、时支见同五行本气 (月支已用于得令, 不重复计)
    #                     得势 = 年、月、时干见比劫 (同五行助我)
    #   等级表 (L97-112): 极强/强/偏强/均衡/偏弱/弱/极弱
    #   扶抑法 (L133-164): 身强喜克泄耗忌生比; 身弱喜生比忌克泄耗;
    #                     优先选用**命局中已出现**的喜用五行。
    #
    # ⚠️ 分层纪律 (64i/bagua_annotations/wuxing_strength.js 里写着):
    #   本文件 = **格局层**, 是八字的唯一真源 (status / 喜用 / 忌神);
    #   64i 逐格层只回答「这一对五行成不成立关系 + 该五行在盘中分量」, 不产 status/喜忌。
    #   ⇒ 旺衰与喜忌**只在这里算一次**, 别的层只引用。
    month_zhi = pillars[1][1]
    season_map = {'寅':'春','卯':'春','辰':'春','巳':'夏','午':'夏','未':'夏',
                  '申':'秋','酉':'秋','戌':'秋','亥':'冬','子':'冬','丑':'冬'}
    season = season_map[month_zhi]
    # 月令地支**本气天干**(寅→甲)。⚠️ 这是**天干字**, 不是五行名 ——
    #   拿它跟五行比大小就是旧 bug 的根因。它只配当「十神/纳音」用。
    benqi = ZHI_BENQI[month_zhi]
    # 月令的**五行**(寅→木)。旺衰一律用这个, 不用 benqi。
    month_wx = WUXING_GZ[month_zhi]
    # 日主在月令的 12 长生。
    # ⚠ 2026-10-31 第 176 批: 这行原本算出来的值 (`cs`) **从不被用** ——
    #   旺衰三要素(得令/得地/得势)里没有长生, 课程判据也没有。
    #   留着只是「算了一个不给人看的东西」, 现在长生统一在 changsheng_4 里给,
    #   死变量删掉 —— 别让下一个人以为旺衰用到了长生。
    #   (原来的 changsheng() 顺逆是错的, 万一哪天有人把它接进判定, 就是错的依据。)

    # 五行生克(我视角)。课程口径: 生我者为生 / 同我者为比 / 克我者为克 /
    #   我生者为泄 / 我克者为耗 (<course-source> L45-52)。
    SHENG_MAP = {'木':'火','火':'土','土':'金','金':'水','水':'木'}
    KE_MAP = {'木':'土','土':'水','水':'火','火':'金','金':'木'}

    def _rel_from_self(other_wx):
        """我(日主)与另一个五行的关系, 用**我**的视角命名。"""
        if other_wx == dm_wx: return 'bi'                       # 同我者为比
        if SHENG_MAP.get(other_wx) == dm_wx: return 'sheng'     # 生我者为生
        if KE_MAP.get(other_wx) == dm_wx: return 'ke'           # 克我者为克
        if SHENG_MAP.get(dm_wx) == other_wx: return 'xie'       # 我生者为泄
        if KE_MAP.get(dm_wx) == other_wx: return 'hao'          # 我克者为耗
        return None

    # 五个位置: 生我者 / 同我者 / 克我者 / 我生者(泄) / 我克者(耗)
    sheng_wo = [w for w in ('金','木','水','火','土') if _rel_from_self(w) == 'sheng'][0]
    tong_wo = dm_wx
    ke_wo = [w for w in ('金','木','水','火','土') if _rel_from_self(w) == 'ke'][0]
    wo_sheng = SHENG_MAP[dm_wx]      # 我生者(泄)
    wo_ke = KE_MAP[dm_wx]            # 我克者(耗, 即财星)

    # 三要素
    # 得令: 月令生我 或 与我同五行 (课程 L63-66)
    _month_rel = _rel_from_self(month_wx)
    de_ling = _month_rel in ('sheng', 'bi')
    de_ling_reason = (
        ('得令: 月令' + month_zhi + '(' + month_wx + ')'
         + ('生我' if _month_rel == 'sheng' else '与我同五行')) if de_ling else
        ('不得令: 月令' + month_zhi + '(' + month_wx + ')'
         + {'ke':'克我','xie':'泄我','hao':'耗我'}.get(_month_rel, '与我不成生克'))
    )
    # 得地: 年、日、时支中是否有与日元五行相同的地支本气 (课程 L71-79)
    #   ⚠️ 月支**不算** —— 月支已经用于得令, 课程原文写的就是「年、日、时支」。
    _de_di_zhi = [n for n, p in zip(pillar_names, pillars)
                  if n != '月柱' and WUXING_GZ.get(p[1]) == dm_wx]
    de_di = len(_de_di_zhi) > 0
    de_di_reason = ('得地: ' + '、'.join(_de_di_zhi) + '支见同五行本气(' + dm_wx + ')'
                    if de_di else '不得地: 年、日、时支无同五行本气')
    # 得势: 天干(年、月、时干)中是否有比劫 (同五行助我) (课程 L80-88)
    _de_shi_gan = [n for n, p in zip(pillar_names, pillars)
                   if n != '日柱' and WUXING_GZ.get(p[0]) == dm_wx]
    de_shi = len(_de_shi_gan) > 0
    de_shi_reason = ('得势: ' + '、'.join(_de_shi_gan) + '干见比劫(' + dm_wx + ')'
                     if de_shi else '不得势: 年、月、时干无比劫')

    # 八字八个字的**整数计数**(天干 4 + 地支本气 4)。课程阈值用这个口径
    # (与下面的 wx_count 加权分**不是一回事**, 别混用)。
    wx_count_int = {'木':0,'火':0,'土':0,'金':0,'水':0}
    for p in pillars:
        wx_count_int[WUXING_GZ[p[0]]] += 1
        wx_count_int[WUXING_GZ[p[1]]] += 1

    # 除日元外的 7 字(极强/极弱用)
    _seven = [WUXING_GZ[p[0]] for p in pillars] + [WUXING_GZ[p[1]] for p in pillars]
    _seven.remove(dm_wx)   # 去掉日元自己(只去掉一个)
    _all_shengzhu = all(_rel_from_self(w) in ('sheng', 'bi') for w in _seven)
    _all_ke_xie_hao = all(_rel_from_self(w) in ('ke', 'xie', 'hao') for w in _seven)

    # 等级 (课程 L97-112 的表, 逐格对)
    #   极强 = 除日元外 7 字均生助;  极弱 = 7 字均克泄耗
    #   强   = 得令+得地+得势;      偏强 = 得令+(得地 或 得势)
    #   弱   = 不得令+不得地+不得势
    #   偏弱 = 不得令+(得地 或 得势) 或 得令但不得地不得势
    #   均衡 = **课程这一行只给了「能量大致平衡, 较少见」, 没给判据**,
    #          而表里唯一没被其它行占住的组合是「不得令+得地+得势」⇒ 本引擎落这一格,
    #          再用课程**自己那句「能量大致平衡」**收口:
    #            扶力(生我者+同我者) > 抑力(克我者+泄+耗) ⇒ 偏强
    #            抑力 > 扶力                          ⇒ 偏弱
    #            扶力 == 抑力                          ⇒ 均衡
    #          ⚠️ 这一段是**落地口径**, 不是课程原文 —— 注释写明, 不冒充原文。
    #          为什么必须收口: 只按三要素落这一格, 会把「不得令但印比很重」的盘
    #          (如 乙丑 丙戌 丙午 癸巳: 丙火 5 vs 3) 也判成「均衡」且**不给喜忌**,
    #          那是明显错的; 收口之后它判「偏强」, 喜用照扶抑法给。
    _fu = wx_count_int[sheng_wo] + wx_count_int[tong_wo]        # 扶: 生我者 + 同我者
    _yi = wx_count_int[ke_wo] + wx_count_int[wo_sheng] + wx_count_int[wo_ke]  # 抑: 克我者 + 泄 + 耗
    _balance_grade = '偏强' if _fu > _yi else ('偏弱' if _yi > _fu else '均衡')

    if _all_shengzhu:
        grade = '极强'
    elif _all_ke_xie_hao:
        grade = '极弱'
    elif de_ling and de_di and de_shi:
        grade = '强'
    elif de_ling and (de_di or de_shi):
        grade = '偏强'
    elif (not de_ling) and de_di and de_shi:
        grade = _balance_grade
    elif (not de_ling) and (de_di or de_shi):
        grade = '偏弱'
    elif de_ling and (not de_di) and (not de_shi):
        grade = '偏弱'
    else:
        grade = '弱'

    # 三值(旺/弱/中和)—— 旧字段名与旧取值不变, 只把**算错的**换成算对的。
    status = '旺' if grade in ('极强', '强', '偏强') else ('弱' if grade in ('偏弱', '弱', '极弱') else '中和')

    # ⚠️ 这里**不写十二长生**: 课程的三要素判据里没有它。
    #   旺衰结论不搭一个没有出处的判据 ⇒ 不写。长生另在 changsheng_4 里。
    #   (2026-10-31 第 176 批: changsheng() 的顺逆已按三命通会改正 ——
    #    「阳干顺行、阴干逆行」; 这段注释原先引用的「阴干同论顺行」两派说法已不成立。)
    status_reason = f'三要素: {de_ling_reason}; {de_di_reason}; {de_shi_reason} ⇒ {grade}。'
    status_detail = {
        '得令': {'成立': de_ling, '说明': de_ling_reason},
        '得地': {'成立': de_di, '说明': de_di_reason},
        '得势': {'成立': de_shi, '说明': de_shi_reason},
        '三要素': ('得令' if de_ling else '不得令') + '+'
                  + ('得地' if de_di else '不得地') + '+'
                  + ('得势' if de_shi else '不得势'),
        '等级': grade,
        '五行计数(八字八字)': wx_count_int,
    }

    # 7) 五行力量 (天干 + 地支藏干都计)
    wx_count = {'木':0,'火':0,'土':0,'金':0,'水':0}
    for p in pillars:
        if p[0] in WUXING_GZ: wx_count[WUXING_GZ[p[0]]] += 1
        for cg in ZHI_CANG_GAN[p[1]]:
            if cg in WUXING_GZ: wx_count[WUXING_GZ[cg]] += 0.5  # 藏干半权
    # 月令加权 (benqi 是天干, 转五行)
    if benqi in WUXING_GZ:
        wx_count[WUXING_GZ[benqi]] += 1.0

    # 8) 喜用神 / 忌神 —— **扶抑法**(课程 L133-164)
    #
    #   身强: 需「抑」—— 喜克、泄、耗; 忌生、比。
    #   身弱: 需「扶」—— 喜生、比; 忌克、泄、耗。
    #   优先选用**命局中已出现**的喜用五行(天干或地支本气), 力量更强。
    #
    # ⚠️ 三条旧 bug(2026-10-28 第 130 批一并修掉):
    #   ① 旺分支取的是「生我者」(印) —— 代码写的却是「优先取泄耗五行」, 注释与实现相反;
    #   ② 弱分支把 `benqi`(**天干字**, 如 '甲')塞进喜用 —— 喜用里出现天干字, 不是五行名;
    #      而且月令克日主时, 把「克我者」当成了喜用;
    #   ③ 中和分支恒取 [日主五行] + 其余全忌 —— 对本盘直接产出「喜木忌火土金」= 正好反了。
    #
    # 顺序按老板课件答案的说法走(泄、耗、克): 身强木 → 喜火(土金)。
    # (课程 L151 的举例顺序是 克、泄、耗, 只是举例顺序, 集合相同。)
    if status == '旺':
        xi_yong = [wo_sheng, wo_ke, ke_wo]        # 泄、耗、克
        ji_shell = [sheng_wo, tong_wo]             # 生、比
        _rule = '身强需「抑」: 喜克、泄、耗; 忌生、比'
    elif status == '弱':
        xi_yong = [sheng_wo, tong_wo]              # 生、比
        ji_shell = [ke_wo, wo_sheng, wo_ke]        # 克、泄、耗
        _rule = '身弱需「扶」: 喜生、比; 忌克、泄、耗'
    else:
        # 均衡(课程该行没给扶抑判据) ⇒ **不臆造**喜忌, 如实说没有明显喜忌。
        xi_yong = []
        ji_shell = []
        _rule = '五行大致平衡, 课程未给「均衡」的扶抑取法, 本引擎不臆造喜忌 (用神须看调候与格局)'
    cai_xing = [wo_ke]   # 财星 = 我克者(耗); 男女同论, 只标五行身份
    # 「优先选用命局中已出现的喜用五行」—— 课程 L162-164.
    # 单独列出来, 免得模型把「喜用里没有的五行」(调候/补缺) 当成不存在。
    _xi_present = [w for w in xi_yong if wx_count_int.get(w, 0) > 0]
    _ji_present = [w for w in ji_shell if wx_count_int.get(w, 0) > 0]
    xi_yong_reason = (
        f'{_rule}。本盘{grade}({status_detail["三要素"]}) ⇒ '
        + (f'喜用: {"、".join(xi_yong)}; 忌: {"、".join(ji_shell)}。' if xi_yong or ji_shell else '')
        + (f'命局中已出现的喜用: {"、".join(_xi_present)}。' if _xi_present else '命局中未出现喜用五行。')
        + (f'命局中已出现的忌神: {"、".join(_ji_present)}。' if _ji_present else '')
        + '优先用命局已出现的喜用五行(力量更强)。'
    )

    # 9) 神煞
    day_gan = day_master
    day_zhi = pillars[2][1]
    # ⚠ 2026-10-31 第 182 批: 旧 SHENSHA 表在 179 批撤神煞时置空 ({}),
    # 这段还在按老键名查表 ⇒ 一跑 main() 就 KeyError 崩全盘。
    # 第 179 批已把 `shensha` 字段撤出输出, 没人消费这个局部变量 ⇒ 直接删;
    # 逐柱神煞走 pillar_shensha() (下面 10b 段), 字段暂挂状态见输出 dict 注释。

    # 10) 十二长生 (日主在四柱)
    changsheng_4 = {n: changsheng(day_master, p[1]) for n, p in zip(pillar_names, pillars)}

    # 10b) 自坐行 (2026-10-31 第 176 批) —— **每柱天干坐自己地支**的十二长生位
    #
    #   跟 changsheng_4 完全不同: changsheng_4 是「**日主**在四柱地支上的位置」,
    #   自坐是「**这一柱自己的天干**坐在**这一柱自己的地支**上」。
    #   老板 app 的自坐行: 丙寅=长生 庚子=死 乙未=养 甲申=绝
    #     → 丙长生在寅 ✓ 庚长生在巳逆行至子=死 ✓ 乙长生在午逆行至未=养 ✓ 甲长生在亥顺行至申=绝 ✓
    #   真源: 十二长生表本身 (三命通会 L1156 阳顺阴逆), 与 changsheng() 同一个函数。
    zichuan_4 = {n: changsheng(p[0], p[1]) for n, p in zip(pillar_names, pillars)}

    # 10c) 空亡行 (2026-10-31 第 176 批) —— **每柱按自己所在旬**的空亡
    #
    #   老板 app 的空亡行: 年柱戌亥 / 月柱辰巳 / 日柱辰巳 / 时柱午未
    #     → 丙寅∈甲子旬→戌亥 ✓ 庚子∈甲午旬→辰巳 ✓
    #       乙未∈甲午旬→辰巳 ✓ 甲申∈甲申旬→午未 ✓
    #   真源: 老板上课课件《08 命局神煞详解》p14「空亡查法」
    #   ⚠ 不是「全盘一个空亡」, 是**逐柱各算各的** —— 全局算一个值是常见错法。
    xunkong_4 = {n: xunkong(p[0], p[1]) for n, p in zip(pillar_names, pillars)}

    # 10d) 逐柱神煞 (2026-10-31 第 176 批)
    #   模型跟旧版不同: 旧版是「一个神煞 → 全盘哪些支」, 这里跟 app 一致 —— 逐柱列。
    pillar_shensha_map = pillar_shensha(pillars, day_master)

    # 11) 胎元 / 命宫 / 身宫
    # 胎元: 月柱 + 13 (天干进一, 地支进三, 跳过月支)
    tg_m, dz_m = mGZ.tg, mGZ.dz
    tg_tai = (tg_m + 1) % 10
    dz_tai = (dz_m + 3) % 12
    taiyuan = TIAN_GAN[tg_tai] + DI_ZHI[dz_tai]
    # ── 命宫 (2026-10-31 第 177 批重写) ──────────────────────────
    # 真源 (桌面<course-source>/<course-file>「○论坐命官」):
    #   「先将所生之月从子上起正月, 亥止上二月, 戌三 … 逆行十二位,
    #     次将所生之时加于所生之月, 顺行十二位, **逢卯即安命宫**」
    #   书里的例: 甲子年三月生戌时 ⇒ 月宫在戌, 戌时加戌上, 顺行到卯时落卯 ⇒ 命坐卯宫
    #   闭式:
    #     月宫 = (2 - 月支序) % 12                 # 正月在子, 二月在亥 … 逆行十二位
    #     命宫 = (月宫 + (卯序 - 时支序)) % 12     # 生时加于月宫, 顺行十二位, 逢卯安命
    #   干: 随年干「五虎遁」起寅宫 (甲己之年丙作首…), 从寅宫顺数到命宫支
    #
    # ⚠ 旧实现 `(14 - 出生**公历**月 - 时支序 - 1) % 12` **两处都错**:
    #   ① 把**公历月**当生月 (生月是节气月: 寅=正月 … 丑=十二月);
    #   ② 公式不是《三命通会》这套。
    #   ⇒ 命宫/身宫两格静默算错, 不抛异常 —— 跟第 176 批那四个是同族病。
    #   老板上课 app: 1986-12-17 16:20 上海 男 → 命宫**丁酉**, 本公式复现分毫不差。
    month_zhi_idx = DI_ZHI.index(pillars[1][1])    # 节气月支
    month_gong_idx = (2 - month_zhi_idx) % 12      # 生月逆行十二位
    hour_zhi_idx = DI_ZHI.index(pillars[3][1])
    minggong_idx = (month_gong_idx + 3 - hour_zhi_idx) % 12   # 顺行十二位, 逢卯安命
    minggong_zhi = DI_ZHI[minggong_idx]
    yg = yGZ.tg
    # 五虎遁: 年干 → 寅宫天干
    #   甲己→丙 / 乙庚→戊 / 丙辛→庚 / 丁壬→壬 / 戊癸→甲
    _YINGONG_GAN = {0: 2, 5: 2, 1: 4, 6: 4, 2: 6, 7: 6, 3: 8, 8: 8, 4: 0, 9: 0}
    yin_gan = _YINGONG_GAN[yg]
    minggong_gan = TIAN_GAN[(yin_gan + (minggong_idx - 2)) % 10]
    minggong = minggong_gan + minggong_zhi
    # 身宫: 同一条十二位链上「逢酉安身宫」(卯酉相冲 ⇒ 命身相对)。
    #   ⚠ 本机资料里《三命通会》只给了**命宫**起法, 没有身宫原文 ——
    #   这条是**同链推导**(锚点从卯移到酉), 不是引文。已在 UI 标注, 待老板给出处。
    shengong_idx = (month_gong_idx + 9 - hour_zhi_idx) % 12
    shengong_zhi = DI_ZHI[shengong_idx]
    shengong_gan = TIAN_GAN[(yin_gan + (shengong_idx - 2)) % 10]
    shengong = shengong_gan + shengong_zhi

    # ── 文昌位 (2026-10-31 第 178 批) ─────────────────────────────
    # 真源 (桌面<course-source>/<course-file>「如何确定孩子个人文昌位」):
    #   「尾数一字年1981、1991年正北方 … 尾数六字年1986、1996年西南方 …
    #     尾数七字年1987、1997年正西方 … 尾数零字年1990、2000年西北方」
    # ⇒ 按**公历出生年尾数**查表, 是「书桌朝向」用的方位, 不是「文昌贵人」那个地支。
    #   老板上课 app: 1986-12-17 → 尾数六 → **西南**, 与本表一字不差。
    # ⚠ 别跟四柱神煞里的「文昌贵人」(按日干查地支) 混成一条 ——
    #   那是支, 这是方位; app 的「虚空藏菩萨」块里那一格说的是方位。
    _WC_FANGWEI = {
        1: '正北', 2: '东北', 3: '正东', 4: '东南', 5: '正南',
        6: '西南', 7: '正西', 8: '西南', 9: '正西', 0: '西北',
    }
    wenchang_wei = _WC_FANGWEI[year % 10]

    # 12) 大运 (主流派: 阳男阴女顺排, 阴男阳女逆排)
    # 起运岁数 = 出生到下一个节气(顺排) / 上一个节气(逆排) 的天数 ÷ 3
    # 用 sxtwl 找前后节气
    day_jd = sxtwl.J2000 + (sxtwl.fromSolar(year, month, day).toJD() if hasattr(sxtwl.fromSolar(year, month, day), 'toJD') else 0)
    # 简化: 大运列表 (10 步, 每 10 年), 仅按顺逆排
    # ⚠️ 性别认不出来时**不许猜** (2026-10-21 实跑撞出来的):
    #   旧写法 `is_yang_gender = (gender == 'male')` —— 传 '男' 会被当成女命,
    #   阴年男命本该逆排, 结果给了顺排, 大运方向/起运/10 步干支全反, **且不报错**。
    #   工具边界 (tools/index.js `_normalizeGender`) 现在会把人话翻译成 male/female,
    #   但万一还有别的调用方漏了翻译, 这里必须**如实说不知道**, 不能默认成女命。
    #   少排一次大运, 好过给一份方向相反的"看着很完整"的错盘。
    _gender_known = (gender == 'male' or gender == 'female')
    if _gender_known:
        is_yang_year = (YINYANG_G[pillars[0][0]] == '阳')
        is_yang_gender = (gender == 'male')
        if (is_yang_year and is_yang_gender) or (not is_yang_year and not is_yang_gender):
            shun = True
        else:
            shun = False
        _paifang = '顺排' if shun else '逆排'
    else:
        shun = False
        _paifang = '未知(缺性别, 不能判顺逆)'
    # 起运：顺行取出生后最近一个“节”，逆行取出生前最近一个“节”；三天折一年。
    birth_jd_for_yun = sxtwl.toJD(sxtwl.Time(year, month, day, hour, minute, 0))
    jie_candidates = [jq.jd for jq_year in (year - 1, year, year + 1)
                      for jq in sxtwl.getJieQiByYear(jq_year) if jq.jqIndex % 2 == 1]
    if shun:
        target_jd = min((jd for jd in jie_candidates if jd >= birth_jd_for_yun), default=birth_jd_for_yun)
    else:
        target_jd = max((jd for jd in jie_candidates if jd <= birth_jd_for_yun), default=birth_jd_for_yun)
    qiyun_sui = round(abs(target_jd - birth_jd_for_yun) / 3.0, 2)
    qiyun_years = int(qiyun_sui)
    qiyun_months = int(round((qiyun_sui - qiyun_years) * 12))
    # 2026-10-08 老板要"出生后10年2月8天6时起运"这种口语化表述, 不只给 10.19 这种小数。
    # 传统折算: 三天折一年 / 一日折四月 / 一月折三十日 / 一日折十二时辰。
    qiyun_days = abs(target_jd - birth_jd_for_yun)
    _qy_years = int(qiyun_days // 3)
    _qy_rem_days = qiyun_days - _qy_years * 3
    _qy_months = int(_qy_rem_days * 4)
    _qy_rem_months = _qy_rem_days * 4 - _qy_months
    _qy_days = int(_qy_rem_months * 30)
    _qy_rem_d = _qy_rem_months * 30 - _qy_days
    _qy_hours = int(round(_qy_rem_d * 12))
    qiyun_parts = []
    if _qy_years: qiyun_parts.append(f'{_qy_years}年')
    if _qy_months: qiyun_parts.append(f'{_qy_months}月')
    if _qy_days: qiyun_parts.append(f'{_qy_days}天')
    if _qy_hours: qiyun_parts.append(f'{_qy_hours}时')
    qiyun_text = ''.join(qiyun_parts) or '0天'
    # 排大运: 从月柱顺/逆推
    start_gan = mGZ.tg
    start_zhi = mGZ.dz
    dayun_list = []
    #
    # ── 大运起始年份 / 虚岁 (2026-10-31 第 176 批重写) ──────────────
    #
    # ⚠ 旧实现是**错的**, 而且错在两个地方:
    #   1. `起始年份 = year + _qy_years` —— **把月份丢了**。
    #      起运 6年6月3天16时 ⇒ 出生年 1986 ⇒ 旧代码给 1986+6 = **1992**,
    #      但那 6年6月是 1993 年 6 月才到的 ⇒ 实际起始年应是 **1993**。
    #      (老板上课 app 给的就是 1993)
    #   2. 虚岁 = `Math.floor(起始年龄)` —— 把 6.51 岁截断成 **6岁**。
    #      虚岁不是周岁, 也不该从小数里截。
    #
    # 正确口径 (老板 2026-10-31 明说: 「年岁是按虚岁算, 按照立春这个节气来订立」):
    #   · 起运时刻落在哪一年 ⇒ 那一年就是第一步大运的起始年
    #     (起运时刻 = 出生时刻 + 起运时长, 精确到日)
    #   · 虚岁 = 起始年 − 出生年 + 1
    #     (1986 出生、1993 起运 ⇒ 1993−1986+1 = **8岁**, 与老板 app 一致)
    #   · 年份的归属按**立春**分界: 立春前算上一岁, 立春后进一岁。
    #     这一层在"流年"上尤其要紧 —— 盘古的流年干支本来就用 sxtwl 以立春为界,
    #     所以岁数也必须跟着同一把尺子, 否则会出现「干支已换年、岁数没换」的错位。
    #
    # 起运时刻 = 出生时刻 + 起运时长。起运时长按传统折算:
    #   三天折一年 / 一天折四月 / 一时辰折十天 ⇒ 用它把「出生到节气的天数」折成年月时。
    # (折算值直接复用上面已经算好的 _qy_years/_qy_months/_qy_days, 不重算一遍)
    # 起运时刻对应的公历年:
    #   **按真实日历把 (年, 月, 天) 加到出生日期上**, 取那一天的年份。
    #   不能粗判「有月份就 +1 年」—— 1978-07-14 起运 8 年 1 月 = **1986-08-14**,
    #   仍在 1986 年内 (粗判会错成 1987)。
    #   也不能只加整年—— 1986-12-17 起运 6 年 6 月 = 1993-06-17 (老板 app 给的 1993)。
    _qiyun_y, _qiyun_m, _qiyun_d = _add_years_months_days(
        year, month, day, _qy_years, _qy_months, _qy_days)
    _qiyun_year = _qiyun_y
    # 交运日 = 起运时刻落在的那**一天**; 交运的**节气点** = 那天之后的下一个节气交接。
    #
    #   老板 app 的写法: 「交运: 逢癸、戊年, 芒种后15天交大运」
    #   拆开就是三件事:
    #     · 逢癸、戊**日** ⇒ 交运当日的**日干**是癸或戊
    #     · 芒种后15天    ⇒ 从上一个节气(芒种)算起第 15 天
    #   验: 1993 芒种 = 06-06 00:15, +15 天 = **06-21**, 而 06-21 的日干支 = **癸酉** ✓
    #   (06-21 16:59 正是夏至 —— 交运的时辰点)
    #   ⇒ 我们的起运日算法算出来就是 1993-06-21, 与 app 完全一致。
    _qiyun_day_ganzhi = ''
    _qiyun_jieqi = ''
    try:
        _t = sxtwl.fromSolar(_qiyun_y, _qiyun_m, _qiyun_d)
        _dgz = _t.getDayGZ()
        _qiyun_day_ganzhi = TIAN_GAN[_dgz.tg] + DI_ZHI[_dgz.dz]
    except Exception:
        _qiyun_day_ganzhi = ''
    # 交运节气: 出生后第一个「节」(顺排) / 最后一个「节」(逆排) 的交接时刻
    for _jq in sorted(sxtwl.getJieQiByYear(_qiyun_y), key=lambda x: x.jd):
        _jd = _jq.jd
        if _jd >= sxtwl.toJD(sxtwl.Time(_qiyun_y, _qiyun_m, _qiyun_d, 12, 0, 0)):
            _dd = sxtwl.JD2DD(_jd)
            _qiyun_jieqi = f'{_dd.M}月{_dd.D}日'
            break
    # 虚岁基准: 出生在**立春前** ⇒ 生日年算上一年 (与年柱口径一致)。
    #   sxtwl 的年柱本来就是以立春换年的 ⇒ 岁数跟同一把尺子, 不两把尺子。
    _birth_jd = sxtwl.toJD(sxtwl.Time(year, month, day, hour, minute, 0))
    _lichun_jd = _lichun_jd_of(year)
    _birth_lichun_year = year if _birth_jd >= _lichun_jd else year - 1

    def _xusui(y):
        """该公历年在立春分界下的虚岁 (与出生年比)。"""
        return y - _birth_lichun_year + 1
    # 性别未知 → 不排。空列表是诚实的: 上游看到空就知道"这步没做",
    # 看到一个方向相反的满列表就会当成真盘去解读。
    for i in (range(1, 11) if _gender_known else ()):
        if shun:
            g = (start_gan + i) % 10
            z = (start_zhi + i) % 12
        else:
            g = (start_gan - i) % 10
            z = (start_zhi - i) % 12
        dayun_list.append({
            '序': i,
            '干支': TIAN_GAN[g] + DI_ZHI[z],
            '起始年龄': round(qiyun_sui + (i - 1) * 10, 2),
            # 起始年 = 起运时刻落在的那一年 (不是 出生年+整年 —— 那样会丢月份)。
            '起始年份': _qiyun_year + (i - 1) * 10,
            # 起始日 = 起运时刻本身 (第一步是起运当天, 后每步 +10 年)。
            '起始日期': f'{_qiyun_year + (i - 1) * 10}-{_qiyun_m:02d}-{_qiyun_d:02d}',
            # 虚岁 (老板 2026-10-31: 年岁按虚岁、按立春分界)。
            '起始虚岁': _xusui(_qiyun_year + (i - 1) * 10),
            '十神': get_shishen(day_master, TIAN_GAN[g]),
            # 2026-10-08 老板: 干支上下排列, 天干地支各配一个十神(地支取藏干本气)
            '地支十神': get_shishen(day_master, ZHI_BENQI[DI_ZHI[z]]),
            # 2026-10-31 第 177 批: 大运表的「性运」行 (app 有, 盘古原来没有)。
            #   查法 = **日主**坐大运地支的十二长生宫位 (跟四柱表的「星运」同一把尺子,
            #   不是大运天干坐自己地支的「自坐」)。
            #   老板 app 1986-12-17 盘(乙日) 的大运性运:
            #     辛丑衰 壬寅帝旺 癸卯临官 甲辰冠带 乙巳沐浴
            #     丙午长生 丁未养   戊申胎   己酉绝   庚戌墓
            #   ⇒ 跟 `changsheng(日主, 大运地支)` 逐格吻合 (乙长生在午、逆行)。
            '性运': changsheng(day_master, DI_ZHI[z])
        })

    # 流年：出生年起列出 90 年，干支年以立春为界，由 sxtwl 计算。
    liunian = []
    for liunian_year in range(year, year + 90):
        liunian_day = sxtwl.fromSolar(liunian_year, month, day)
        liunian_gz = liunian_day.getYearGZ()
        liunian_gan = TIAN_GAN[liunian_gz.tg]
        # 2026-10-08 老板要流月: 每年 12 个月各一月柱(干支+十神), 以立春为界。
        liuyue = []
        for m in range(1, 13):
            mgz = sxtwl.fromSolar(liunian_year, m, day).getMonthGZ()
            mgan = TIAN_GAN[mgz.tg]
            liuyue.append({
                '月': m,
                '干支': mgan + DI_ZHI[mgz.dz],
                '十神': get_shishen(day_master, mgan),
                '地支十神': get_shishen(day_master, ZHI_BENQI[DI_ZHI[mgz.dz]]),
            })
        liunian.append({
            '年份': liunian_year,
            '干支': liunian_gan + DI_ZHI[liunian_gz.dz],
            '十神': get_shishen(day_master, liunian_gan),
            '地支十神': get_shishen(day_master, ZHI_BENQI[DI_ZHI[liunian_gz.dz]]),
            '流月': liuyue,
        })

    # 13) 冲 / 合 / 刑 / 害 / 破
    # 简化: 只查四柱地支
    CHONG = {('子','午'),('丑','未'),('寅','申'),('卯','酉'),('辰','戌'),('巳','亥')}
    HE = {('子','丑'),('寅','亥'),('卯','戌'),('辰','酉'),('巳','申'),('午','未')}
    XING = {('寅','巳'),('巳','申'),('申','寅'),('丑','戌'),('戌','未'),('未','丑'),
            ('子','卯'),('卯','子'),('辰','辰'),('午','午'),('酉','酉'),('亥','亥')}
    HAI = {('子','未'),('丑','午'),('寅','巳'),('卯','辰'),('申','亥'),('酉','戌')}
    PO  = {('子','酉'),('丑','辰'),('寅','亥'),('卯','午'),('巳','申'),('未','戌')}

    zhizis = [p[1] for p in pillars]
    chong_list, he_list, xing_list, hai_list, po_list = [], [], [], [], []
    for i in range(4):
        for j in range(i+1, 4):
            pair = tuple(sorted([zhizis[i], zhizis[j]]))
            if pair in CHONG: chong_list.append(f'{pillar_names[i]}({zhizis[i]}) 冲 {pillar_names[j]}({zhizis[j]})')
            if pair in HE: he_list.append(f'{pillar_names[i]}({zhizis[i]}) 合 {pillar_names[j]}({zhizis[j]})')
            if pair in XING: xing_list.append(f'{pillar_names[i]}({zhizis[i]}) 刑 {pillar_names[j]}({zhizis[j]})')
            if pair in HAI: hai_list.append(f'{pillar_names[i]}({zhizis[i]}) 害 {pillar_names[j]}({zhizis[j]})')
            if pair in PO: po_list.append(f'{pillar_names[i]}({zhizis[i]}) 破 {pillar_names[j]}({zhizis[j]})')

    # ============ 输出 ============
    result = {
        'input': {'year': year, 'month': month, 'day': day, 'hour': hour, 'minute': minute,
                  'gender': gender, 'city': city, 'use_solar_time': use_solar_time,
                  'calendar': input_calendar, 'is_leap_month': bool(is_leap_month)},
        # 虚岁基准年 (2026-10-31 第 176 批):
        #   立春前出生 ⇒ 生日年算上一年 (与年柱同一把尺子)。
        #   虚岁 = 该年 − 这个基准年 + 1。
        #   前端不再自己拿「公历年 − 出生年」算 (那是周岁, 而且没过分界)。
        'birth_lichun_year': _birth_lichun_year,
        # 顶层也带一份性别 (2026-10-31 第 176 批):
        #   四柱表「日柱主星」要显示「元男/元女」, 那个词跟的是**命主性别**,
        #   不是日元阴阳 ⇒ 前端必须能直接读到性别, 不许自己从日干阴阳推。
        #   值是**已归一化**的 'male'/'female'/'unknown' (工具层翻译过), 前端不用再猜。
        'gender': gender,
        'adjusted_hour': adj_hour,
        'adjusted_minute': adj_minute,
        'time_correction_minutes': diff_min if (use_solar_time and city != 'default') else 0,
        'solar_time_city_matched': bool(getattr(calc_solar_time, 'last_match', False)),
        # 真太阳时经度从哪儿来的 —— 命中层级 + 是不是近似值, 让模型看得见。
        #   命中「默认」= 没查到出生地经度, 误差可能 1~3 小时, 时柱可能错。
        'solar_time_source': {
            '层级': _st_level,
            '近似值': _st_approx,
            '说明': _st_note,
            # 2026-10-31 第 176 批: 均时差拆开给, 让人看得见「经度 + 均时差」两笔账。
            #   只给一个总修正分钟数, 出问题时不知道是哪一头错了。
            '均时差(分钟)': eot_min,
            '经度修正(分钟)': round(diff_min - eot_min, 2),
            '合计修正(分钟)': diff_min,
        },
        # 第 131 批: 真太阳时**跨日**时, 四柱按有效日期排, 这里显式给出,
        #   免得模型拿 public_date 去对四柱, 对不上还以为引擎算错。
        'solar_date': f'{eff_y}年{eff_m}月{eff_d}日 {adj_hour}时{adj_minute}分',
        'solar_date_shift_days': int(day_shift),
        # 晚子时口径(写明, 免得模型自己猜): 本引擎走**早子时派** ——
        #   23:00–23:59 的时干按**次日**日干推, 而**日柱仍留在当天**。
        #   (换日派则会把日柱也推到次日; 两派都有人用, 这里沿用 sxtwl 的默认,
        #    属口径选择, 不是 bug。要改成换日派请显式改这里, 别在别处偷偷改。)
        'zishi_convention': '早子时派: 23:00 起的时干按次日日干推, 日柱不变',
        'hour_pillar_next_day_stem': bool(adj_hour == 23),
        'public_date': f'{year}年{month}月{day}日 {hour}时{minute}分',
        'lunar': lunar,
        'weekday': weekday,
        'constellation': constellation,
        'pillars': dict(zip(pillar_names, pillars)),
        'day_master': day_master,
        'day_master_wuxing': dm_wx,
        'day_master_yinyang': YINYANG_G[day_master],
        'cang_gan': cang_gan,
        'nayin_4': nayin_4,
        'shishen_tiangan': shishen_g,
        'shishen_dizhi': {f'{n}支': [{'干':cg['干'], '十神':cg['十神']} for cg in cang_gan[n]]
                         for n in pillar_names},
        'changsheng_4': changsheng_4,
        'month_branch': month_zhi,
        'month_wuxing': month_wx,
        'season': season,
        'month_benqi': benqi,
        'status': status,
        'status_reason': status_reason,
        # 2026-10-28 第 130 批: 旺衰的**等级**与**依据**单列出来。
        #   status (旺/弱/中和) 是三值简写, 给老消费方用;
        #   status_grade (强/偏强/均衡/…) 与 status_detail (三要素逐条) 才是给模型看的真相。
        'status_grade': grade,
        'status_detail': status_detail,
        'wuxing_count': wx_count,
        'wuxing_count_int': wx_count_int,
        'xi_yong': xi_yong,
        'ji_shell': ji_shell,
        'xi_yong_present': _xi_present,
        'ji_shell_present': _ji_present,
        'cai_xing': cai_xing,
        'xi_yong_reason': xi_yong_reason,
        'taiyuan': taiyuan,
        'minggong': minggong,
        'shengong': shengong,
        'wenchang_wei': wenchang_wei,
        # ── 神煞字段: 2026-10-31 第 182 批**恢复** ────────────────────
        #   老板指示: 神煞按课件 08/09 补齐后恢复输出。
        #   `shensha_by_pillar` = 逐柱神煞 (新引擎 pillar_shensha())
        'shensha_by_pillar': pillar_shensha_map,
        'zichuan_4': zichuan_4,
        'xunkong_4': xunkong_4,
        'chong': chong_list,
        'he': he_list,
        'xing': xing_list,
        'hai': hai_list,
        'po': po_list,
        'jieqi': {
            '今日有节气': has_jq,
            '月令': f'{month_zhi}月({benqi}旺)',
        },
        'dayun': {
            '排法': _paifang,
            # 缺性别时起运岁数/起运文案同样不可信(它们由顺逆决定), 一并留空
            '起运岁数': qiyun_sui if _gender_known else None,
            '起运': qiyun_text if _gender_known else '',
            # 交运 (2026-10-31 第 176 批): 起运时刻落在的那一天 + 那一日的日干支 + 节气点。
            #   老板 app: 「逢癸、戊年, 芒种后15天交大运」
            #   本盘: 交运日 1993-06-21, 日干支 癸酉, 节气 夏至
            '交运日期': f'{_qiyun_y}-{_qiyun_m:02d}-{_qiyun_d:02d}' if _gender_known else '',
            '交运日干支': _qiyun_day_ganzhi if _gender_known else '',
            '交运节气': _qiyun_jieqi if _gender_known else '',
            '列表': dayun_list,
        },
        'liunian': liunian,
        'source': 'sxtwl 万年历真实排盘 (v2 完整字段)',
    }

    # ============ 查法真源 (调候 / 通关 / 大运互动) — 2026-11-07 P0 判断轴换轨 ============
    # 真源在 /Users/you/Desktop/course-source*.json (不进 repo), 只读表不推演。
    # 新资料=加 JSON entry, 不碰代码 (老板 2026-11-07 架构决策)。

    # ① 调候: 日主五行 + 季节 查表
    _th = tiaohou_lookup(dm_wx, season)
    _tiaohou = {
        '适用': bool(_th),
        '倾向': _th.get('倾向', ''),
        '调候需': _th.get('调候需', []),
        '注': _th.get('注', ''),
    }

    # ② 通关: 原局五行计数里「两行交战且都强」的对, 查通关五行
    _wx_cnt = wx_count_int or {}
    _tongguan = {'交战对': [], '通关需': [], '原理': []}
    for _a, _b in [('水','火'),('木','金'),('火','金'),('土','木'),('金','土')]:
        if _wx_cnt.get(_a,0) >= 2 and _wx_cnt.get(_b,0) >= 2:
            _e = tongguan_lookup([_a,_b])
            if _e:
                _tongguan['交战对'].append([_a,_b])
                _tongguan['通关需'].append(_e.get('通关',''))
                _tongguan['原理'].append(_e.get('原理',''))

    # ③ 大运互动: 每个大运标「命中哪条 rule」(只做命中级标注, 细判留给 prompt)
    #   冲月令: 用本地 CHONG 表的逆查 (大运地支 vs 月令地支)
    _CHONG_REV = {}
    for _k in ('子','午'),('丑','未'),('寅','申'),('卯','酉'),('辰','戌'),('巳','亥'):
        _CHONG_REV[_k[0]] = _k[1]; _CHONG_REV[_k[1]] = _k[0]
    _ji_prefix2 = {j[:2] for j in (ji_shell or [])}
    for _dy in dayun_list:
        _hits = []
        _dz_sh = _dy.get('十神','')
        _dz2_sh = _dy.get('地支十神','')
        # 忌神引动: 大运天干/地支十神 ∈ 忌神
        if (_dz_sh in _ji_prefix2 or _dz2_sh in _ji_prefix2 or
            _dz_sh in [j for j in (ji_shell or [])] or _dz2_sh in [j for j in (ji_shell or [])]):
            _hits.append('dayun_jishen_yin')
        # 冲月令: 大运地支冲月令
        _dy_zhi = _dy['干支'][1]
        if _CHONG_REV.get(month_zhi,'') == _dy_zhi:
            _hits.append('dayun_chong_yueling')
        _dy['互动命中'] = _hits

    result['tiaohou'] = _tiaohou
    result['tongguan'] = _tongguan
    result['shazhen_meta'] = {
        '体系': 'bazi',
        '真源目录': os.environ.get('SHAZHEN_ROOT',
            str(Path.home()/'Desktop/<course-source>/<course-file>')),
        '说明': '查法真源跟代码解耦; 新资料=加 JSON entry, 不碰代码。',
    }

    # 盲派轨 (2026-11-07 第 214 批): 跟子平轨并列的独立轨, 喜忌不跨轨污染。
    # 软导入兜底: mangpai/shazhen 缺失时 盲派={'可用':False,...}, 不崩不丢子平轨。
    try:
        import mangpai as _mangpai
        result['盲派'] = _mangpai.duan(result, gender=gender)
    except Exception as _e:
        result['盲派'] = {'可用': False, '说明': f'盲派轨加载失败: {_e}'}
    # ④ 流年引动 (2026-11-07 第 211 批, P0 判断轴换轨): 取最近 6 个流年,
    #   标「命中哪类引动」(忌神爆发/伏吟反吟/冲月令), 吉凶档位+应期解读留给模型。
    _recent_liunian = liunian[-6:] if len(liunian) >= 6 else liunian
    _cur_dy_gz = dayun_list[-1]['干支'] if dayun_list else ''
    _liunian_yindong = []
    for _ln in _recent_liunian:
        _ln_zhi = _ln['干支'][1]
        _ln_sh = _ln['十神']
        _marks = []
        if _ln_sh in [j for j in (ji_shell or [])] or _ln_sh[:2] in _ji_prefix2:
            _marks.append('liunian_jishen_baofa')
        if _cur_dy_gz:
            if _ln['干支'] == _cur_dy_gz:
                _marks.append('liunian_zhongchong(伏吟)')
            elif _CHONG_REV.get(_ln_zhi, '') == _cur_dy_gz[1]:
                _marks.append('liunian_zhongchong(反吟)')
        if _CHONG_REV.get(month_zhi, '') == _ln_zhi:
            _marks.append('liunian_chong_yueling')
        _liunian_yindong.append({'年份': _ln['年份'], '干支': _ln['干支'],
                                  '十神': _ln_sh, '引动命中': _marks})
    result['liunian_yindong'] = _liunian_yindong
    return result

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='八字排盘')
    parser.add_argument('year', type=int, nargs='?', default=1991)
    parser.add_argument('month', type=int, nargs='?', default=11)
    parser.add_argument('day', type=int, nargs='?', default=23)
    parser.add_argument('hour', type=int, nargs='?', default=7)
    parser.add_argument('minute', type=int, nargs='?', default=0)
    parser.add_argument('gender', nargs='?', default='unknown')
    parser.add_argument('--city', default='default')
    parser.add_argument('--district', default='')
    parser.add_argument('--province', default='')
    parser.add_argument('--no-solar-time', action='store_true')
    parser.add_argument('--lunar', action='store_true')
    parser.add_argument('--leap-month', action='store_true')
    args = parser.parse_args()
    print(json.dumps(main(args.year, args.month, args.day, args.hour, args.gender,
                           args.city, not args.no_solar_time, args.minute,
                           args.lunar, args.leap_month,
                           args.district, args.province), ensure_ascii=False, indent=2))
