'use strict';
/**
 * tests/self-check-alert-noise-20261030.test.js
 *
 * 第 171 批守卫 —— 「盘古时不时弹警告说它坏了」
 *
 * 老板 10-30: 「时不时会系统弹出警告, 说盘古怎么了」。
 * 查出来的事实 (macOS 通知中心 db + launchd + 日志):
 *   弹的是 macOS 通知横幅, 标题「Pangu Self-Check」, 正文「verify 失败 1 项 (期望 0)」,
 *   **每小时一次, 连着三天** (10-27 ~ 10-30 的 :33 分)。
 *
 * 根因不是盘古坏了, 是**检查项自己过期了**:
 *   scripts/pangu-audit-verify.sh 的 #3 要求 `docs/Q2-DECISION.md` 住在**项目 repo 里**,
 *   而那份文档早按 AGENTS.md §6「产出 → 日期工作目录 / 过程文档不进项目 repo」
 *   搬到了 ~/Documents/Codex/2026-10-26/pangu-process-docs/。
 *   检查还守着老位置 ⇒ 永远找不到 ⇒ 永远 ❌ ⇒ 每小时弹一次「盘古坏了」。
 *   (这跟老板猜的「跟原来的盘古桌面端有关」半对: 弹窗确实还带着老桌面端的痕迹 ——
    pangu 仓库的 git 身份至今是「墨-OpenClaw」。)
 *
 * 这批守卫盯三件事:
 *   ① verify 的 #3 不许只认 repo 内那个老位置 (必须认文档的新家, 或认代码里的
 *      launchctl asuser fallback —— 决策的落地形态);
 *   ② self-check 的告警必须有指纹去重 (同一条 24h 内只弹一次) ——
      否则任何一项恒失败都会变回「每小时弹」;
 *   ③ 开发期常态 (working tree 脏) 不许触发通知。
 *
 * 教训 (踩坑日志第 345 条): **恒失败的检查项 = 每小时一次的假警报**。
 * 一个检查项如果永远 fail, 它就不该留在「会弹通知」的链路里。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const VERIFY = path.join(REPO, 'scripts', 'pangu-audit-verify.sh');
const SELF_CHECK = path.join(REPO, 'scripts', 'pangu-self-check.sh');

const verifySrc = fs.readFileSync(VERIFY, 'utf8');
const selfCheckSrc = fs.readFileSync(SELF_CHECK, 'utf8');

test('171-1: verify 的 #3 不得只认 repo 内那个老位置', () => {
  // #3 那段 (从 "Bug #3" 到下一个 "# Bug #" 或 EOF)
  const m = verifySrc.match(/# Bug #3[\s\S]*?(?=\n# Bug #4|\nEOF|$)/);
  assert.ok(m, '找不到 #3 检查项');
  const seg = m[0];

  // 认文档的新家 (§6 日期工作目录)
  assert.ok(/Documents\/Codex/.test(seg),
    '#3 必须认文档的新家 (Documents/Codex 日期工作目录) —— 只认 repo 里的 docs/ '
    + '⇒ 文档一搬家就恒失败 ⇒ 每小时弹一次假警报');
  // 认决策在代码里的落地形态 (launchctl asuser fallback)
  assert.ok(/launchctl asuser/.test(seg),
    '#3 必须认「决策已落地到代码」这条判据 (launchctl asuser fallback)');
  // 老判据不能被删掉 (还可能有人把文档放回 repo)
  assert.ok(/docs\/Q2-DECISION\.md/.test(seg),
    '#3 不许把 repo 内 docs/Q2-DECISION.md 这条老判据删掉');
});

test('171-2: self-check 的告警必须有指纹去重', () => {
  assert.ok(/FP_FILE/.test(selfCheckSrc) && /FP_WINDOW/.test(selfCheckSrc),
    'self-check 必须有告警指纹 + 去重窗口, 否则任何恒失败项都会每小时弹一次');
  // 去重窗口不能太长 (真异常还是要能重弹), 也不能太短 (等于没去重)
  const m = selfCheckSrc.match(/FP_WINDOW=(\d+)/);
  assert.ok(m, '找不到 FP_WINDOW');
  const win = Number(m[1]);
  assert.ok(win >= 3600 && win <= 3 * 86400,
    `去重窗口 ${win}s 不合理 —— 至少 1 小时 (否则等于没去重), 至多 3 天 `
    + '(否则真异常长期静默)');
  // alert() 里必须真的走指纹判定
  assert.ok(/shasum/.test(selfCheckSrc), '指纹必须用内容哈希 (消息变了就是新告警)');
});

test('171-3: 开发期常态 (working tree 脏) 不许触发通知', () => {
  // verify 的 working tree 那一项必须被排除在 critical 之外
  assert.ok(/grep -vc "working tree"/.test(selfCheckSrc),
    'self-check 必须把 working tree 脏排除在 critical 之外 —— '
    + '开发中工作区本来就常常是脏的, 不该每小时弹一次');
});

test('171-3b: 负例自检 —— 恒失败的检查项会被判出来', () => {
  // 造一段「只认 repo 老位置」的坏 #3, 断言 171-1 的判据挑得出来
  const bad = [
    '# Bug #3 — Q2',
    'Q2_DOC="$PANGU_DIR/docs/Q2-DECISION.md"',
    'if [[ -f "$Q2_DOC" ]]; then',
    '  check "#3" "1" "ok"',
    'else',
    '  check "#3" "0" "文件不存在"',
    'fi',
  ].join('\n');
  const m = bad.match(/# Bug #3[\s\S]*?(?=\n# Bug #4|\nEOF|$)/);
  assert.ok(m);
  const seg = m[0];
  const picksUp = /Documents\/Codex/.test(seg) || /launchctl asuser/.test(seg);
  assert.ok(!picksUp, '负例自检失败: 坏 #3 竟然通过了判据');
});

test('171-4: verify 现在跑下来 critical 必须是 0', () => {
  // 真跑一次: 有 critical fail 就说明又有个恒失败项在弹假警报
  let out = '';
  try {
    out = execFileSync('bash', [VERIFY], { encoding: 'utf8', timeout: 60000, cwd: REPO });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
  }
  const failLines = out.split('\n').filter((l) => l.includes('❌'));
  const critical = failLines.filter((l) => !l.includes('working tree'));
  assert.deepStrictEqual(critical, [],
    'verify 有非 working-tree 的失败项 ⇒ 它会每小时弹一次「盘古坏了」: '
    + critical.join(' | '));
});

