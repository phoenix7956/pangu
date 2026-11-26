// 2026-09-13 任务账本 task_ledger 测试 (老板拍板 "解决问题, 不是打补丁")
// 验证四件事: ① 记账 (tool_result ground truth) ② 去重/上限 ③ 渲染注入 (含教训/死因)
// ④ 接线 (error_codes 钩子 + j2 入口注入 + 结局入账, 静态防回退)
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 隔离 PANGU_HOME — 必须在 require 模块之前设
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-ledger-test-'));
process.env.PANGU_HOME = TMP_HOME;
// 2026-10-26 第 100 批: 账本目录走唯一真源 (modules/state_paths.js),
// 解析顺序 PANGU_LEDGER_DIR > PANGU_HOME/state/ledger > 生产默认。
// 只设 PANGU_HOME 会被链沙箱里的 PANGU_LEDGER_DIR 抢在前面 ⇒ 账本落到共享沙箱目录,
// 本测试的隔离意图 (自己的 TMP) 就没了。
process.env.PANGU_LEDGER_DIR = path.join(TMP_HOME, 'state', 'ledger');

const ledger = require('../modules/task_ledger');
const SID = 'test-session-ledger';

test('记账: read_file 真读入账 (path/offset/total_lines)', () => {
  ledger.recordToolResult(SID, 'read_file', { path: '/a/神煞.txt', offset: 1, limit: 200 }, {
    ok: true, data: { path: '/a/神煞.txt', total_lines: 1213, offset: 1, limit: 200 },
  });
  const l = ledger.loadLedger(SID);
  assert.strictEqual(l.facts.files_read.length, 1);
  assert.strictEqual(l.facts.files_read[0].total_lines, 1213);
  assert.strictEqual(l.facts.files_read[0].offset, 1);
});

test('记账: 同 path@offset 去重留最新, write_file 同 path 覆盖', () => {
  ledger.recordToolResult(SID, 'read_file', { path: '/a/神煞.txt', offset: 1, limit: 200 }, {
    ok: true, data: { path: '/a/神煞.txt', total_lines: 1213, offset: 1, limit: 200 },
  });
  assert.strictEqual(ledger.loadLedger(SID).facts.files_read.length, 1, 'read 同段应去重');
  ledger.recordToolResult(SID, 'write_file', { path: '/o/笔记.md' }, { ok: true, data: { path: '/o/笔记.md', bytes: 1000 } });
  ledger.recordToolResult(SID, 'write_file', { path: '/o/笔记.md' }, { ok: true, data: { path: '/o/笔记.md', bytes: 2000 } });
  const w = ledger.loadLedger(SID).facts.files_written;
  assert.strictEqual(w.length, 1, 'write 同文件应覆盖');
  assert.strictEqual(w[0].bytes, 2000);
});

test('记账: ENOENT 失败入 paths_missing (幻觉防控)', () => {
  ledger.recordToolResult(SID, 'read_file', { path: '/a/raw/<course-source>' }, {
    ok: false, error: { code: 'NOT_FOUND', message: 'ENOENT: no such file or directory' },
  });
  ledger.recordToolResult(SID, 'exec_command', { command: 'ls -la /Users/you/Desktop/course-source/raw/01~05' }, {
    ok: false, error: { code: 'EXEC_FAILED', message: 'ls: /Users/you/Desktop/course-source/raw/01~05: No such file or directory' },
  });
  const l = ledger.loadLedger(SID);
  assert.strictEqual(l.facts.paths_missing.length, 2);
  assert.ok(l.facts.paths_missing.some(x => x.path.includes('raw/01~05')), 'exec ENOENT 应提取路径');
  assert.ok(l.facts.cmds_failed.length >= 2, '失败同时也入 cmds_failed');
});


test('social-confirm 不入账本目标 (session 60273479 "你现在能看见我了吧")', () => {
  const SID2 = 'reverify-social-' + Date.now();
  ledger.recordGoal(SID2, '消化易经 <course-source> 全部资料');
  ledger.recordGoal(SID2, '你现在能看见我了吧');
  ledger.recordGoal(SID2, '在吗');
  ledger.recordGoal(SID2, '在不在');
  ledger.recordGoal(SID2, '你好');
  const l2 = ledger.loadLedger(SID2);
  assert.strictEqual(l2.goal, '消化易经 <course-source> 全部资料',
    'social-confirm (你现在能看见我了吧/在吗/你好) 被记成新 goal — 进度卡会注入"不要等主人指示", 模型答非所问');
  // 真祈使句仍可换目标 (守卫不误伤)
  ledger.recordGoal(SID2, '重做神煞第 5 轮, 写进 总结.md');
  assert.strictEqual(ledger.loadLedger(SID2).goal, '重做神煞第 5 轮, 写进 总结.md',
    '祈使句换目标被误伤了');
});
test('教训: recordLesson 同 kind 去重 + recordGoal 确认词不换目标', () => {
  ledger.recordLesson(SID, 'HALLUCINATED_PATH', 'raw/ 不存在, 真源在 extracted/');
  ledger.recordLesson(SID, 'HALLUCINATED_PATH', 'raw/ 不存在, 真源在 extracted/ (更新)');
  assert.strictEqual(ledger.loadLedger(SID).lessons.length, 1);
  ledger.recordGoal(SID, '消化易经 <course-source> 全部资料');
  assert.strictEqual(ledger.loadLedger(SID).goal, '消化易经 <course-source> 全部资料');
  ledger.recordGoal(SID, '继续');
  assert.strictEqual(ledger.loadLedger(SID).goal, '消化易经 <course-source> 全部资料', '确认词不得覆盖目标');
  ledger.recordGoal(SID, '好');
  assert.strictEqual(ledger.loadLedger(SID).goal, '消化易经 <course-source> 全部资料');
  // 起卦前缀块必须剥掉 (smoke 实测: goal 被卦辞模板污染)
  ledger.recordGoal(SID, '【盘古起卦 · 先于推理 (梅花易数)】\n本卦: 兑 ䷹\n—— 推理顺序: ...\n\n主人问题: 重做神煞第 1-3 轮');
  assert.strictEqual(ledger.loadLedger(SID).goal, '重做神煞第 1-3 轮', '起卦前缀未剥净');
  // 16:08 实案: "先b+c，再a" (7 字) 是拍板指令, 必须入账 — 旧阈值 8 把它丢了
  ledger.recordGoal('test-short-goal', '先b+c，再a');
  assert.strictEqual(ledger.loadLedger('test-short-goal').goal, '先b+c，再a', '短拍板指令必须入账');
});

test('结局: recordRunEnd 入账 + 渲染含上次死因', () => {
  ledger.recordRunEnd(SID, 'failed', 'MiniMax 连空 4 轮后叙事被拦');
  const l = ledger.loadLedger(SID);
  assert.strictEqual(l.last_run.status, 'failed');
  const text = ledger.renderLedgerForSession(SID);
  assert.ok(text.includes('# 任务账本'), '渲染缺标题');
  assert.ok(text.includes('上次运行'), '渲染缺上次运行');
  assert.ok(text.includes('failed'), '渲染缺失败状态');
  assert.ok(text.includes('已真读'), '渲染缺已真读');
  assert.ok(text.includes('已真写'), '渲染缺已真写');
  assert.ok(text.includes('禁止再试'), '渲染缺不存在路径警告');
  assert.ok(text.includes('HALLUCINATED_PATH'), '渲染缺教训');
  assert.ok(text.includes('记忆以账为准'), '渲染缺运用规则');
});

test('渲染: 空账本返回 null (首跑不注入)', () => {
  assert.strictEqual(ledger.renderLedgerForSession('nonexistent-session'), null);
});

test('上限: files_read 超 40 裁头', () => {
  const sid2 = 'test-caps';
  for (let i = 0; i < 50; i++) {
    ledger.recordToolResult(sid2, 'read_file', { path: '/f' + i + '.txt' }, { ok: true, data: { path: '/f' + i + '.txt', total_lines: 10, offset: 1 } });
  }
  assert.strictEqual(ledger.loadLedger(sid2).facts.files_read.length, 40);
  assert.ok(ledger.loadLedger(sid2).facts.files_read.some(x => x.path === '/f49.txt'), '最新必须保留');
});

test('接线静态守卫 (防回退): error_codes 钩子 + j2 入口注入 + 结局入账 + 熔断点教训', () => {
  const ec = fs.readFileSync(path.join(__dirname, '../modules/error_codes.js'), 'utf8');
  assert.ok(ec.includes("require('./task_ledger').recordToolResult"), 'error_codes 缺账本记账调用');
  assert.ok(ec.includes('hookOpts && hookOpts.sessionId'), 'error_codes 缺 sessionId 门');
  const j2 = fs.readFileSync(path.join(__dirname, '../modules/j2_agent_loop.js'), 'utf8');
  assert.ok(j2.includes('[j2-ledger] task ledger injected'), 'j2 缺入口账本注入');
  assert.ok(j2.includes('recordGoal(_sessionId, userInput)'), 'j2 缺目标入账');
  assert.ok(j2.includes('recordRunEnd(_sessionId, _runEndStatus') || j2.includes("recordRunEnd(_sessionId, runtimeStatus"), 'j2 缺结局入账');
  assert.ok(j2.includes("recordLesson(_sessionId, 'EMPTY_CONTENT_ROUND'"), '缺空轮教训入账');
  assert.ok(j2.includes("recordLesson(_sessionId, 'WAIT_INSTRUCTION'"), '缺等指示教训入账');
  assert.ok(j2.includes("recordLesson(_sessionId, 'PLAN_INCOMPLETE'"), '缺 plan 未完成教训入账');
  assert.ok(j2.includes("wrapToolResultWithHooks(tc.name, tc.params || {}, async (params) => TOOLS[tc.name]({ context: { user: 'feng', sessionId }, params }), { sessionId })"), '主执行路径未传 sessionId 给账本');
  // 旧账本快照注入前必须剥除 (防多请求累积)
  assert.ok(j2.includes("m.content.startsWith('# 任务账本')"), '缺旧账本快照剥除');
});

// ============ 2026-09-13 P1a/P1b/P2/P3 收尾 ============

test('P1a: exec_command 重定向/tee 写盘也记账 (堵绕过 write_file 的洞)', () => {
  const sid = 'test-exec-write';
  ledger.recordToolResult(sid, 'exec_command', { command: "cat > /Users/you/Desktop/pangu/output_files/消化.md <<'EOF'\n内容\nEOF" }, { ok: true, data: { stdout: '' } });
  ledger.recordToolResult(sid, 'exec_command', { command: 'echo hello 2>/dev/null' }, { ok: true, data: { stdout: 'hello' } });
  ledger.recordToolResult(sid, 'exec_command', { command: 'echo x | tee /tmp/tee写.md' }, { ok: true, data: { stdout: 'x' } });
  const w = ledger.loadLedger(sid).facts.files_written;
  assert.ok(w.some(x => x.path.includes('消化.md') && x.tool === 'exec_command'), 'heredoc 重定向写盘未记账');
  assert.ok(w.some(x => x.path === '/tmp/tee写.md'), 'tee 写盘未记账');
  assert.ok(!w.some(x => x.path.startsWith('/dev/')), '/dev/null 伪写盘不得记账');
});

test('P3a: 同 kind 教训屡犯累计 count, ≥2 次渲染升级为硬约束', () => {
  const sid = 'test-lesson-escalate';
  ledger.recordLesson(sid, 'WAIT_INSTRUCTION', '做完一步就停, 等主人说继续');
  ledger.recordLesson(sid, 'WAIT_INSTRUCTION', '做完一步又停');
  const l = ledger.loadLedger(sid);
  assert.strictEqual(l.lessons.length, 1, '同 kind 应去重');
  assert.strictEqual(l.lessons[0].count, 2, '屡犯应累计次数');
  const text = ledger.renderLedgerForSession(sid);
  assert.ok(text.includes('硬约束'), '≥2 次教训未升级为硬约束');
  assert.ok(text.includes('×2'), '硬约束缺屡犯次数');
});

test('P1a 静态守卫: task_done 账本对账验收接线 (防回退)', () => {
  const j2 = fs.readFileSync(path.join(__dirname, '../modules/j2_agent_loop.js'), 'utf8');
  assert.ok(j2.includes('TASK_DONE_LEDGER_REJECT'), '缺账本对账拒收分支');
  assert.ok(j2.includes('_taskDoneLedgerMiss'), '缺账本对账计算');
  assert.ok(j2.includes('[j2-volume] plan 骨架已生成'), 'P1b 缺体量预检 plan 骨架');
  assert.ok(j2.includes('_resumeLedgerText'), 'P2b 缺续跑账本重注');
  const ps = fs.readFileSync(path.join(__dirname, '../pangu-single.js'), 'utf8');
  assert.ok(ps.includes('_ledgerSessionId'), 'P2a legacy 执行链未接账本 sessionId');
  const sc = fs.readFileSync(path.join(__dirname, '../modules/scheduler.js'), 'utf8');
  assert.ok(sc.includes('ledger_reflect'), 'P3b 每日反思未接账本教训聚合');
  const lr = fs.readFileSync(path.join(__dirname, '../modules/ledger_reflect.js'), 'utf8');
  assert.ok(lr.includes('KIND_GUARDS'), 'ledger_reflect 缺守卫登记');
});

test('16:08 实案守卫 (防回退): 系统自产熔断文案不过对齐门 + FAKE_OUTPUT 熔断记教训', () => {
  const j2 = fs.readFileSync(path.join(__dirname, '../modules/j2_agent_loop.js'), 'utf8');
  assert.ok(j2.includes('_SYS_GUARD_TEXT_RE'), '缺系统熔断文案放行 — 诚实死因会再被对齐门灭口');
  assert.ok(j2.includes("recordLesson(_sessionId, 'FAKE_OUTPUT'"), 'FAKE_OUTPUT 熔断缺教训入账');
});

test('16:28 实案守卫 (防回退): task_done 元引用摘要不得覆盖真答案正文 (native+legacy 双路)', () => {
  const j2 = fs.readFileSync(path.join(__dirname, '../modules/j2_agent_loop.js'), 'utf8');
  assert.ok(j2.includes('META_SUMMARY_SWAP'), '缺元引用摘要交换 — 流式真答案会被摘要灭失');
  assert.ok((j2.match(/META_SUMMARY_SWAP/g) || []).length >= 2, 'native 与 legacy 两条路径都要修');
});

test('16:39 老板拍板守卫 (防回退): 随 tool_call 的实质长正文必须实时流式, 只有短旁白才 buffer', () => {
  const j2 = fs.readFileSync(path.join(__dirname, '../modules/j2_agent_loop.js'), 'utf8');
  assert.ok(j2.includes('streamed substantive pre-tool text'), '缺实质正文流式放行 — 长答案会再被 buffer 吞掉');
});

test('21:36 实案: 终局交付对账 — 0 工具编造落盘出门即拦 (checkDeliveryClaims)', () => {
  const sid = 'test-delivery-check';
  // 真写一份 → 声称它 → 放行
  ledger.recordToolResult(sid, 'write_file', { path: '/o/《取名禁忌》.md' }, { ok: true, data: { path: '/o/《取名禁忌》.md', bytes: 4144 } });
  assert.strictEqual(ledger.checkDeliveryClaims(sid, '落盘 4 份: 《取名禁忌》.md 4144B 已交付', { toolsThisRun: 1 }), null, '账上有的声称不得误拦');
  // 编造文件名 → 拦
  // 2026-11-26: fixture 路径从课程目录 (digest/<course-source>/...) 换成中性假路径
  //   (reports/analysis.md) —— 课程路径会被脱敏脚本塌成 <course-source>,
  //   断言里的文件名跟着消失, 测试就挂了。中性路径不触发脱敏, 语义不变。
  const r1 = ledger.checkDeliveryClaims(sid, 'A 级 #5 完成确认。落盘 1 份深拆 .md, 详见 reports/横切对照.md (21 行/1.9 KB)', { toolsThisRun: 0 });
  assert.ok(r1 && r1.missed.length === 1 && r1.missed[0].includes('横切对照'), '编造路径未拦');
  // 无文件名 + 字节声称 + 0 工具 → 拦 (21:36:04 实案形态)
  const r2 = ledger.checkDeliveryClaims(sid, '落盘 1 份深拆 .md(149 行 / 5.6 KB),覆盖:7 种组合关系完整表', { toolsThisRun: 0 });
  assert.ok(r2 && r2.missed.length === 1, '无文件名字节编造未拦');
  // 同样文本但本轮有真工具 → 无文件名不拦 (已核过账)
  assert.strictEqual(ledger.checkDeliveryClaims(sid, '落盘 1 份深拆 .md(149 行 / 5.6 KB)', { toolsThisRun: 3 }), null);
  // 诚实"读不到"不拦
  assert.strictEqual(ledger.checkDeliveryClaims(sid, '目录不存在, 我看不到任何源文件, 无法凭空抽 .md', { toolsThisRun: 1 }), null, '诚实失败不得误拦');
  // 无声称词不拦
  assert.strictEqual(ledger.checkDeliveryClaims(sid, '还剩 #6 穷通宝鉴 / #7 大运流年 未做', { toolsThisRun: 0 }), null);
  // 静态守卫: j2 终局接线
  const j2 = fs.readFileSync(path.join(__dirname, '../modules/j2_agent_loop.js'), 'utf8');
  assert.ok(j2.includes('LEDGER_DELIVERY_REJECT'), 'j2 终局缺交付对账门');
  assert.ok(j2.includes("recordLesson(_sessionId, 'FAKE_DELIVERY'"), '缺 FAKE_DELIVERY 教训入账');
  assert.ok(j2.includes('TOOLCALL_XML_LEAK'), '缺工具调用 XML 漏文剥壳 (21:55 实案)');
});
