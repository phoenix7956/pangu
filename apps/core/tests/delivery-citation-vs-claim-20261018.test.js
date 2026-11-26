// 2026-10-18 现场 desktop-1792306846566 —— "全面介绍一下你自己" 一句都没交付出去。
//
// 3 个 analyzer 子 agent 各自交出带完整证据的答复 (ls/cat/grep 的真实路径 + 字节数 +
// 行号), 父级合成后连收两道 ⚠️ [盘古 对账拦截], 主人收到的是拦截提示而不是答案。
//
// 根因是类别错误: checkDeliveryClaims 把答复里出现的**每一个** .md/.json 路径都当成
// "声称写盘"。但只读取证任务的正确答法恰恰是把源码路径**当证据列出来** ——
// 引用 (citation) 被当成冒领 (claim), 于是越举证越被判编造。
//
// 修法: 只有**带创作谓词**的路径才进对账; 裸路径按引用放过。
// 下面 3 条钉死这个区分, 并且钉死"真冒领仍然要拦" —— 别把它改成放行一切。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ledger = require('../modules/task_ledger');
const { checkDeliveryClaims, _claimHasAuthorshipPredicate } = ledger;

const mkSid = () => 'cite-vs-claim-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

test('2026-10-18 现场: 只读取证答复把源码路径当证据列出 → 不拦', () => {
  const sid = mkSid();
  // 骨架逐字取自 desktop-1792306846566 那个被拦两次的答复
  // (memory/memory/sessions/2026-10-18.md 07:03:11 的 analyzer 答复 + 父级合成)。
  //
  // 引燃点就是 "最近写入 10-18 15:01" 那一个词 —— 它在报 checkpoint 目录的**文件
  // mtime** (系统写的), 不是在声称自己写盘。但 9 个触发词命中任意一个就把整段
  // 拉进写盘对账, 于是 MEMORY.md / models.json / your-mac.json 全被判"账上无据"。
  const answer = [
    '① 完成: 用 8 次真实工具调用（exec_command×7 + read_file×1 + list_pangu_agents）核查了技能层、沙箱层、记忆层、工具 schema、自扫自修、易经消化产物，全部只读，未写盘。',
    '',
    '② 证据:',
    '- **技能层**：`ls -la ~/.pangu/skills/` → 5 项，其中 4 个是软链接。',
    '- **沙箱白名单**：`/Users/you/Desktop/pangu/apps/core/modules/sandbox.js:203` `const ALLOWED_PATHS = [`',
    '- **节点配置**：`/Users/you/Desktop/pangu/apps/core/config/nodes/your-mac.json` → 端口 18901，主模型走 LM Studio 本地端点。',
    '- **模型池**：`/Users/you/Desktop/pangu/apps/core/modules/router/models.json` 策略 smart, fallback 链 5 级。',
    '- **记忆层**：`/Users/you/.pangu/memory/MEMORY.md` 90,787 字节。',
    '- **checkpoint**：`~/.pangu/state/checkpoints/` 实测 **3470** 个 json，目录 391,272 字节，最近写入 10-18 15:01。',
  ].join('\n');

  const r = checkDeliveryClaims(sid, answer, { toolsThisRun: 9 });
  assert.equal(r, null, '只读取证答复不该被判成冒领写盘 —— 旧逻辑在这里返回 missed 并连拦两道');
});

test('创作谓词在同行时 → 仍然算声称写盘, 老文件也照拦 (别把门放平)', () => {
  const sid = mkSid();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cite-vs-claim-'));
  // 三个月前的旧文件 —— 模型若声称本轮生成了它, 那就是**真冒领**, mtime 再老也得拦。
  const old = path.join(dir, 'report.md');
  fs.writeFileSync(old, 'old');
  const oldTime = Date.now() - 90 * 24 * 3600 * 1000;
  fs.utimesSync(old, new Date(oldTime), new Date(oldTime));

  const r = checkDeliveryClaims(sid, `① 完成: 已生成 ${old} 并交付。`, { toolsThisRun: 2 });
  assert.ok(r && r.missed.length, '带"已生成"的老文件是冒领, 必须拦住');
  assert.ok(r.missed.some((m) => m.endsWith('report.md')));
});

test('谓词归行: "只读未写"那行里的路径按引用, 隔壁"已写入"那行照拦', () => {
  const text = [
    '- **记忆层**: 实测 MEMORY.md 90,787 字节, 只读未写。',
    '- 已写入 /tmp/delivery-guard-probe/never_written.md, 交付完成',
  ].join('\n');
  assert.equal(_claimHasAuthorshipPredicate('MEMORY.md', text), false,
    '引用行不该算声称 —— "只读未写"就是没写');
  assert.equal(_claimHasAuthorshipPredicate('/tmp/delivery-guard-probe/never_written.md', text), true,
    '隔壁行的"已写入"要算数, 谓词按所在行归位');
});

test('mtime 报告不算创作: "MEMORY.md 最近写入 10-18 15:01" 同行也不拦', () => {
  // 现场那句话的本体 —— 一行式答复里 mtime 和路径写在一起时最容易复发。
  const line = '- **记忆层**：`/Users/you/.pangu/memory/MEMORY.md` 90,787 字节，最近写入 10-18 15:01。';
  assert.equal(_claimHasAuthorshipPredicate('/Users/you/.pangu/memory/MEMORY.md', line), false,
    '"最近写入 <时间>" 是报 mtime, 主语是文件系统 —— 不是盘古冒领');
  assert.equal(
    _claimHasAuthorshipPredicate('report.md', '- 我已写入 report.md, 交付完成'),
    true,
    '别把真冒领也一起放过 —— 这条必须仍然算数');
});
