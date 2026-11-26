'use strict';

// 2026-10-20 浏览器实测 (工具集 = 盘古的"商店/结账"流程) 挖出来的四个坑, 这里钉住。
// 背景: 点「安装」→ 15.4s 后界面报成功, 实际落了一个 529 字节的 mock 空壳 SKILL.md
// (2026-09-13 老板拍「mock 空壳禁止安装」被网络抖动架空), 同时整个 daemon 被冻 14.09s。
//
// ── 2026-10-26 第 107 批 (桌面端下线) ──
// 原来最后两条各有一半是查前端 (Marketplace.jsx):
//   · "后端按 frontmatter 的 source 标记, 前端「自建」筛选才认得出"
//     → 拆开: 后端那半 (meta.js 按 frontmatter 打 source) **保留**;
//       前端那半 (s.source === 'pangu-form') 随界面一起删。
//   · "危险操作不许用原生 confirm (会冻渲染进程, 自动化点不动)"
//     → 整条删。它守的是"别用 window.confirm", 是界面实现约束。
// 其余四条全是服务端真不变量, 一条没松。

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const routerPath = path.join(__dirname, '../pangu-single/routes/inline_router.js');
const metaPath = path.join(__dirname, '../pangu-single/routes/pangu-meta.js');

const router = fs.readFileSync(routerPath, 'utf8');
const meta = fs.readFileSync(metaPath, 'utf8');

// 把某段路由切出来, 避免整文件 grep 命中别处 (踩坑日志 10-19: 断言写成"某物出现过"= 假绿)
function routeBlock(src, marker, endMarker) {
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, `找不到路由标记: ${marker}`);
  const end = endMarker ? src.indexOf(endMarker, start) : src.length;
  return src.slice(start, end === -1 ? src.length : end);
}

const installBlock = routeBlock(router, "/api/marketplace/install'", "/api/marketplace/uninstall'");
const detailBlock = routeBlock(router, "/api/marketplace/detail/", "LM Studio model.yaml");
const createBlock = routeBlock(router, "/api/pangu/skills/create-from-form'", "/api/pangu/skills/import-from-path'");
const deleteBlock = routeBlock(router, "pathname.startsWith('/api/pangu/skills/')", "/api/credentials/set");

test('安装拉不到真源时必须明说失败, 不许落 mock 空壳', () => {
  // 2026-09-13 老板拍: mock 空壳禁止安装 (装上只有名字零指令, 欺骗模型)
  assert.match(installBlock, /GITHUB_FETCH_FAILED/);
  // 空壳模板整个删掉 —— 留着就是给"拉失败"留后门
  assert.doesNotMatch(installBlock, /mock: true/);
  assert.doesNotMatch(installBlock, /mock 安装/);
});

test('拉真源失败时连空目录都不许留 (先拉后建)', () => {
  const fetchAt = installBlock.indexOf('_fetch_anthropics_skill_md_async');
  const mkdirAt = installBlock.indexOf('mkdirSync');
  assert.notEqual(fetchAt, -1, 'install 路由里应该先拉真源');
  assert.notEqual(mkdirAt, -1, 'install 路由里应该建目录');
  assert.ok(fetchAt < mkdirAt, '必须先拿到真源再建目录, 否则失败时会留一个空 skill 目录');
});

test('GitHub 真源拉取不许再冻事件循环 (不用 execSync 同步 curl)', () => {
  assert.doesNotMatch(router, /_fetch_anthropics_skill_md_sync/);
  assert.doesNotMatch(router, /_fetch_anthropics_index_sync/);
  const fetchBlock = routeBlock(router, 'async function _gh_fetch(', 'function _anthropics_to_entry');
  assert.doesNotMatch(fetchBlock, /execSync/);
  assert.match(fetchBlock, /GH_FETCH_ATTEMPTS/);  // 要重试: 这台机器到 raw.githubusercontent.com 约 1/4 概率连不上
  assert.match(fetchBlock, /AbortController/);
});

test('自建 Skill 真的落盘, 表单字段不许丢', () => {
  assert.match(createBlock, /source: pangu-form/);
  assert.match(createBlock, /SKILL\.md/);
  assert.match(createBlock, /command/);
  assert.doesNotMatch(createBlock, /spec: req_body\.spec \|\| \{\}/);  // 原来只读 req_body.spec, 表单一律丢光
});

test('删除自建 Skill 要连磁盘目录一起删', () => {
  assert.match(deleteBlock, /rmSync/);
  assert.match(deleteBlock, /skills/);
});

test('后端按 frontmatter 的 source 标记, 自建 skill 才认得出', () => {
  // 服务端这一半必须留: 没有 source 标记, 调用方就分不清哪个是自建、哪个是目录装的。
  assert.match(meta, /source: fmSource \|\| 'dir'/);
});

