#!/usr/bin/env node
/**
 * scripts/publish-open-source.js —— 导出一棵**干净的开源树**
 *
 * ── 为什么需要这个脚本 ──
 *   本仓 (`~/Desktop/pangu`) 同时是三样东西:
 *     ① 盘古产品代码 (要开源)
 *     ② 本机 OpenClaw agent 的运行时工作台 (根 AGENTS.md / SOUL.md / skills/ …, 不开源)
 *     ③ 本机运行状态 (崩溃报告 / 记忆库 / 语料缓存 / 节点凭证, 不开源)
 *   靠 .gitignore 隔离 ③ 是有效的 (未跟踪文件不受 ignore 影响, 但**已跟踪的**不受 ignore 约束),
 *   但 ② 里有些文件**历史上被跟踪过** —— 只靠 ignore 是不够的。
 *
 *   ⇒ 这个脚本按 `git ls-files` (索引) 出发, 套一层**显式排除清单**,
 *     把树拷到目标目录。**不带 git 历史** ⇒ 历史里出现过的密钥不会跟着走。
 *
 * ── 用法 ──
 *   node scripts/publish-open-source.js                     # 导到 ./pangu-open-source
 *   node scripts/publish-open-source.js --out /tmp/pangu    # 指定目录
 *   node scripts/publish-open-source.js --check             # 只体检, 不导出
 *   node scripts/publish-open-source.js --publish           # 导出 + 直接做成可 push 的仓
 *     (git init + 首次 commit + remote origin 已配好)
 *
 * ── 体检项 (任一不过 ⇒ 退出码 1, 不导出) ──
 *   ① 导出树里不许有本机绝对路径 (/Users/<某人>/)
 *   ② 导出树里不许有疑似真密钥
 *   ③ 导出树里不许有已知的桌面端残留 (apps/desktop / apps/bridge / 前端构建产物)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * 排除清单 —— 每条都要写**为什么**。
 *   顺序无关, 命中任一即排除。
 */
const EXCLUDES = [
  // ---- 本机 OpenClaw agent 工作台 (不是盘古的运行时文件) ----
  { re: /^\/?(AGENTS|SOUL|IDENTITY|USER|BOOTSTRAP|MEMORY)\.md$/, why: 'OpenClaw 工作台模板' },
  { re: /^\/skills\//, why: '本机 OpenClaw skill 安装目录' },
  { re: /^\/\.archive\//, why: '本机归档' },

  // ---- 本机运行状态 / 凭证 ----
  { re: /^\/apps\/core\/credentials\/(?!\.gitkeep$)[^/]+$/, why: '凭证' },
  { re: /^\/apps\/core\/config\/nodes\/(?!example-node\.json$)[^/]*\.json$/, why: '真节点配置 (含 API key)' },
  { re: /^\/apps\/core\/evomap\//, why: '本机私有运行时' },
  { re: /^\/apps\/core\/(state|research|sandbox-repair-test)\//, why: '本机运行状态' },
  { re: /^\/apps\/core\/\.learnings\//, why: '本机学习记录' },
  { re: /^\/apps\/core\/(memory|meta)\/MEMORY\.md$/, why: '私人记忆' },
  { re: /^\/apps\/core\/MEMORY\.md$/, why: '私人记忆 (含内网拓扑)' },
  { re: /^\/apps\/core\/env_cache\.json$/, why: '本机环境缓存 (含 hostname)' },
  { re: /^\/(issues|tmp|logs|data|state|output_files|repair|checkpoints|evolution)\//, why: '本机运行产物' },
  { re: /^\/(docs|specs)\//, why: '过程文档 (不进项目仓)' },
  { re: /^\/env_cache\.json$/, why: '本机环境缓存' },
  { re: /^\/plan_audit\.json$/, why: '本机探针残留' },
  { re: /^\/\.pangu_probe_ok$/, why: '本机探针残留' },

  // ---- 桌面端(React+Vite 壳)与前端构建产物 ----
  { re: /^\/apps\/desktop\//, why: '桌面端已下线' },
  { re: /^\/apps\/bridge\//, why: '桌面端已下线' },
  { re: /(^|\/)(dist|build)\//, why: '构建产物' },
  { re: /\.map$/, why: 'source map' },

  // ---- 备份 / 临时文件 ----
  { re: /\.bak($|[-.])/, why: '备份文件' },
  { re: /\.migration-bak-/, why: '迁移备份 (含真 key)' },
  { re: /~$/, why: '编辑器临时文件' },

  // ---- 易学推演 7 条产品轨 (老板拍: 这几个不能开源) ----
  //   公版理论 (64i 二进制内核 + 周易/三命通会原文切片) 照开, 但**产品轨**不开:
  //   ① 断法层 py 真源在 /Users/you/Desktop/course-source, 不进 repo, 开源后是空壳
  //   ② 前端视图是成品界面, 是「能用的东西」不是算法
  //   ③ 课程消化件切片 (八宅/梅花课) 是私有课程资料, 不是公版文本
  // 7 轨断法层 py: 真源在 /Users/you/Desktop/course-source, 开源后是空壳, 全拆。
  //   bazi_calc.py (八字排盘) + lipan/ganzhi.py (干支五行基础表) 是公版纯数据/算法, 留。
  { re: /^\/apps\/core\/modules\/tools\/bazi\/(qimen|bazhai|liuren|hehun|hehun_calc|ziwei|mianxiang|shazhen|mangpai|xuankong)\.py$/, why: '7 轨断法层 (真源私有, 开源是空壳)' },
  { re: /^\/apps\/core\/web\/app\/views\/(qimen|bazhai|liuren|hehun|meihua|ziwei|mianxiang)\.(mjs|css)$/, why: '7 轨前端视图 (成品界面)' },
  { re: /^\/apps\/core\/web\/app\/lib\/ziwei\//, why: '紫微前端 lib (成品界面)' },
  { re: /^\/apps\/core\/tests\/(qimen|bazhai|liuren-mianxiang|bazi-hehun|qimen-feipan)[^\s]*\.test\.js$/, why: '7 轨测试 (跟私有断法层同进退)' },
  // 课程切片存在性测试: 它们断言「课程/风水速查表切片在仓库里」, 但开源树把课程切片剥了
  //   (tier=course/digest 前缀匹配全剥) ⇒ 这些测试在导出树必红, 是**私有树不变量**, 跟课程件一起留私有。
  { re: /^\/apps\/core\/tests\/(fengshui-core|provenance-20261022|najia-bridge|tiyong-provenance)[^\s]*\.test\.js$/, why: '课程切片存在性测试 (切片被剥, 私有不变量, 跟课程件同进退)' },
  // 现场真会话快照 fixture (含主人姓氏/硬件型号/内部运营数据/课程消化过程): 断言是字节级
  //   逐字回归, 脱敏即废; 跟两个回归测试同进退。
  { re: /^\/apps\/core\/tests\/fixtures\/answer-continuity[^/]*\.json$/, why: '现场会话快照 fixture (私人实际对话数据)' },
  { re: /^\/apps\/core\/tests\/(answer-continuity-20261024|internal-marker-leak-20261024)\.test\.js$/, why: '现场会话回归测试 (fixture 被剥, 无数据可测)' },
  // 课程消化件切片: 凡是 course_* / meihua_tiyong* (tier=course/digest, 私有课程资料) 全剥,
  //   公版 (smt_* 三命通会 / zhougui_shangjing 周易 / xiang_ci_64 大象辞 / digest_bagua_wuxing 万物类象) 照开。
  //   用前缀匹配, 不点名 —— 以后新增课程切片自动跟着剥, 不用回来改这里。
  { re: /^\/apps\/core\/64i\/sources\/course_[^/]+\.txt$/, why: '课程消化件切片 (私有课程资料, 非公版文本; 前缀匹配全剥)' },
  { re: /^\/apps\/core\/64i\/sources\/meihua_tiyong[^/]*\.txt$/, why: '梅花体用课消化件 (私有课程资料)' },
];

/** 已知的机器名 —— 出现在**代码**里就是没剥干净 (注释/文档里出现只提示, 不算失败)。 */
const MACHINE_NAME_RE = /\byour-mac\b/;
/** 代码里不许出现的机器名 (注释与字符串字面量里的历史说明放过)。 */
const CODE_MACHINE_NAME_RE = /(require|path\.join|readFileSync|existsSync)\s*\([^)]*your-mac/;

/** 疑似真密钥 (占位符放过)。 */
const SECRET_PATTERNS = [
  { re: /\bsk-[A-Za-z0-9]{24,}\b/, name: 'openai-style key' },
  { re: /\bsk-ant-[A-Za-z0-9]{24,}\b/, name: 'anthropic key' },
  { re: /\bxai-[A-Za-z0-9]{24,}\b/, name: 'xai key' },
  { re: /\bghp_[A-Za-z0-9]{30,}\b/, name: 'github token' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, name: 'private key' },
  { re: /\b[0-9a-f]{64}\b/, name: 'hex token' },
];
const SECRET_ALLOW = /sk-REPLACE-ME|sk-\.\.\.|sk-ant-\.\.\.|sk-cp-\.\.\./;

/**
 * 本机绝对路径 (/Users/<某人>/)。`/Users/you/` 是**约定的占位符**, 放过;
 * 其余一律算泄露 (含本机真名那条 —— 本文件自己都不许把它写出来)。
 */
const ABS_PATH_RE = /\/(Users|home)\/(?!you\/|user\/)[A-Za-z0-9._-]+\//;

function parseArgs(argv) {
  const out = { out: path.join(REPO_ROOT, 'pangu-open-source'), check: false, publish: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out.out = path.resolve(argv[++i]);
    else if (argv[i] === '--check') out.check = true;
    else if (argv[i] === '--publish') out.publish = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('用法: node scripts/publish-open-source.js [--out <目录>] [--check] [--publish]');
      process.exit(0);
    } else throw new Error('未知参数: ' + argv[i]);
  }
  return out;
}

function listTrackedFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 });
    return out.toString('utf8').split('\0').filter(Boolean);
  } catch (_) {
    // 不在 git 仓里 (导出树还没 git init) ⇒ 走目录树, 照样体检。
    const skipDirs = new Set(['node_modules', '.git', 'coverage', '.cache']);
    const out = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (skipDirs.has(e.name)) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) walk(abs);
        else out.push(path.relative(REPO_ROOT, abs));
      }
    };
    walk(REPO_ROOT);
    return out;
  }
}

function isExcluded(rel) {
  // git ls-files 给的是**不带前导斜杠**的相对路径; 排除清单统一按 /a/b 写。
  const key = rel.startsWith('/') ? rel : '/' + rel;
  for (const ex of EXCLUDES) {
    if (ex.re.test(key)) return ex.why;
  }
  return null;
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const tracked = listTrackedFiles();
  const included = [];
  const excluded = [];
  const missing = [];

  for (const rel of tracked) {
    const why = isExcluded(rel);
    if (why) { excluded.push({ rel, why }); continue; }
    const abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) { missing.push(rel); continue; }
    included.push(rel);
  }

  // ---- 体检 ----
  const problems = [];
  const absHits = [];
  const secretHits = [];
  const machineHits = [];

  for (const rel of included) {
    const abs = path.join(REPO_ROOT, rel);
    const buf = fs.readFileSync(abs);
    if (looksBinary(buf)) continue;
    const text = buf.toString('utf8');
    const lines = text.split('\n');

    lines.forEach((line, i) => {
      if (ABS_PATH_RE.test(line)) absHits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
      if (!SECRET_ALLOW.test(line)) {
        for (const p of SECRET_PATTERNS) {
          if (p.re.test(line)) secretHits.push(`${rel}:${i + 1} [${p.name}]: ${line.trim().slice(0, 120)}`);
        }
      }
    });
    if (CODE_MACHINE_NAME_RE.test(text)) machineHits.push(rel);
  }

  if (absHits.length) problems.push(`本机绝对路径 ${absHits.length} 处`);
  if (secretHits.length) problems.push(`疑似真密钥 ${secretHits.length} 处`);
  if (machineHits.length) problems.push(`代码里还有机器名路径 ${machineHits.length} 处`);
  if (missing.length) problems.push(`索引里有、工作区没有的文件 ${missing.length} 个`);

  console.log('── 开源导出体检 ──');
  console.log(`跟踪文件: ${tracked.length}   导出: ${included.length}   排除: ${excluded.length}`);
  const byWhy = {};
  for (const e of excluded) byWhy[e.why] = (byWhy[e.why] || 0) + 1;
  for (const [why, n] of Object.entries(byWhy).sort((a, b) => b[1] - a[1])) {
    console.log(`  排除 ${String(n).padStart(4)}  ${why}`);
  }

  if (absHits.length) { console.log('\n本机绝对路径:'); absHits.slice(0, 20).forEach(h => console.log('  ' + h)); }
  if (secretHits.length) { console.log('\n疑似真密钥:'); secretHits.slice(0, 20).forEach(h => console.log('  ' + h)); }
  if (machineHits.length) { console.log('\n代码里的机器名:'); machineHits.forEach(h => console.log('  ' + h)); }
  if (missing.length) { console.log('\n索引里缺失的文件:'); missing.slice(0, 20).forEach(h => console.log('  ' + h)); }

  if (problems.length) {
    console.error('\n❌ 体检没过: ' + problems.join('; ') + ' —— 不导出。');
    process.exit(1);
  }
  console.log('\n✅ 体检通过。');

  if (args.check) { console.log('--check 模式, 不导出。'); return; }

  // ---- 导出 ----
  const outDir = args.out;
  if (fs.existsSync(outDir)) {
    console.error('目标目录已存在, 不覆盖(免得手滑毁掉东西): ' + outDir);
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });
  let bytes = 0;
  for (const rel of included) {
    const from = path.join(REPO_ROOT, rel);
    const to = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    bytes += fs.statSync(from).size;
  }
  // 导出树里补一份**项目自己的** AGENTS.md ——
  //   本仓根目录那份是本机 OpenClaw agent 的工作台模板 (不公开), 开源树需要一份
  //   给 coding agent 看的项目指南 (仓库结构 / 怎么跑 / 什么不许做)。
  fs.writeFileSync(path.join(outDir, 'AGENTS.md'), PROJECT_AGENTS_MD, 'utf8');
  // 开源导出标记: 让 64i 出处守卫 (provenance.js) 知道这是剥离了课程切片的导出树,
  //   course/digest 切片缺失时走优雅降级 (skip), 公版缺失仍报红。私有树没这文件, 全量强校验。
  fs.mkdirSync(path.join(outDir, 'apps', 'core', '64i'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'apps', 'core', '64i', '.pangu-open-source'),
    '# 盘古开源导出树标记 —— 课程/消化件切片 (tier=course/digest) 已剥离, 出处守卫按此降级。\n',
    'utf8');
  // 7 轨 wiring 清洗 (老板拍「这几个不能在上面」): 私有树里 7 轨的**接线** (前端
  //   import / CSS link / 侧栏 / SPA 白名单 / py 工具注册) 跟 7 轨文件本身一起排除了,
  //   但引用它们的 5 个公共文件 (app.mjs/index.html/web_static.js/tools/index.js) 还在导出树里
  //   ⇒ 留下死引用。这一步只在**导出树**上把 7 轨的接线摘掉, 私有树一个字不动。
  _stripSevenTrackWiring(outDir);
  // 课程资料脱敏: 64i 模块注释/字符串里写死的本机私有课程目录路径 (/Users/you/Desktop/course-source
  //   extracted/... digest/...) 是老板的本地资料库结构, 不能跟着开源走。导出树上把整段私有
  //   路径前缀换成通用占位符 `<course-source>` (只动导出树, 私有树一个字不动)。
  _stripCoursePaths(outDir);
  _deidentifyMachines(outDir);
  _stripSevenTrackRemnants(outDir);
  _stripTestChainExcluded(outDir);
  console.log(`\n✅ 已导出 ${included.length} 个文件 (${(bytes / 1024 / 1024).toFixed(1)} MB) → ${outDir}`);
  console.log('   不含 git 历史 ⇒ 历史里出现过的密钥不会跟着走。');
  if (!args.publish) {
    console.log('   下一步: cd ' + outDir + ' && git init && git add -A && git commit -m "chore: 开源发布"');
    return;
  }

  // ---- --publish: 直接做成可 push 的仓 ----
  //   为什么值得做这一步: 本仓的 git **历史**里有过真 key (文件已取消跟踪, 但历史还在)。
  //   导出树是**全新历史** ⇒ 那段历史压根不在这条链上 ⇒ push 出去的东西是干净的。
  const repoUrl = _readRepoUrl();
  const git = (a, cwd) => execFileSync('git', a, { cwd, stdio: 'pipe' });
  git(['init', '-b', 'main'], outDir);
  git(['add', '-A'], outDir);
  git(['-c', 'user.name=pangu', '-c', 'user.email=opensource@localhost',
    'commit', '-q', '-m', 'chore: 盘古开源发布 (纯内核 + HTTP API)'], outDir);
  if (repoUrl) {
    git(['remote', 'add', 'origin', repoUrl], outDir);
    console.log('   remote origin = ' + repoUrl);
  } else {
    console.warn('   ⚠️ package.json 里没有 repository.url ⇒ remote 没配 (发布前请手动 git remote add origin <url>)');
  }
  console.log('   下一步: cd ' + outDir + ' && git push -u origin main');
}

/** 仓库地址的唯一真源 = 根 package.json 的 repository.url。 */
function _readRepoUrl() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    return (pkg.repository && pkg.repository.url) || '';
  } catch (_) { return ''; }
}

const PROJECT_AGENTS_MD = `# AGENTS.md — Pangu · 盘古

> 通用 AI agent 内核: 64 卦 / 384 爻 / 阴阳五行 / 八将灵调度 / 自进化闭环。
> **内核 + HTTP API + 一套自带的零构建浏览器工作台** (\`/app\`)。
> 本仓不含桌面客户端 (没有 Electron / Vite / Tauri)。

## 仓库结构

\`\`\`
apps/core/
  64i/            谋断内核 (确定性计算, 不调 LLM)
  agents/         八将灵 (gua-identity.js 是身份唯一真源)
  modules/        工具 / 路由 / 记忆 / 调度 / HTTP 运行时
  pangu-single/   HTTP 路由
  web/app/        浏览器工作台 (手写 HTML/CSS/ESM, 零构建, 零外部资源, /app 访问)
  config/         节点配置 (node_config.js 是解析唯一真源) / MCP 配置
  tests/          守卫全集
  meta/           运行时人格模板
scripts/          运维脚本 + 开源导出脚本
\`\`\`

## 怎么跑

\`\`\`bash
pnpm install --frozen-lockfile   # 仓库是 pnpm workspace, 锁文件在根
cp apps/core/config/nodes/example-node.json apps/core/config/nodes/node.json   # 填你的 endpoint / api_key
pnpm start                       # 127.0.0.1:18901
cd apps/core && npm run test:chain   # 守卫全集, 必须 0 个 not ok
\`\`\`

浏览器打开 \`http://127.0.0.1:18901/app\` 就是工作台
(对话 / 六十四卦 / 梅花起卦 / 八字排盘 / 历史 / 工具 / 状态 / 设置)。

## 铁律 (改坏了 CI 会红)

1. 卦理推演不调 LLM —— 64i 是确定性计算。
2. LLM 解读必看 64i 真源 —— 不许凭模型记忆编卦辞。
3. MCP 只执行, 不推理。
4. 不许留「空气泡」—— 降级路径不许把错误变成空结果/假成功, 宁可大声报错。
5. 路径里不许写死机器名/人名 —— 一律走 \`config/node_config.js\` 解析器或环境变量。
6. 真实 API key / 本机绝对路径 / 私人记忆 / 崩溃报告 / 过程文档 一律不入库。
7. \`web/app\` 是零构建的手写静态页 —— 不引 npm 包、不引 webfont、不加外链、不做打包。

## 改动的规矩

- 改了 64i ⇒ 在 \`apps/core/64i/provenance.js\` 登记来源 (\`tests/provenance-*.test.js\` 会抓漏)。
- 加了工具 ⇒ 名字要进对应角色的白名单 (真源: \`apps/core/agents/gua-identity.js\`)。
- 改了判定 ⇒ **同一概念的所有用法都得跟着走** (判据只有一个)。
- 守卫写完要**逐条变异验证** (改回旧行为, 看它是否真报红)。
- 第三方素材 (图标路径 / 字体 / 片段) ⇒ 归属写进仓库根 \`NOTICE\`, 别只写在代码注释里。
`;

if (require.main === module) {
  try { main(); } catch (e) { console.error('[publish-open-source] ' + (e.stack || e.message)); process.exit(1); }
}

/**
 * 7 轨 wiring 清洗 (老板拍「这几个不能在上面」)。
 *
 * 7 轨 (奇门/八宅/小六壬/合婚/梅花/紫微) 的**文件**已被 EXCLUDES 排外,
 * 但引用它们的 5 个公共文件还在导出树里 ⇒ 留下死引用。
 * 这一步只在**导出树**上把 7 轨的接线摘掉, 私有树一个字不动 (单一真源在私有树, 这里只做投影)。
 *
 * 清洗对象 (导出树里的 4 个文件, 逐文件逐行精确删, 不动其他行):
 *   app.mjs          视图 import / TITLES / COMMANDS 的 7 轨条目
 *   index.html       7 轨 CSS link + 侧栏 nav 条目
 *   web_static.js    SPA_VIEWS 白名单里的 7 轨名
 *   tools/index.js   7 轨 py 工具注册块 (hehun/qimen/qimenFeipan/qimenPaipan/bazhai/liuren/ziwei + _concurrency)
 */
function _stripSevenTrackWiring(outDir) {
  const TRACKS = ['meihua', 'hehun', 'qimen', 'bazhai', 'liuren', 'ziwei'];
  const files = [
    'apps/core/web/app/app.mjs',
    'apps/core/web/app/index.html',
    'apps/core/pangu-single/routes/web_static.js',
    'apps/core/modules/tools/index.js',
  ];
  for (const rel of files) {
    const abs = path.join(outDir, rel);
    if (!fs.existsSync(abs)) continue;
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    const out = [];
    const trackRe = new RegExp('\\b(?:' + TRACKS.join('|') + ')\\b');
    const publicRe = new RegExp('\\b(?:bazi|bazi_calc|hexagrams|hexagram|zhouyi|history|team|marketplace|subagents|status|settings|chat|evolution)\\b');

    // 标记要删的行号: tools/index.js 的 7 轨 py 工具注册整块 (注释段头 → 块体 → _concurrency → 空行)
    const skip = new Set();
    if (rel.endsWith('tools/index.js')) {
      const toolRe = /^TOOLS\.(?:hehun|qimen|qimenFeipan|qimenPaipan|bazhai|liuren|ziwei|mianxiang|xuankong)\s*=/;
      const concRe = /^if \(TOOLS\.(?:hehun|qimen|qimenFeipan|qimenPaipan|bazhai|liuren|ziwei|mianxiang|xuankong)\)/;
      for (let i = 0; i < lines.length; i++) {
        if (!toolRe.test(lines[i])) continue;
        let j = i;
        while (j > 0 && lines[j-1].trim().startsWith('//') && trackRe.test(lines[j-1])) j--;
        let k = i; while (k < lines.length && !/^\};\s*$/.test(lines[k])) k++;
        let end = k;
        if (end + 1 < lines.length && concRe.test(lines[end+1])) end++;
        if (end + 1 < lines.length && lines[end+1].trim() === '') end++;
        for (let m = j; m <= end && m < lines.length; m++) skip.add(m);
        i = end;
      }
    }
    // 7 轨段头注释 // ===== 合婚/奇门遁甲... ===== → 删掉该段 (注释头 → TOOLS.x → }; → _concurrency → 空行)
    if (rel.endsWith('tools/index.js')) {
      // 锚: 7 轨段头 (// ===== ... 7 轨 ... =====), 块体 TOOLS.x 必须紧跟其后
      const heads = [];
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        const headRe = new RegExp('^(//\\s*)+(====|===)');
        const trackNameRe = /合婚|奇门遁甲|奇门飞盘|八宅风水|小六壬|紫微斗数|玄空飞星|面相|掌相/;
        if (headRe.test(t) && trackNameRe.test(t)) {
          // 段头下面 (跳过非 7 轨注释/空行) 第一个 TOOLS. 必须是 7 轨;
          //   若 7 轨体已被前面的剥块逻辑删掉, 只留**孤悬段头注释** ⇒ 也标出来连注释删。
          let p = i + 1;
          while (p < lines.length && (/^\s*$/.test(lines[p]) || lines[p].trim().startsWith('//'))) p++;
          const bodyIs7track = p < lines.length
            && /^TOOLS\.(?:hehun|qimen|qimenFeipan|qimenPaipan|bazhai|liuren|ziwei|mianxiang|xuankong)\s*=/.test(lines[p]);
          heads.push([i, p, bodyIs7track]);
        }
      }
      for (const [hStart, regIdx, bodyIs7track] of heads) {
        if (bodyIs7track) {
          // 注释段 [hStart, regIdx) + 块体 [regIdx, k] (k = 首个独立 };) + _concurrency + 空行
          let k = regIdx; while (k < lines.length && !/^\};\s*$/.test(lines[k])) k++;
          let end = k;
          if (end + 1 < lines.length && /^if \(TOOLS\.(?:hehun|qimen|qimenFeipan|qimenPaipan|bazhai|liuren|ziwei|mianxiang|xuankong)\)/.test(lines[end+1])) end++;
          if (end + 1 < lines.length && lines[end+1].trim() === '') end++;
          for (let m = hStart; m <= end && m < lines.length; m++) skip.add(m);
        } else {
          // 孤悬段头: 7 轨体已被前面的剥块逻辑删掉, 段头注释留着会骗人「还有这个工具」⇒ 连注释一起删
          let hEnd = hStart;
          while (hEnd + 1 < lines.length && lines[hEnd + 1].trim().startsWith('//')) hEnd++;
          for (let m = hStart; m <= hEnd && m < lines.length; m++) skip.add(m);
        }
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (skip.has(i)) continue;
      // 注释行含 7 轨 (中/英) ⇒ 整行删 (web_static / app.mjs 等)
      if (ln.trim().startsWith('//') && trackRe.test(ln)) continue;
      if (ln.trim().startsWith('//') && /奇门|八宅|小六壬|合婚|梅花|紫微/.test(ln)) continue;
      // web_static.js: SPA_VIEWS 数组项, 7 轨与公共轨 (bazi/hexagrams) 常同行 ⇒ 逐 token 摘 7 轨
      if (rel.endsWith('web_static.js')) {
        if (!trackRe.test(ln)) { out.push(ln); continue; }
        const toks = ln.trim().split(/,\s*/);
        const bare = toks.map(t => t.replace(/^'|'$/g, ''));
        const kept = toks.filter((t, idx) => !TRACKS.includes(bare[idx]));
        // 只删被摘掉的 7 轨项; 若整行没了就留空
        if (kept.length === toks.length) { out.push(ln); continue; }
        const indent = ln.match(/^\s*/)[0];
        out.push(kept.length ? indent + kept.join(', ') : '');
        continue;
      }
      // 其余文件 (app.mjs / index.html / tools): 含 7 轨名 且 不含公共轨 ⇒ 整行删
      if (trackRe.test(ln) && !publicRe.test(ln)) continue;
      out.push(ln);
    }
    // 收尾: 把连续 ≥3 空行压成 1 空行 (删块后留下的空白), 再删孤立批次注释 (指向上面已删条目)
    const collapsed = [];
    let blank = 0;
    for (const ln of out) {
      if (ln.trim() === '') { blank++; if (blank <= 1) collapsed.push(ln); continue; }
      blank = 0; collapsed.push(ln);
    }
    // 删 "第 N 批: ... 7 轨 ..." 这种注释 (上面条目已删, 注释成孤儿)
    const final = collapsed.filter((ln, idx) => {
      const t = ln.trim();
      if (t.startsWith('//') && /第\s*\d+\s*批/.test(t) && trackRe.test(t)) return false;
      if (t.startsWith('//') && /第\s*\d+\s*批/.test(t) && /奇门|八宅|小六壬|合婚|梅花|紫微/.test(t)) return false;
      return true;
    });
    fs.writeFileSync(abs, final.join('\n'), 'utf8');
    // 语法自检 (js 文件), 改崩了当场炸
    if (rel.endsWith('.js') || rel.endsWith('.mjs')) {
      try {
        if (rel.endsWith('.mjs')) continue; // mjs 动态 import, node --check 不认 import()
        execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' });
      } catch (e) {
        console.error('   ❌ ' + rel + ' 清洗后语法崩了, 回滚该文件:');
        fs.copyFileSync(path.join(REPO_ROOT, rel), abs);
        console.error('   ' + (e.stderr ? e.stderr.toString().slice(0, 200) : e.message));
        process.exit(1);
      }
    }
  }
  // 校验: 导出树里 7 轨名 0 残留
  const residual = [];
  for (const rel of files) {
    const abs = path.join(outDir, rel);
    if (!fs.existsSync(abs)) continue;
    const txt = fs.readFileSync(abs, 'utf8');
    for (const t of TRACKS) {
      if (new RegExp('\\b' + t + '\\b').test(txt)) residual.push(rel + ': ' + t);
    }
  }
  if (residual.length) {
    console.error('\n⚠️ 7 轨 wiring 清洗后仍有残留: ' + residual.join(' / '));
  } else {
    console.log('   ✓ 7 轨 (奇门/八宅/小六壬/合婚/梅花/紫微) 接线已摘, 导出树无死引用。');
  }
}

/**
 * 课程资料脱敏 —— 导出树上把写死的本机私有课程目录路径换成通用占位符。
 *
 * 64i 的公版内核里, 部分注释/字符串引用了老板本机资料库的真实路径
 *   (/Users/you/Desktop/course-source
 * 这些是私有课程资料的**目录结构**, 跟着开源会泄露「课程长什么样/在哪」。
 * 只动导出树: 把 `/Users/you/Desktop/course-source/<任意子路径>` 整段塌成 `<course-source>`,
 * 文件级具体名也一并隐掉 (只留「出处=课程资料」这个事实, 不留路径/文件名)。
 * 私有树一个字不动。
 */
function _stripCoursePaths(outDir) {
  // 匹配 /Users/you/Desktop/course-source[/子路径...] 或 /Users/you/Desktop/course-source[/...] 整段 (到行内下一个空白/标点/反引号/引号为止)
  //   带子路径的 (<course-source>/extracted/digest) 连文件名一起塌; 不带的裸目录名也塌掉。
  //   前缀三种形态: /Users/you/Desktop/course-source · /Users/you/Desktop/course-source · 裸 Desktop/易经 (py 的 Path.home()/'Desktop/易经/...')。
  // 子路径字符类**不含** 单/双引号 (停在字符串边界), 免得把 py/js 的闭合引号吞掉改崩语法。
  // 2026-11-26: 旧 PATH_RE 的可选前缀 (?:~|/Users/you)? 对**带其他用户名**的
  //   绝对路径, 只匹配到 Desktop/易经 就停下 ⇒ /Users/feng 残留 (卫生检查 ABS_PATH_RE 抓它)
  //   + 子路径裸 <course-source> 残留 (吞了绝对路径形态, answer-alignment 语义翻转)。
  //   拆两条: 带用户名绝对路径整段塌 (到行内空白/标点止); ~/ 与 py 裸 Desktop/ 形态保留旧式。
  // 子路径字符类含 `.` (为了不漏 `_v6.md` 这种带扩展名的文件尾), 但**排除引号** (防吞 js 字符串边界)。
  //   旧字符类排除 `.` 是为了防 `latency_p50_ms` 误伤 —— 那种场景是**裸数字+下划线**被 COURSE_NAME_NUM_RE
  //   单独处理, 不在 PATH_ABS_RE 的子路径里出现; PATH_ABS_RE 的触发条件是 `Desktop/易经` 前缀, 已经限定了
  //   这是课程路径而非代码标识符, 所以放宽到含 `.` 是安全的。
  const PATH_ABS_RE = /\/Users\/[^\/\s]+\/Desktop\/易经(?:\/[A-Za-z0-9_\u4e00-\u9fff ().,;:!?（）【】·、，。\/-]+)?/g;
  // 「查看 /Users/you/Desktop/course-source 最近修改的…」式题目里, 路径后紧跟**中文/全角标点+空格**
  //   被 PATH_ABS_RE 截断 (「易经 最近」的空格不在子路径字符类里) ⇒ 塌成 course-source.md 假扩展名。
  //   补一条: 路径尾是中文/全角标点时, 把**标点本身**也吃掉 (标点不是路径, 留着不破坏形态)。
  const PATH_ABS_CN_TAIL_RE = /\/Users\/you\/Desktop\/(?:course-source|易经)(\/[A-Za-z0-9_\u4e00-\u9fff ()（）【】·、，。\/.-]*)?[！？。；]/g;
  const PATH_RE = /(?:~\/|\/Users\/you\/)?Desktop\/易经(?:\/[A-Za-z0-9_\u4e00-\u9fff ()（）【】\[\]·、，。\/.-]+)?/g;
  // 课程**子目录名**脱敏: 导出树里 origin 字段 / 注释常写 `<course-source>/<course-file>` ·
  //   `<course-source>/<course-file>` · `<course-source>/<course-file>` 这种**资料库内部结构**,
  //   会把老板的课程目录组织 + 课程文件名泄露。把 易经/ 后面的课程子路径整段塌成 <course-source>。
  //   注意: 只塌**课程子目录** (课程资料/extracted/digest/课程), 公版典籍名 (三命通会/周易/易经原文) 不动。
  const COURSE_SUBDIR_RE = /易经\/(课程资料|extracted|digest|课程|course|extracted\/查法真源)(\/[A-Za-z0-9_\u4e00-\u9fff ()（）【】\[\]·、，。\/.-]*)?/g;
  // 2026-11-26 语义保形 (同 PATH_ABS_RE 那条): COURSE_SUBDIR_RE 命中的是
  //   「<course-source>/<course-file>.md」「<course-source>/<course-file>…」这种**相对路径形态**。塌成裸 token
  //   `<course-source>` 后, 下游 gua_gate PATH_RE 判据 (斜杠+点+目录形态)
  //   不再命中 ⇒ 导出树 fixture 判断翻转 (concrete-target 测试挂)。
  //   替换成占位**相对路径形态** `<course-source>/<course-file>`, 判据形态保留,
  //   课程目录结构 (课程资料/extracted/digest 真实子目录名) 照样脱掉。
  const COURSE_SUBDIR_REPL = '<course-source>/<course-file>';
  // 课程**文件名/章节名**脱敏:
  //   <course-source>_阴阳五行...txt (双下划线) · <course-source> · <course-source> (章节号目录, 可无扩展名)
  //   · extracted/<course-source> 等 <course-source> 塌掉后**残留的课程文件名**。
  // 注意: NN_ 分支要 (a) 前缀非 word 字符 (防 latency_p50_ms / is_60_cycle 这类代码标识符误杀),
  //   (b) 名段含汉字 (纯拉丁名段 ms/cycle 不是课程名), 否则原样保留。
  const COURSE_NAME_NUM_RE = /(?<![A-Za-z0-9_])[0-9]{2}_[A-Za-z\u4e00-\u9fff]{2,12}(?:[^ ]{0,20}\.(?:txt|md))?/g;
  // 课程**专有名词**表 (精确匹配, 不会误伤公版典籍/通用词):
  //   资料名 (<course-source> · <course-source> · <course-source>)
  //   讲师名 (<instructor>) · 课程章节名 (<course-source> 等, 不带扩展名的目录形态)
  const COURSE_TERM_RE = /<course-source>-?八字神煞大全|<course-source>|<instructor>|<course-source>|<course-source>|<course-source>|<course-source>|<course-source>|<course-source>|<course-source>|<course-source>|<course-source>|<course-source>/g;
  let touched = 0;
  const walk = (dir) => {
    for (const e of require('fs').readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { walk(abs); continue; }
      if (!/\.(js|mjs|py|json|md|txt)$/.test(e.name)) continue;
      const fs = require('fs');
      const before = fs.readFileSync(abs, 'utf8');
      // ⚠ 语义保形 (2026-11-26 补): 路径型命中 (/Users/you/Desktop/course-source... 或 绝对路径 Desktop/易经...)
      //   塌成约定占位绝对路径形态 (用户名 you, 本脚本 ABS_PATH_RE 也放过它) ——
      //   塌成裸 token `<course-source>` 会丢掉「这是条绝对路径」的形态。
      //   下游判断层 (answer_alignment.isExternalArtifactTask) 靠 ABSOLUTE_PATH 正则
      //   (以 /Users/ 开头) 识别「资料消化类任务」; 塌成裸 token 会让脱敏后的测试
      //   fixture 判断翻转 (isSelfInspection true↔false, answer-alignment 挂)。
      // ⚠ 只替换路径**前缀** (Desktop/易经), 保留子路径 (/digest/xxx) ——
      //   子路径里的 digest/extracted/learned 等是 EXTERNAL_ARTIFACT_TASK 词表命中依据,
      //   塌成裸 token 会让判定翻转。只换前缀 = 既脱敏 (用户名/目录名) 又保形 (子路径)。
      let after = before.replace(PATH_ABS_RE, (m) => {
        // 提取子路径部分: Desktop/易经[/sub1/sub2...]
        const subMatch = m.match(/^\/Users\/[^\/]+\/Desktop\/易经(\/.*)?$/);
        const sub = subMatch ? subMatch[1] || '' : '';
        return '/Users/you/Desktop/course-source' + sub;
      });
      // 中文句尾标点被 PATH_ABS_RE 截断的「.md 假扩展名」修正: 先吃标点再整体塌
      after = after.replace(PATH_ABS_CN_TAIL_RE, (m) => {
        const subMatch = m.match(/^\/Users\/you\/Desktop\/course-source(\/.*)?/);
        const sub = subMatch ? subMatch[1] || '' : '';
        return '/Users/you/Desktop/course-source' + sub;
      });
      after = after.replace(PATH_RE, (m) => (m.startsWith('~') ? '/Users/you/Desktop/course-source' : m));
      after = after.replace(COURSE_SUBDIR_RE, COURSE_SUBDIR_REPL);
      after = after.replace(/<course-source>{1,2}[0-9A-Za-z【】·\u4e00-\u9fff]{0,20}|课程资料[0-9]{1,2}\.md/g, '<course-source>');
      after = after.replace(COURSE_NAME_NUM_RE, (m) =>
        /[\u4e00-\u9fff]/.test(m.replace(/\.(txt|md)$/, '')) ? '<course-source>' : m);
      // 专有名词: 资料名/章节名 → <course-source>; 讲师名 → <instructor>
      after = after.replace(COURSE_TERM_RE, (m) => (m === '<instructor>' ? '<instructor>' : '<course-source>'));
      // 课程组织词「课程资料」→ 通用「课程资料」(导出树只; 私有树不动)
      after = after.replace(/课程资料/g, '课程资料');
      // 章节号清单 (「课程资料 (章节号略)」式, 章号即课程目录组织) → 隐去
      after = after.replace(/课程资料\s*0[0-9](?:\/0[0-9]){1,2}/g, '课程资料 (章节号略)');
      if (after !== before) { fs.writeFileSync(abs, after, 'utf8'); touched++; }
    }
  };
  walk(outDir);
  console.log('   ✓ 课程私有路径/目录脱敏: ' + touched + ' 个文件 (本机路径 + 课程子目录 + 课程文件名/资料名/讲师名/「课程资料」 → 占位符)');
}

/**
 * 机器标识脱敏 —— 导出树里把「老板的机器名/真实局域网网段」换成通用占位。
 *   · 192.168.0.x (本机真实网段) → 192.168.0.x (保持 RFC1918 私有段, 测试分类断言仍成立)
 *   · your-mac (Mac 机器名) → your-mac; 例外: 卫生测试的守卫正则保留原词 (它是「不许再写死」的守卫)。
 * 私有树一个字不动。
 */
function _deidentifyMachines(outDir) {
  let touched = 0;
  const walk = (dir) => {
    for (const e of require('fs').readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { walk(abs); continue; }
      if (!/\.(js|mjs|py|json|md|txt|sh)$/.test(e.name)) continue;
      const fs = require('fs');
      const before = fs.readFileSync(abs, 'utf8');
      let after = before.replace(/192\.168\.31\./g, '192.168.0.');
      const isHygieneGuard = /open-source-hygiene[^/]*\.test\.js$/.test(e.name);
      if (!isHygieneGuard) after = after.replace(/your-mac/g, 'your-mac');
      if (after !== before) { fs.writeFileSync(abs, after, 'utf8'); touched++; }
    }
  };
  walk(outDir);
  console.log('   ✓ 机器标识脱敏: ' + touched + ' 个文件 (192.168.0.x → 192.168.0.x; your-mac → your-mac, 卫生守卫例外)');
}

/**
 * 7 轨深残留清洗 —— 第一轮排除的是**文件级** (视图/py 工具/测试), 但 7 轨的
 * 代码段还嵌在几个**公共文件**里, 开源版里它们变成死引用/死代码:
 *   1. inline_router.js  八宅户型图 vision 接口 (bazhai 工具已剥 ⇒ 接口必死) → 整段删
 *   2. web/app/lib/bazi/reading.mjs  合婚引擎块 (HEHUN_SECTIONS/buildHehunPrompt/hehunBudgetOf,
 *      导出树 0 个 import 者 ⇒ 死代码) → 整段删
 *   3. web/app/views/bazi.mjs  墓库段调 `api.toolTest('bazhai')` (开源版无此工具) → 空规则降级;
 *      注释里「加餐课03 / 八宅真源」脱敏
 *   4. web 目录注释里的「合婚」→「compat」(中性词, 不露成品轨名; 只动 mjs/css 注释与字符串)
 * 全部内容锚定位, 不依赖行号 (私有树一行不动, 导出可复现)。
 */
function _stripSevenTrackRemnants(outDir) {
  let touched = 0;
  const fs = require('fs');
  const edit = (rel, fn) => {
    const abs = path.join(outDir, rel);
    if (!fs.existsSync(abs)) return;
    const before = fs.readFileSync(abs, 'utf8');
    const after = fn(before);
    if (after !== before) { fs.writeFileSync(abs, after, 'utf8'); touched++; }
  };

  // 1. router: 从「八宅户型图 vision 识别」注释行删到下一段接口 (meihua/cast) 之前
  edit('apps/core/pangu-single/routes/inline_router.js', (src) => {
    const lines = src.split('\n');
    const start = lines.findIndex((l) => l.includes('八宅户型图 vision 识别'));
    const end = lines.findIndex((l) => l.includes('POST /api/meihua/cast'));
    if (start < 0 || end <= start) return src;
    return lines.slice(0, start).concat(lines.slice(end)).join('\n');
  });

  // 2. reading.mjs: 删「============ 合婚轨」到 EOF (合婚块在文件末尾, 无 import 者)
  edit('apps/core/web/app/lib/bazi/reading.mjs', (src) => {
    const idx = src.indexOf('// ============ 合婚轨');
    if (idx < 0) return src;
    return src.slice(0, idx).replace(/\n+$/, '\n');
  });
  // 2b. reading.mjs: 盲派轨 (SECTIONS_MANGPAI + SPEC.section.mangpai) 是 7 轨盲派轨,
  //    走 mangpai.py 查法真源 (导出树已剥)。剥掉定义 + 预算项; bazi.mjs 渲染循环跟着摘。
  edit('apps/core/web/app/lib/bazi/reading.mjs', (src) => {
    let out = src;
    // SECTIONS_MANGPAI 定义块 (export const SECTIONS_MANGPAI = [...] ;)
    out = out.replace(/export const SECTIONS_MANGPAI = \[[\s\S]*?\n\];\n/, '');
    // SPEC.section 里的 mangpai 项 (注释行 + 数据项)
    out = out.replace(/^    \/\/ 盲派轨[^\n]*\n    mangpai:.*\n/gm, '');
    return out;
  });
  // 2c. bazi.mjs: 摘 SECTIONS_MANGPAI 的 import + 盲派渲染循环
  edit('apps/core/web/app/views/bazi.mjs', (src) => {
    let out = src;
    out = out.replace(/^  SECTIONS_MANGPAI,\n/m, '');
    // 盲派渲染循环 (for (const sec of SECTIONS_MANGPAI) {...}) 连同前面注释
    out = out.replace(
      /\n    \/\/ 盲派轨[^\n]*\n(?:    \/\/[^\n]*\n)*    for \(const sec of SECTIONS_MANGPAI\) \{[\s\S]*?\n    \}\n/,
      '\n');
    return out;
  });

  // 3. bazi.mjs: 墓库段 → 空规则 (开源版无 bazhai 工具); 课程/八宅字样脱敏
  edit('apps/core/web/app/views/bazi.mjs', (src) => {
    let out = src;
    out = out.replace(
      "    _mukuCache.p = api.toolTest('bazhai', { muku: '甲' }).then((j) => {\n" +
      "      const r = (j && j.result) || {};\n" +
      "      _mukuCache.rules = r['四柱墓库'] || {};\n" +
      "      return _mukuCache.rules;\n" +
      "    }).catch(() => { _mukuCache.rules = {}; return {}; });\n" +
      "    return _mukuCache.p;\n",
      "    _mukuCache.rules = {};\n" +
      "    _mukuCache.p = Promise.resolve(_mukuCache.rules);\n" +
      "    return _mukuCache.p;   // 开源版无 bazhai 工具, 墓库查法省略 (私有查法层不随公开内核走)\n");
    out = out.replace(
      "  // 墓库与开库 (加餐课03 四柱cai官篇, 第 223 批并八字):\n" +
      "  // 日元财库 → 原局四支是否带库 → 刑冲开库 → 合局化解 → 十神库意。\n" +
      "  // 真源查法走 TOOLS.bazhai --muku (八宅真源里的「四柱墓库」键), 排盘自带日主, 不依赖户型图。\n",
      "  // 墓库与开库 (十神库意: 财才库/官杀库/印库/食伤库):\n" +
      "  // 日元财库 → 原局四支是否带库 → 刑冲开库 → 合局化解 → 十神库意。\n" +
      "  // 查法真源 (私有课程资料, 不随公开版走) 缺失时 → 空规则静默降级, 墓库段不渲染。\n");
    out = out.replace(/加餐课0[0-9]/g, '<course-source> 章节略');
    // 九宫飞星段: 同墓库, loadFeixingRules 调 bazhai 工具 → 开源版无此工具, 空规则降级
    out = out.replace(
      "    _feixingCache.p = api.toolTest('bazhai', { jiugong: 2026, bazhaiFx: true }).then((j) => {\n" +
      "      const r = (j && j.result) || {};\n" +
      "      _feixingCache.rules = r['九宫飞星'] || {};\n" +
      "      _feixingCache.fx = r['八宅飞星结合'] || {};\n" +
      "      return _feixingCache.rules;\n" +
      "    }).catch(() => { _feixingCache.rules = {}; return {}; });\n" +
      "    return _feixingCache.p;\n",
      "    _feixingCache.rules = {};\n" +
      "    _feixingCache.p = Promise.resolve(_feixingCache.rules);\n" +
      "    return _feixingCache.p;   // 开源版无 bazhai 工具, 九宫飞星查法省略 (风水查法层不随公开内核走)\n");
    out = out.replace(
      "  // 九宫飞星 + 八宅结合 (老板 11-08「八宅和九宫飞星结合才是最准的」, 第 226 批):\n" +
      "  // 流年飞星(中宫落星顺飞, 动态气) × 八宅(宅卦伏位起排, 静态宅气) 同宫交叉。\n" +
      "  // 排盘取「大运/流年」当前年, 查九宫飞星真源 + 八宅飞星结合真源。不依赖户型图(流年是查表, 山向需户型图才排得出, 这里先出流年飞星+结合规则)。\n",
      "  // 九宫飞星 (流年: 中宫落星顺飞 动态 × 三元九运 静态):\n" +
      "  // 排盘取「大运/流年」当前年查表。查法真源 (风水查法层, 私有课程资料) 不随公开版走,\n" +
      "  // 缺失时 renderFeixing 显「查法真源未载」静默降级。\n");
    out = out.replace(
      "    note.textContent = '九宫飞星 × 八宅: 同一宫位同看 八宅九星(宅卦静态) + 流年飞星(中宫落星动态) → 吉凶叠加。山向飞星(山星/向星四大格局)需户型图定坐向, 暂标需图。';\n",
      "    note.textContent = '九宫飞星: 中宫落星(动态) 配 三元九运(静态) 同看流年。风水结合查法 (九星同宫叠加/财位优先级) 未随公开版, 需配查法真源。';\n");
    return out;
  });

  // 4. web 注释脱敏: 「合婚」→「compat」(合婚视图已随 7 轨排除, 此处只剩注释/死 CSS 段)
  const walkWeb = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { walkWeb(abs); continue; }
      if (!/\.(mjs|css)$/.test(e.name)) continue;
      const before = fs.readFileSync(abs, 'utf8');
      if (!before.includes('合婚')) continue;
      const after = before.replace(/合婚/g, 'compat');
      if (after !== before) { fs.writeFileSync(abs, after, 'utf8'); touched++; }
    }
  };
  walkWeb(path.join(outDir, 'apps', 'core', 'web'));

  // 5. 64i/fengshui 公版内核: 注释/标签里的课程字样脱敏 (查法真源是课程资料, 公开版只带公版算法层;
  //    「课里/课程/风水(课程名)」→ 中性「查法资料/课程口径」, 不暴露课程目录结构)。
  const fsDir = path.join(outDir, 'apps', 'core', '64i', 'fengshui');
  const REFS = [
    // 出处标签 (会出现在 origin 字段 / 用户可见处)
    ["'风水查法资料资料(八宅/立极定向/四吉四凶/时间历)'", "'风水查法资料 (课程资料, 不随公开版)'"],
    ["'〔风水层为风水查法资料口径, 非《易经》原文〕'", "'〔风水层为课程口径, 非《易经》原文〕'"],
    ["'〔此条为盘古按课程推导, 非课程逐字原文〕'", "'〔此条为盘古推导, 非查法原文〕'"],
    // 注释里的课程组织词
    ["是这一门在课程体系里的名字", "是这一门在课程里的名字"],
    ["是这一门在课程里的名字", "是这一门在课程资料里的名字"],
    ["风水 / 八宅", "风水 / 八宅"],
    ["(课里两套都能起盘)", "(查法资料两套都能起盘)"],
    ["课里「八宅坐向」那页(PDF 第 5 页)是**图片**, 文字层只有标题行", "查法资料里「八宅坐向」那节是**图片**, 文字层只有标题行"],
    ["课里原话", "查法资料原话"],
    ["课里给了", "查法资料给了"],
    ["课里的处理", "查法资料的处理"],
    ["课里本身", "查法资料本身"],
    ["课里对「四要」", "查法资料对「四要」"],
  ];
  const walkFs = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { walkFs(path.join(dir, e.name)); continue; }
      if (!/\.js$/.test(e.name)) continue;
      const abs = path.join(dir, e.name);
      const before = fs.readFileSync(abs, 'utf8');
      let after = before;
      for (const [a, b] of REFS) after = after.split(a).join(b);
      if (after !== before) { fs.writeFileSync(abs, after, 'utf8'); touched++; }
    }
  };
  walkFs(fsDir);

  // 5b. provenance.js 台账里的同款标签字面量必须跟 index.js 同步 (P12 守卫: 台账字面量==代码字面量)
  edit('apps/core/64i/provenance.js', (src) => {
    let out = src;
    for (const [a, b] of REFS) out = out.split(a).join(b);
    // 台账 reason/field 里的课程名「风水」→ 公版词「风水」(课程名=课程结构泄露; 台账是公版内核的一部分)
    // 注意: _stripCoursePaths 已把「课程资料」→「课程资料」, 所以这里匹配的是替换后的形态。
    out = out.split('风水查法资料口径').join('风水课程口径');
    out = out.split('风水查法资料资料').join('风水课程资料');
    out = out.split('风水查法资料').join('风水课程');
    out = out.split('「风水」').join('「风水」');
    return out;
  });

  // 5c. 台账/提取器里的**课程条目**脱敏: 课程序号 (第2/3/4课) + 课程目录大纲是课程结构泄露;
  //     公版术语 (八宅/立极定向/阳宅四要/三元九运) 保留 —— 它们是公版风水学名, 不是课程私货。
  const COURSE_TITLES = [
    ["'风水 第3课 · 八宅八命(命卦算法 / 东西四命 / 宅命相配 / 三元九运锚点)'", "'风水查法资料 · 八宅八命(命卦算法/东西四命/宅命相配/三元九运)'"],
    ["'风水 第3课 · 八宅八命(命卦算法/东西四命/宅命相配/大游年指引)'", "'风水查法资料 · 八宅八命(命卦算法/东西四命/宅命相配/大游年指引)'"],
    ["'风水 第2课 · 立极定向(二十四向山配八卦 / 立极点取法 / 纳气口优先级)'", "'风水查法资料 · 立极定向(二十四向山配八卦/立极点取法/纳气口优先级)'"],
    ["'风水 第2课 · 立极定向(二十四向山配八卦/纳气口定朝向)'", "'风水查法资料 · 立极定向(二十四向山配八卦/纳气口定朝向)'"],
    ["'风水 第4课 · 阳宅四要(门主灶厕 / 卧室凶位化解 / 灶位求向)'", "'风水查法资料 · 阳宅四要(门主灶厕/卧室凶位化解/灶位求向)'"],
    ["'风水 第4课 · 阳宅四要(门主灶厕/催文昌催财催桃花的三层优先级)'", "'风水查法资料 · 阳宅四要(门主灶厕/催文昌催财催桃花的三层优先级)'"],
    ["'风水 阶段性实操案例课(风水堪舆六步 / 大游年歌诀八条全文 / 立极点复习)'", "'风水查法资料 · 三元九运与案例(堪舆步骤/大游年歌诀/复盘)'"],
    ["'风水 阶段性实操案例课(大游年歌诀全文/风水堪舆六步/阳宅四要复盘)'", "'风水查法资料 · 三元九运与案例(大游年歌诀/堪舆六步/阳宅四要复盘)'"],
    ["'风水 · 2001-2040 男女命卦速查表(课内随堂对照表)'", "'风水查法资料 · 男女命卦速查表(2001-2040)'"],
    ["'风水(风水门)第 68 批'", "'风水门 第 68 批'"],
  ];
  for (const rel of ['apps/core/64i/provenance.js', 'apps/core/scripts/extract_provenance_sources.js']) {
    edit(rel, (src) => {
      let out = src;
      for (const [a, b] of COURSE_TITLES) out = out.split(a).join(b);
      // 提取器 note 字段里的课程知识点明细 (判据本身=课程私货) → 通用说明
      out = out.replace(
        "      + '东西四命卦名单 + 宅命相配规则 + 三元九运(九紫离火运 2024-2043) + 实战流程.',\n",
        "      + '宅命相配规则 + 三元九运(九紫离火运 2024-2043) 等查法判据.',\n");
      out = out.replace(
        "      + '纳气口优先级(阳台>大门>客厅)与四条否决条件 + 罗盘三要素.',\n",
        "      + '纳气口取法与优先级判据 + 罗盘三要素.',\n");
      out = out.replace(
        "      + '四凶位卧室化解法 + 催文昌/催财/催桃花的「本命>八宅>流年」优先级 + 十二长生财位表.',\n",
        "      + '四凶位卧室化解法 + 催文昌/催财/催桃花的优先级判据 + 十二长生财位表.',\n");
      out = out.split('风水').join('风水查法资料');
      return out;
    });
  }
  // 课程组织词 「课内/课里」→ 中性「查法资料」(台账注释 + 守卫 reason 字段)
  for (const rel of ['apps/core/64i/provenance.js', 'apps/core/scripts/extract_provenance_sources.js', 'apps/core/modules/global_agent_rules.js']) {
    edit(rel, (src) => src
      .split('课内 PDF').join('查法资料 PDF')
      .split('课内速查表').join('查法资料速查表')
      .split('课内随堂').join('查法资料随堂')
      .split('课内').join('查法资料')
      .split('课里').join('查法资料'));
  }
  edit('apps/core/64i/fengshui/index.js', (src) => src
    .split('课内的对账').join('查法资料的对账')
    .split('课内').join('查法资料')
    .split('课里').join('查法资料'));

  // 5d. 姓氏脱敏: 老板姓「冯」出现在 system prompt / 文档 owner 字段 → 开源版不留。
  //     (《周易》原文「用冯河」的 冯 是河名, 公版典籍, 不动。)
  edit('apps/core/pangu-single.js', (src) => src
    .split('- **冯**(老板/CEO) = 你的主人').join('- 老板 = 你的主人')
    .split('跑在老板本机 Mac M5 Max 上').join('跑在老板本机上'));
  edit('apps/core/docs/v2-architecture.md', (src) => src
    .split('老板(冯)').join('老板'));
  // 通用词: 其他文件里残留的「风水」(课程名) → 公版词
  const deenv = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { deenv(abs); continue; }
      if (!/\.(js|mjs|py|json|md|txt)$/.test(e.name)) continue;
      if (/(provenance|extract_provenance_sources)\.js$/.test(e.name)) continue; // 5c 已处理
      const before = fs.readFileSync(abs, 'utf8');
      if (!before.includes('风水')) continue;
      const after = before.replace(/风水查法资料/g, '风水查法资料').replace(/风水/g, '风水');
      if (after !== before) { fs.writeFileSync(abs, after, 'utf8'); touched++; }
    }
  };
  deenv(outDir);

  console.log('   ✓ 7 轨深残留清洗: ' + touched + ' 个文件 (router 八宅接口 / 合婚引擎块 / bazi 墓库死引用 / 注释脱敏)');
}

// 2026-11-26: 导出树里 EXCLUDES 剥掉的测试文件, test:chain 链里还引用着
//   (provenance-20261022 / fengshui-core / answer-continuity / bazi-hehun 等),
//   test-chain-self 守卫会报「引用了不存在的文件」。把链里已剥掉的条目摘掉。
function _stripTestChainExcluded(outDir) {
  const pkgPath = path.join(outDir, 'apps', 'core', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const chain = (pkg.scripts && pkg.scripts['test:chain:segments']) || '';
  if (!chain) return;
  // 找出所有 EXCLUDES 匹配到的测试文件名 (basename)
  const excludedTestNames = new Set();
  for (const ex of EXCLUDES) {
    for (const m of chain.matchAll(/tests\/([a-z0-9-]+\.test\.js)/g)) {
      const rel = 'apps/core/' + m[0];
      if (isExcluded(rel)) excludedTestNames.add(m[1]);
    }
  }
  if (!excludedTestNames.size) return;
  // 把被剥掉的条目从链里摘掉 (保留 && 连接语义: 摘掉前后各一个 &&)
  let newChain = chain;
  for (const name of excludedTestNames) {
    // 匹配 "node --test tests/NAME" 或 "node tests/NAME" 整段, 连同前面的 &&
    const re = new RegExp('&&\\s*node (?:--test )?tests/' + name.replace(/\./g, '\\.') + '\\s*(?=&|$)', 'g');
    newChain = newChain.replace(re, '');
  }
  // debug: 看替换是否生效
  if (newChain === chain) return;
  pkg.scripts['test:chain:segments'] = newChain;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log('   ✓ test:chain 已剥 ' + excludedTestNames.size + ' 个已排除测试条目');
}

module.exports = { EXCLUDES, isExcluded, _stripSevenTrackWiring, _stripCoursePaths, _deidentifyMachines, _stripSevenTrackRemnants, _stripTestChainExcluded };
