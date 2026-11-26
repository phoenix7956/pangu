'use strict';
// 第 134 批: Web 端「漏 import ⇒ 整个组件静默死掉」守卫
//
// 现场 (老板点「最近会话」, 面板展开是空的, 界面无感):
//   apps/core/web/app/components/session-sidebar.mjs 用了 `elHTML` 却**没导入**
//   ⇒ paint() 里给删除按钮画图标时抛 ReferenceError
//   ⇒ **整份列表一项都画不出来** (appendChild 在抛错之后, 一条都没进 DOM)
//   ⇒ 控制台只有一条 unhandledrejection, 页面上看不出来。
//   这个侧栏是 2026-09-03 从原版 desktop 搬过来的, 搬完就一直是死的。
//
// 这类病的特征: **代码在、测试绿、界面不画**。
//   纯函数守卫测不出来 (它不测运行时), 所以只能静态查「用了但没导入」。
//
// 本守卫要证明:
//   G134w · 每个 web 模块里用到的 util 导出名, 都必须真的被导入
//   G134w2 · 本地自己声明的同名函数不算漏 (别误伤)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..', 'web', 'app');
const UTIL = path.join(APP, 'lib', 'util.mjs');

function _walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) _walk(abs, out);
    else if (e.name.endsWith('.mjs')) out.push(abs);
  }
  return out;
}

// util.mjs 导出的名字 (export function / export const / export { a, b } 再导出)
function _utilExports() {
  const src = fs.readFileSync(UTIL, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim().split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
    }
  }
  return names;
}

// 扫「真的在用这个标识符」之前, 先把注释和字符串字面量剥掉 ——
//   否则 `card` / `hint` / `table` / `json` 这些常见词在文案里一堆,
//   守卫会变成「78 处误报」然后被人加白名单绕过去 (那等于没守卫)。
function _stripCommentsAndStrings(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, ' ')
    .replace(/'(?:\\[\s\S]|[^'\\\n])*'/g, ' ')
    .replace(/"(?:\\[\s\S]|[^"\\\n])*"/g, ' ');
}

test('G134w: web 模块里用到的 util 导出名必须真的被导入 (漏一个 ⇒ 整个组件静默死掉)', () => {
  const utilNames = _utilExports();
  assert.ok(utilNames.size > 10, 'util.mjs 的导出名没解析出来 (解析器坏了, 这条守卫会变成空枪)');
  const files = _walk(APP, []);
  const offenders = [];
  for (const file of files) {
    if (file === UTIL) continue;
    const src = fs.readFileSync(file, 'utf8');
    const code = _stripCommentsAndStrings(src);
    // 已导入的名字 (任何来源都算)
    const imported = new Set();
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
      for (const part of m[1].split(',')) {
        const t = part.trim().split(/\s+as\s+/)[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(t)) imported.add(t);
      }
    }
    // 本地自己声明的 (function xxx / const xxx = / let xxx / var xxx)
    const local = new Set();
    for (const m of src.matchAll(/(?:^|\s)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) local.add(m[1]);
    for (const m of src.matchAll(/(?:^|\s)(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) local.add(m[1]);
    for (const m of src.matchAll(/(?:^|\s)(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
      for (const part of m[1].split(',')) {
        const t = part.trim().split(':').pop().trim();
        if (/^[A-Za-z_$][\w$]*$/.test(t)) local.add(t);
      }
    }
    for (const name of utilNames) {
      if (imported.has(name) || local.has(name)) continue;
      // 只认「**被当函数调用**」的用法 —— 那才是漏导入会抛 ReferenceError 的形态。
      //   对象属性 (`icon: '☰'`)、局部变量 (`let json;`)、形参 (`function f(hint)`)
      //   都不会因为漏导入 util 而炸, 放它们进来只会让守卫变成「一堆误报然后被加白名单」——
      //   那等于没守卫。
      const re = new RegExp('(?<![\\w$.])' + name.replace(/\$/g, '\\$') + '\\s*\\(', 'g');
      if (re.test(code)) offenders.push(path.relative(path.join(__dirname, '..'), file) + ' → ' + name);
    }
  }
  assert.equal(offenders.length, 0,
    'web 模块里用了 util 的导出名但没导入 (⇒ 运行时 ReferenceError ⇒ 组件静默死掉):\n  '
    + offenders.join('\n  '));
});

test('G134w2: 负例自检 —— 真漏了要能被抓出来 (别让这条守卫恒真)', () => {
  const src = fs.readFileSync(UTIL, 'utf8');
  assert.ok(/export\s+function\s+elHTML/.test(src), 'elHTML 还在 util.mjs 里 (夹具前提)');
  const fake = "import { el } from '../lib/util.mjs';\nconst x = elHTML('span');\n";
  const re = new RegExp('(?<![\\w$.])elHTML(?![\\w$])');
  assert.ok(re.test(fake), '负例自检: 漏导入的写法要能被这条守卫的判据抓到');
});
