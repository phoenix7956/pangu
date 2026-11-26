#!/usr/bin/env python3
# bazi_calc.py — 已弃用转发壳 (2026-09-22 老板拍)
# 唯一真源 = tools/bazi/bazi_calc.py. 本文件直接转发, 保证双份永不漂移.
# 直接跑本脚本 (python3 modules/bazi/bazi_calc.py ...) 也能工作, 实际逻辑在 tools/bazi/.
import os, sys, runpy

_HERE = os.path.dirname(os.path.abspath(__file__))
_REAL = os.path.normpath(os.path.join(_HERE, '..', 'tools', 'bazi', 'bazi_calc.py'))
if not os.path.exists(_REAL):
    print('bazi_calc 真源缺失: ' + _REAL, file=sys.stderr)
    sys.exit(1)

# 转发: 以真源路径执行, 透传 argv
if __name__ == '__main__':
    sys.argv[0] = _REAL
    runpy.run_path(_REAL, run_name='__main__')
