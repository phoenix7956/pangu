#!/usr/bin/env python3
# lunar_info.py — 梅花易数时间起卦专用: 公历 → 农历月日 + 年支数 + 时支数
# 复用 bazi_calc 的 sxtwl 桥模式 (/usr/bin/python3 有 sxtwl)
# 用法: python3 lunar_info.py <year> <month> <day> [hour]
import sys
import json
import sxtwl

def main(year, month, day, hour=12):
    day_obj = sxtwl.fromSolar(year, month, day)
    year_gz = day_obj.getYearGZ()  # 干支年 (立春换年, 正统)
    lunar_month = day_obj.getLunarMonth()
    lunar_day = day_obj.getLunarDay()
    is_leap = day_obj.isLunarLeap()
    hour_zhi_idx = (hour + 1) // 2 % 12  # 子=0..亥=11
    return {
        'lunar_month': lunar_month,
        'lunar_day': lunar_day,
        'lunar_leap': bool(is_leap),
        'year_zhi_num': year_gz.dz + 1,   # 年支序数: 子1丑2...亥12 (梅花取数)
        'hour_zhi_num': hour_zhi_idx + 1, # 时支序数: 子1丑2...亥12
        'year_ganzhi': '甲乙丙丁戊己庚辛壬癸'[year_gz.tg] + '子丑寅卯辰巳午未申酉戌亥'[year_gz.dz],
    }

if __name__ == '__main__':
    y, m, d = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
    h = int(sys.argv[4]) if len(sys.argv) > 4 else 12
    print(json.dumps(main(y, m, d, h), ensure_ascii=False))
