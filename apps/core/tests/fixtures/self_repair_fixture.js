// 自愈测试用夹具 — 故意留一个会在运行期炸的写法 (读取可能为 undefined 的值)
// 模拟事故: TypeError: Cannot read properties of undefined (reading 'trim')
'use strict';

function normalizeTitle(input) {
  const s = input.title.trim();
  return s.toLowerCase();
}

module.exports = { normalizeTitle };
