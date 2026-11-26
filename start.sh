#!/bin/bash
# 盘古启动脚本 — 单进程模式 (2026-10-26 第 107 批: 桌面端下线, 不再装 desktop 依赖)
cd "$(dirname "$0")"

# 检查依赖
if [ ! -d "apps/core/node_modules" ]; then
  echo "[启动] 安装 core 依赖..."
  cd apps/core && npm install && cd ../..
fi

echo "[启动] 盘古 (Core)..."
cd apps/core
node pangu-single.js
