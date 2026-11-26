# core/ — DEPRECATED (2026-07-14)

**状态**: 9 文件全部 deprecated, 0 引用, 待归档

**真因**: 这批代码来自旧项目遗留, 主人 7-14 拍板归档 (跟 §0.7 self-evolution + 全栈扫描结论一致)。

**为何不直接删**: 
- 备份已存 `_archive/2026-07-14-core/core.bak/` (88KB 完整副本)
- `.deprecated.js` 后缀让 IDE / require 失败但保留 git 历史
- 老板拍 "不删, 改加 DEPRECATED 注释" (7-14 18:00)

**Pangu 当前核心**:
- `pangu-single.js` (主进程)
- `agents/` (8 Agent Cluster, 含真 class-compat.js)
- `modules/` (92 in-process tools)
- `64i/` (64 卦本体数据)

**复活路径**: 如要复用 core/ 代码, 从 `_archive/2026-07-14-core/core.bak/` cp 回来, 改名去 `.deprecated` 后缀。
