'use strict';
/**
 * tools_schema/divination.js —— 工具参数 Schema 的一段 (第 97 批从 tools_schema.js 拆出)
 *
 * 拆分纪律 (三条, 一条都不能破):
 *   1. **顺序不变** —— 工具顺序会进 LLM 提示词, 分段必须连续、合并必须按序
 *   2. **内容逐字不变** —— 守卫 tests/tools-schema-split-20261025.test.js 用
 *      拆分前抓的基线 (130 个工具的顺序 + 每个 schema 的 sha1) 逐个对
 *   3. **不改词表** —— 这里只放 schema, 一行语义都不许动
 */

module.exports = {
    bazi_calc: {
      type: 'function',
      function: {
        name: 'bazi_calc',
        description: '八字排盘 (sxtwl 万年历)',
        parameters: {
          type: 'object',
          properties: {
            year: { type: 'number', description: '出生年份(公历), 例 1991' },
            month: { type: 'number', description: '出生月份(公历), 1-12' },
            day: { type: 'number', description: '出生日(公历), 1-31' },
            hour: { type: 'number', description: '出生小时(0-23), 默认 12 (午时). 7点=辰时' },
            minute: { type: 'number', description: '出生分钟(0-59), 默认 0' },
            // ⚠️ 描述必须写明接受人话 (2026-10-21 E2E 实跑):
            //   这里原来只写 "male/female", 模型据此传 'male' 没事,
            //   但**主人说「男」时**很多人/模型会直接传 '男',
            //   而 python 只认 'male' → 静默当成女命 → 大运顺逆全反, 不报错。
            //   现在边界会归一化(男/女/男命/乾/male/true/1 都认),
            //   但描述也得说实话, 免得调用方以为只有两种写法。
            gender: { type: 'string', description: '性别, 决定大运顺排还是逆排。接受 男/女 (也认 male/female、true/false、1/0)。**缺这个参数大运就不排** —— 顺逆判不出来时宁可留空也不能猜。' },
            province: { type: 'string', description: '出生省/自治区/直辖市' },
            city: { type: 'string', description: '出生城市，如北京、上海；用于真太阳时，未命中城市表则用东经120度' },
            district: { type: 'string', description: '出生区/县' },
            use_solar_time: { type: 'boolean', description: '是否启用真太阳时修正，默认 true' },
            is_lunar: { type: 'boolean', description: '是否将 year/month/day 按农历解释，默认 false（阳历）' },
            is_leap_month: { type: 'boolean', description: '农历输入是否为闰月，默认 false' },
            liunian_months: {
              type: 'boolean',
              description: '是否带上每条流年下的 12 条流月明细（每月干支/十神），默认 false。'
                + '默认不带是因为它占整个返回的 82%（实测 53,423 → 7,700 字符），'
                + '会把结果撞上工具结果预算、被截断成模型看不见的半截。'
                + '只问"哪一年"不需要它；用户问到"某年某月"时置 true 重调一次。'
            }
          },
          required: ['year', 'month', 'day']
        },
        meta: { required_capabilities: ['chinese'] }}
    },
    fengshui_calc: {
      type: 'function',
      function: {
        name: 'fengshui_calc',
        // 2026-10-23 第 69 批: 风水门接进生产。
        //   第 68 批把风水内核做出来了(命卦/宅卦/大游年/阳宅四要/三元九运),
        //   但**模型够不着** —— 没有工具就没入口, 「内核里很完整、模型看不见」= 没做。
        //
        //   描述里只写「什么时候调 / 怎么填 / 结果怎么用」三件事:
        //     · 篇幅有预算 —— 同一个 TOOLS_SCHEMA 会按角色白名单打包发给上游,
        //       li 角色的那一份已经 8987/9000(只剩 13 字符) ⇒ **fengshui_calc 只进 main**,
        //       不进 li 的白名单(见 MAIN_GENERAL_TOOLS_FOR_LLM)。
        //     · ⚠️「提示里的词会被模型原样搬去当开篇标签」(10-21 实跑教训) ——
        //       所以这里不描述答案该长什么样。
        description: [
          '风水排盘 —— 八宅/风水: 命卦、宅卦、大游年八方吉凶、阳宅四要(门/主卧/灶/厕)、三元九运。',
          '【何时调】主人问住宅方位吉凶、门主卧灶厕该放哪、坐山朝向、宅命配不配、现在第几运时。',
          '【怎么填】year=出生年(公历, 算命卦用), gender=男/女;',
          '  sitting=坐山或朝向(子/午…24山, 或「坐北向南」「子山午向」「坎」); houseYear=入伙年。',
          '  缺料就少传那一项 —— 缺什么这一项就跳过, 别的照出。',
          '【结果】一段带身份标签的风水盘: 命卦/宅卦/八方吉凶星/四要方位清单/宅命相配/宅运。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            year: { type: 'number', description: '出生年(公历), 例 1991。算命卦用, 不给就跳过命卦' },
            gender: { type: 'string', description: '性别, 算命卦用。男/女(也认 male/female)' },
            sitting: { type: 'string', description: '坐山或朝向: 山名(壬子癸丑艮寅甲卯乙辰巽巳丙午丁未坤申庚酉辛戌乾亥) 或「坐北向南」「子山午向」或卦名(坎离震巽乾坤艮兑)' },
            house_year: { type: 'number', description: '房屋建造/入伙年, 用来定第几运' },
          },
        }
      }
    },
};
