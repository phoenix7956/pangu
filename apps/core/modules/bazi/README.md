# bazi/ — 已弃用 (2026-09-22 老板拍)

八字排盘推演**唯一真源** = `apps/core/modules/tools/bazi/bazi_calc.py`。
工具层 `tools/index.js` 的 `bazi_calc` 只调 `tools/bazi/`，**不再**读本目录。

`bazi_calc.py` 现在是**转发壳** — 直接跑本脚本会 `runpy` 转发到 `tools/bazi/bazi_calc.py`（真源），
直接跑也能工作，但**改本文件没用**（逻辑全在真源）。要改八字排盘，只改 `tools/bazi/bazi_calc.py`。
（`lunar_info.py` 仍未被真源 import，留作参考。）

- 工具入口: `bazi_calc` 工具 (tools_schema 注册) / 前端 BaziView `api.toolTest('bazi_calc', ...)`
- 真源: `tools/bazi/bazi_calc.py` (系统 Python `/usr/bin/python3` 带 sxtwl)
