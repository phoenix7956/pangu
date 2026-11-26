'use strict';
/**
 * tests/open-source-hygiene-20261026.test.js —— 开源卫生守卫 (第 109 批)
 *
 * ── 这条守卫守的是什么 ──
 *   「注释 ≠ 隔离, .gitignore ≠ 隔离」。
 *   - .gitignore 只对**未跟踪**文件生效 —— 已经跟踪过的文件, 写进 ignore 也照样会被提交。
 *   - 文档里写一句「这个别发」同样不是隔离 —— 隔离必须是**机制**。
 *   本守卫把「不许进开源树的东西」变成**机器判据**, 每次跑 test:chain 都会验一遍。
 *
 * 判据:
 *   ① LICENSE / README / CONTRIBUTING / SECURITY 在仓根
 *   ② 被跟踪文件里没有本机绝对路径 (/Users/<某人>/, /home/<某人>/)
 *   ③ 被跟踪文件里没有疑似真密钥
 *   ④ **被跟踪文件里没有桌面端残留** (apps/desktop / apps/bridge / 前端构建产物)
 *   ⑤ **.gitignore 命中但仍被跟踪**的文件 —— 一条都没有 (这条是本轮的核心教训)
 *   ⑥ OpenClaw 桌面工作台外壳 (根 AGENTS.md / SOUL.md / skills/ / .archive/) 不在跟踪里
 *   ⑦ 私货 (崩溃报告 / 记忆库 / 语料缓存 / 凭证) 不在跟踪里
 *   ⑧ 代码里不再写死任何人的机器名当默认路径
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CORE = path.join(__dirname, '..');            // apps/core
const ROOT = path.resolve(CORE, '../..');           // 仓根

function git(args, opts) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...(opts || {}),
  });
}

/**
 * 被检查的文件清单。
 *   - 在 git 仓里 ⇒ 取 `git ls-files` (索引里的跟踪文件)
 *   - 不在 git 仓里 (比如**导出出来的开源树**, 还没 git init) ⇒ 退化成走目录树,
 *     照样能查「这棵树里有没有本机绝对路径 / 真密钥」—— 那正是导出树最该验的。
 */
let GIT_AVAILABLE = true;
let TRACKED;
try {
  TRACKED = git(['ls-files', '-z']).split('\0').filter(Boolean);
} catch (_) {
  GIT_AVAILABLE = false;
  const skipDirs = new Set(['node_modules', '.git', 'coverage', '.cache']);
  const walk = (dir, out) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skipDirs.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs, out);
      else out.push(path.relative(ROOT, abs));
    }
  };
  TRACKED = [];
  walk(ROOT, TRACKED);
}

function readTracked(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return '';
  const buf = fs.readFileSync(abs);
  // 二进制跳过 (前 4KB 里有 NUL 就是二进制)
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return '';
  return buf.toString('utf8');
}

// ─────────────────────────────────────────────────────────────
// ① 开源必备文件在仓根
// ─────────────────────────────────────────────────────────────
test('① 开源必备文件在仓根 (LICENSE / README / CONTRIBUTING / SECURITY)', () => {
  for (const f of ['LICENSE', 'NOTICE', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md']) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `仓根缺 ${f} —— 开源仓不能没有它`);
  }
  const lic = fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');
  assert.ok(/Apache License/.test(lic), 'LICENSE 必须是完整的 Apache-2.0 全文, 不是 stub');
  assert.ok(lic.split('\n').length > 100, 'LICENSE 太短 —— 像是占位符不是许可证');
  // NOTICE 承担当初的第三方归属 (lucide ISC / Feather MIT) —— 空壳等于没写。
  const notice = fs.readFileSync(path.join(ROOT, 'NOTICE'), 'utf8');
  assert.ok(notice.split('\n').length > 20, 'NOTICE 太短 —— 像是占位符, 归属声明没写全');
  assert.ok(/lucide/i.test(notice), 'NOTICE 里没提 lucide —— 工作台的图标路径是 lucide 抄来的, 归属必须在这儿');
});

// ─────────────────────────────────────────────────────────────
// ② ③ 被跟踪文件里没有本机绝对路径 / 真密钥
// ─────────────────────────────────────────────────────────────
test('② 被跟踪文件里没有本机绝对路径', () => {
  // /Users/you/ 是约定的占位符, 放过; 其余(含本机真名)一律算泄露。
  const ABS = /\/(Users|home)\/(?!you\/|user\/)[A-Za-z0-9._-]+\//;
  const hits = [];
  for (const rel of TRACKED) {
    const text = readTracked(rel);
    if (!text) continue;
    text.split('\n').forEach((line, i) => {
      if (ABS.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.equal(hits.length, 0, '被跟踪文件里还有本机绝对路径:\n' + hits.slice(0, 10).join('\n'));
});

test('③ 被跟踪文件里没有疑似真密钥', () => {
  const PATTERNS = [
    [/\bsk-[A-Za-z0-9]{24,}\b/, 'openai-style key'],
    [/\bsk-ant-[A-Za-z0-9]{24,}\b/, 'anthropic key'],
    [/\bxai-[A-Za-z0-9]{24,}\b/, 'xai key'],
    [/\bghp_[A-Za-z0-9]{30,}\b/, 'github token'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
    [/\b[0-9a-f]{64}\b/, 'hex token'],
  ];
  const ALLOW = /sk-REPLACE-ME|sk-\.\.\.|sk-ant-\.\.\.|sk-cp-\.\.\./;
  const hits = [];
  for (const rel of TRACKED) {
    const text = readTracked(rel);
    if (!text) continue;
    text.split('\n').forEach((line, i) => {
      if (ALLOW.test(line)) return;
      for (const [re, name] of PATTERNS) {
        if (re.test(line)) hits.push(`${rel}:${i + 1} [${name}]: ${line.trim().slice(0, 100)}`);
      }
    });
  }
  assert.equal(hits.length, 0, '被跟踪文件里有疑似真密钥:\n' + hits.slice(0, 10).join('\n'));
});

// ─────────────────────────────────────────────────────────────
// ④ 桌面端彻底剥离: 被跟踪文件里不许有桌面端残留
// ─────────────────────────────────────────────────────────────
test('④ 被跟踪文件里没有桌面端残留 (apps/desktop / apps/bridge / 前端产物)', () => {
  const bad = [];
  for (const rel of TRACKED) {
    if (/^apps\/(desktop|bridge)\//.test(rel)) bad.push(rel);
    if (/(^|\/)(dist|build)\//.test(rel) && !/64i|node_modules/.test(rel)) bad.push(rel);
    if (/\.map$/.test(rel)) bad.push(rel);
  }
  assert.equal(bad.length, 0, '桌面端残留还在跟踪里:\n' + bad.slice(0, 10).join('\n'));
});

test('④b 桌面端服务器半边不许复活 (frontend_static 模块 / 静态出口)', () => {
  assert.ok(!fs.existsSync(path.join(CORE, 'modules', 'frontend_static.js')),
    'modules/frontend_static.js 又回来了 —— 桌面端的静态出口不该复活');
  assert.ok(!fs.existsSync(path.join(ROOT, 'apps', 'desktop')),
    'apps/desktop 目录又回来了');
  const panguSingle = readTracked('apps/core/pangu-single.js');
  assert.ok(!/frontend_static/.test(panguSingle), 'pangu-single.js 还在 require frontend_static');
});

// ─────────────────────────────────────────────────────────────
// ④c 包管理器只有一个真源 —— 锁文件不许再有第二份
// ─────────────────────────────────────────────────────────────
test('④c 包管理器单一真源 (根 pnpm workspace), 不许再有第二份锁文件', () => {
  // 历史包袱: apps/core 下曾同时存在 package-lock.json (npm) 与 pnpm-lock.yaml (pnpm),
  //   两份都过期。npm 那份还缺 hnswlib-node ⇒ `npm ci` 直接失败, CI 本来就是红的。
  //   现在只留根 pnpm-lock.yaml (workspace 级) 一份真源。
  for (const f of ['apps/core/package-lock.json', 'apps/core/pnpm-lock.yaml', 'apps/core/pnpm-workspace.yaml']) {
    assert.ok(!fs.existsSync(path.join(ROOT, f)),
      f + ' 又回来了 —— 锁文件只能有一个真源 (根 pnpm-lock.yaml), 两份锁文件会让贡献者不知道用哪个');
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'pnpm-lock.yaml')), '根 pnpm-lock.yaml 不见了');
  assert.ok(fs.existsSync(path.join(ROOT, 'pnpm-workspace.yaml')), '根 pnpm-workspace.yaml 不见了');
  // CI 装的包管理器必须跟锁文件对得上
  const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.ok(/cache:\s*pnpm/.test(ci), 'CI 不用 pnpm 缓存 —— 跟根 pnpm-lock.yaml 对不上');
  assert.ok(/pnpm install --frozen-lockfile/.test(ci), 'CI 必须用 --frozen-lockfile 安装');
  assert.ok(!/npm ci/.test(ci), 'CI 里还有 npm ci —— 那份锁文件已经删了, 这条必失败');
});

// ─────────────────────────────────────────────────────────────
// ④d 运行时缓存不许入库 (机器状态 ≠ 源码)
// ─────────────────────────────────────────────────────────────
test('④d 运行时缓存 (router 模型池) 不在跟踪里 —— 它装的是某台机器的模型池', (t) => {
  if (!GIT_AVAILABLE) {
    t.skip('当前目录不是 git 仓 (导出树未 init) ⇒ 没有索引可比对');
    return;
  }
  const runtimeFiles = ['apps/core/modules/router/models.json'];
  for (const f of runtimeFiles) {
    assert.ok(!TRACKED.includes(f),
      f + ' 又被跟踪了 —— 它是 syncRouterModelsFromConfig 从 node.json 生成的'
      + '运行时缓存 (装的是某台机器的模型池), 别人克隆会看到自己根本没有的模型');
  }
  // .gitignore 必须真的盖住它 (不然每个用户 clone 完第一次 init 就脏工作树)
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.ok(ignore.includes('/apps/core/modules/router/models.json'),
    '.gitignore 没盖住 router/models.json ⇒ 用户第一次 init 就会把工作树改脏');
});

// ─────────────────────────────────────────────────────────────
// ⑤ .gitignore 命中却仍被跟踪 —— 一条都不许有 (本轮核心教训)
// ─────────────────────────────────────────────────────────────
test('⑤ .gitignore 命中但仍被跟踪的文件 = 0 (ignore 对已跟踪文件无效)', (t) => {
  if (!GIT_AVAILABLE) {
    // 导出树还没 git init ⇒ 没有索引, 这条判据不适用 (别报假红)。
    t.skip('当前目录不是 git 仓 (导出树未 init) ⇒ 没有索引可比对');
    return;
  }
  // 用 --no-index: 默认的 check-ignore **会跳过已跟踪文件**, 那正好把这条洞盖掉。
  // 一次调用传全部路径 —— 逐个 spawn 会让这条守卫跑 6 秒 (700+ 次子进程)。
  let ignored = new Set();
  try {
    const out = execFileSync('git', ['check-ignore', '--no-index', '--stdin'], {
      cwd: ROOT,
      input: TRACKED.join('\n'),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    ignored = new Set(out.split('\n').filter(Boolean));
  } catch (e) {
    // git check-ignore 的退出码: 0 = 至少一个路径被 ignore; 1 = **一个都没被 ignore**。
    // exit 1 时 stdout 为空 ⇒ 就是「没有 offender」, 别再逐个 spawn 慢查一遍。
    const out = (e && e.stdout) || '';
    if (e && e.status === 1 && !out.trim()) {
      ignored = new Set();
    } else {
      ignored = new Set(String(out).split('\n').filter(Boolean));
      // 真的读不出结果 ⇒ 逐个回退确认 (不常见的分支)
      if (!ignored.size) {
        for (const rel of TRACKED) {
          try {
            execFileSync('git', ['check-ignore', '--no-index', '-q', rel], { cwd: ROOT, stdio: 'ignore' });
            ignored.add(rel);
          } catch (_) { /* 没被 ignore */ }
        }
      }
    }
  }
  const offenders = TRACKED.filter(rel => ignored.has(rel));
  assert.equal(offenders.length, 0,
    '这些文件同时被 .gitignore 命中**又**还在跟踪里 —— ignore 对它们无效, 会被提交出去:\n'
    + offenders.slice(0, 15).join('\n'));
});

// ─────────────────────────────────────────────────────────────
// ⑥ OpenClaw 桌面工作台外壳不在跟踪里
// ─────────────────────────────────────────────────────────────
test('⑥ OpenClaw 桌面工作台外壳 (根 AGENTS/SOUL/IDENTITY/USER, skills/, .archive/) 不在跟踪里', () => {
  // AGENTS.md 单独判 (工作仓里它是**本机**工作台模板 ⇒ 不许跟踪;
  //                导出树里它是**项目指南** ⇒ 允许跟踪, 但内容不许带 OpenClaw 痕迹)
  const shell = ['SOUL.md', 'IDENTITY.md', 'USER.md', 'BOOTSTRAP.md', 'MEMORY.md'];
  const offenders = TRACKED.filter(rel =>
    shell.includes(rel)
    || rel === 'AGENTS.md'
    || rel.startsWith('skills/')
    || rel.startsWith('.archive/'));
  // AGENTS.md 只在「它是 OpenClaw 模板」时才是 offender
  const realOffenders = offenders.filter(rel => {
    if (rel !== 'AGENTS.md') return true;
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return true;
    const text = fs.readFileSync(abs, 'utf8');
    return /openclaw|BOOTSTRAP\.md|\/concepts\/agent-workspace/i.test(text);
  });
  assert.equal(realOffenders.length, 0,
    'OpenClaw 工作台外壳还在跟踪里 (本地保留, 但不该进开源树):\n' + realOffenders.slice(0, 15).join('\n'));
  // AGENTS.md 的两种合法形态:
  //   ① 工作仓: 根 AGENTS.md 是**本机 OpenClaw 工作台模板** ⇒ 不跟踪, 但文件**必须在**
  //      (删了会毁掉本机 agent 的行为, AGENTS.md §11.3 禁碰)。
  //   ② 导出树: AGENTS.md 是导出脚本生成的**项目指南** ⇒ 必须**不含** OpenClaw 痕迹。
  //   判据: 用「SOUL.md 在不在盘上」区分这两种形态 —— 工作仓保留它, 导出树不带它。
  const inWorkingRepo = fs.existsSync(path.join(ROOT, 'SOUL.md'));
  const agentsPath = path.join(ROOT, 'AGENTS.md');
  if (inWorkingRepo) {
    for (const f of ['AGENTS.md', 'SOUL.md']) {
      assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} 本地文件不该被删 (只是不跟踪)`);
    }
  } else {
    // 导出树: OpenClaw 外壳必须不在
    for (const f of ['SOUL.md', 'IDENTITY.md', 'USER.md']) {
      assert.ok(!fs.existsSync(path.join(ROOT, f)), `导出树里不该有 ${f} —— OpenClaw 工作台外壳没剥干净`);
    }
    if (fs.existsSync(agentsPath)) {
      const text = fs.readFileSync(agentsPath, 'utf8');
      assert.ok(!/openclaw|BOOTSTRAP\.md|\/concepts\/agent-workspace/i.test(text),
        '导出树里的 AGENTS.md 是 OpenClaw 工作台模板 —— 应该是项目自己的指南');
      assert.ok(/Pangu|盘古/.test(text), '导出树里的 AGENTS.md 不像项目指南');
    }
  }
});

// ─────────────────────────────────────────────────────────────
// ⑦ 私货不在跟踪里
// ─────────────────────────────────────────────────────────────
test('⑦ 私货 (凭证 / 记忆 / 崩溃报告 / 语料缓存 / 过程文档) 不在跟踪里', () => {
  const PATTERNS = [
    [/^issues\//, '崩溃报告'],
    [/^tmp\//, '临时产物'],
    [/^docs\//, '过程文档'],
    [/^specs\//, '过程文档'],
    [/^apps\/core\/evomap\//, '本机私有运行时'],
    [/^apps\/core\/state\//, '本机状态'],
    [/^apps\/core\/research\//, '本机研究产物'],
    [/^apps\/core\/\.learnings\//, '本机学习记录'],
    [/^apps\/core\/credentials\/(?!\.gitkeep)/, '凭证'],
    [/^apps\/core\/(memory|meta)\/MEMORY\.md$/, '私人记忆'],
    [/^apps\/core\/MEMORY\.md$/, '私人记忆'],
    [/^apps\/core\/env_cache\.json$/, '本机环境缓存'],
    [/^env_cache\.json$/, '本机环境缓存'],
    [/^apps\/core\/\.cache\//, '外部源缓存'],
  ];
  const offenders = [];
  for (const rel of TRACKED) {
    for (const [re, why] of PATTERNS) {
      if (re.test(rel)) { offenders.push(`${rel}  (${why})`); break; }
    }
  }
  // 真节点配置单独判 —— 因为要看**内容**。
  //   干净克隆里 (CI / 新用户) 会 `cp example-node.json node.json` 起一个能跑的实例,
  //   那份跟示例模板**逐字节相同** ⇒ 是模板拷贝, 不是私货, 不该算泄露。
  //   只有被人**改过**的 node.json (真 endpoint / 真 key) 才算。
  const nodeJsonPath = path.join(ROOT, 'apps/core/config/nodes/node.json');
  const exampleJsonPath = path.join(ROOT, 'apps/core/config/nodes/example-node.json');
  let nodeJsonIsTemplateCopy = false;
  try {
    nodeJsonIsTemplateCopy =
      fs.readFileSync(nodeJsonPath).equals(fs.readFileSync(exampleJsonPath));
  } catch (_) { /* 没有 node.json ⇒ 不涉及这一条 */ }
  if (!nodeJsonIsTemplateCopy && TRACKED.includes('apps/core/config/nodes/node.json')) {
    offenders.push('apps/core/config/nodes/node.json  (真节点配置)');
  }
  assert.equal(offenders.length, 0, '私货还在跟踪里:\n' + offenders.slice(0, 15).join('\n'));
});

// ─────────────────────────────────────────────────────────────
// ⑧ 代码里不写死机器名
// ─────────────────────────────────────────────────────────────
test('⑧ 代码里不写死任何人的机器名当默认路径', () => {
  const CODE = /(require|path\.join|readFileSync|existsSync|readdirSync)\s*\([^)]*fengdeMBP/;
  const offenders = [];
  for (const rel of TRACKED) {
    if (!/\.(js|cjs|mjs|ts|sh|py|swift|json)$/.test(rel)) continue;
    const text = readTracked(rel);
    if (text && CODE.test(text)) offenders.push(rel);
  }
  assert.equal(offenders.length, 0,
    '这些文件里还有写死的机器名路径 (节点配置要走 config/node_config.js):\n' + offenders.join('\n'));
});

// ─────────────────────────────────────────────────────────────
// ⑨ 仓库地址只有一个真源, 且三处必须一致
// ─────────────────────────────────────────────────────────────
test('⑨ 仓库地址单一真源 (package.json) ⇒ README / CI 引用必须一致', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const url = (pkg.repository && pkg.repository.url) || '';
  assert.ok(url, '根 package.json 缺 repository.url —— 仓库地址必须有一个真源');
  assert.ok(/^https?:\/\/[^/]+\/[^/]+/.test(url), 'repository.url 不是合法仓库地址: ' + url);
  // owner/repo = 去掉 host 与 .git 后缀后的最后两段
  const slug = url.replace(/\.git$/, '').split('/').filter(Boolean).slice(-2).join('/');
  assert.ok(slug.includes('/'), 'repository.url 解析不出 owner/repo: ' + url);

  // README / CI 里出现的每一个仓库地址都必须指向同一个仓
  const files = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', '.github/workflows/ci.yml'];
  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, 'utf8');
    for (const hit of text.match(/https?:\/\/[^)\s"']+\/[^)\s"']+/g) || []) {
      // 只管 host **正好是** github.com 的地址 (docs.github.com / raw.githubusercontent.com 是文档站, 不算)
      const host = (hit.match(/^https?:\/\/([^/]+)\//) || [])[1];
      if (host !== 'github.com') continue;
      const hitSlug = hit.replace(/\.git$/, '').split('github.com/')[1];
      assert.ok(hitSlug && hitSlug.split('/').slice(0, 2).join('/') === slug,
        `${rel} 里的仓库地址 ${hit} 与 package.json 的 ${url} 不一致 —— 仓库改名/搬家时最容易漏的就是这类散落引用`);
    }
  }
  // 许可证声明也要在 package.json 里 (npm 上架时的机器可读声明)
  assert.equal(pkg.license, 'Apache-2.0', '根 package.json 的 license 必须是 Apache-2.0');
});

// ─────────────────────────────────────────────────────────────
// ⑩ 导出脚本自己在位
// ─────────────────────────────────────────────────────────────
test('⑨ 开源导出脚本在位, 且它的体检能跑', () => {
  const script = path.join(ROOT, 'scripts', 'publish-open-source.js');
  assert.ok(fs.existsSync(script), 'scripts/publish-open-source.js 不在 —— 开源树导出没工具');
  const out = execFileSync('node', [script, '--check'], { cwd: ROOT, encoding: 'utf8' });
  assert.ok(/体检通过/.test(out), '导出脚本的体检没过:\n' + out);
});
