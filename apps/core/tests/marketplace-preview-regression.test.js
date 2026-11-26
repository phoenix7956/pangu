'use strict';

// 2026-10-26 第 107 批 (桌面端下线):
// 原来两条:
//   ① 前端详情弹窗不得给"仅预览"条目显示可安装动作 —— 纯界面层, 随前端下线而删
//   ② 后端继续拒绝没有真实来源的 marketplace 条目 —— **服务端真不变量, 保留**
//      (MOCK_NOT_INSTALLABLE 是老板 2026-09-13 拍"mock 空壳禁止安装"的落地,
//       跟有没有界面无关 —— 任何客户端调用都必须被拒)
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const router = fs.readFileSync(path.join(__dirname, '../pangu-single/routes/inline_router.js'), 'utf8');

test('后端继续拒绝没有真实来源的 marketplace 条目', () => {
  assert.match(router, /MOCK_NOT_INSTALLABLE/);
});
