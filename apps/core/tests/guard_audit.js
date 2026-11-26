// guard_audit.js — 盘古守卫全审计矩阵 (2026-09-14 老板拍: 全面排查, 不做假)
// 每个守卫 = 该杀用例 + 不该杀用例, 全部来自真实事故/真实正常场景
// 跑法: node apps/core/tests/guard_audit.js  (退出码 0 = 全过, 1 = 有误杀/漏杀)
const path = require('path');
const M = (n) => require(path.join(__dirname, '..', 'modules', n));
const aa = M('answer_alignment');
const gp = M('guard_patterns');
const j2h = M('j2_helpers');
const shared = M('j2_loop_shared');

let pass = 0, fail = 0;
const failures = [];
function T(guard, text, want, note) {
  // want: true = 该杀(拦截/命中), false = 不该杀(放行)
  let got;
  try { got = guard(text); } catch (e) { got = 'THROW: ' + e.message; }
  const ok = got === want;
  if (ok) pass++; else { fail++; failures.push({ note, want, got, text: String(text).slice(0, 60) }); }
  console.log((ok ? '✓' : '✗') + ' [' + note + '] 期望' + (want ? '杀' : '放') + ' 实际' + (got === true ? '杀' : got === false ? '放' : got));
}

console.log('═══ 1. 体量预检 isHeavyDigestTask (问进度 ≠ 下任务) ═══');
T(aa.isHeavyDigestTask, '/Users/you/Desktop/course-source，现在消化吸收了多少了', false, '老板实案05:45 查进度');
T(aa.isHeavyDigestTask, '/Users/you/Desktop/course-source 消化进度如何', false, '查进度2');
T(aa.isHeavyDigestTask, '/Users/you/Desktop/course-source 还有哪些没消化', false, '查缺口');
T(aa.isHeavyDigestTask, '消化 /Users/you/Desktop/course-source/extracted/ 里的三命通会资料并写总结', true, '真任务');
T(aa.isHeavyDigestTask, '先消化 /Users/you/Desktop/course-source 课程资料04', true, '真任务2');
T(aa.isHeavyDigestTask, '把 /Users/you/Desktop/course-source 全部消化掉', true, '真任务3');
T(aa.isHeavyDigestTask, '继续消化 /Users/you/Desktop/course-source 剩下的好吗', true, '疑问+行动动词仍是任务');

console.log('═══ 2. 编排泄漏 isOrchestrationLeak (实质报告+元话尾巴 ≠ 泄漏) ═══');
T(aa.isOrchestrationLeak, '易经消化进度盘点: 源文件 extracted/ 40 个, 约 1.2MB, 含三命通会 646KB、完整版易经 100KB。消化产出 digest/ 17 个 md, 约 2400 行。<course-source> 8 文件 987 行最深。/Users/you/Desktop/course-source/digest/<course-source> 已落盘 3 份。下一步建议: 继续推课程资料 (章节号略), 等你拍。', false, '老板22:08正常答案 不许杀');
T(aa.isOrchestrationLeak, '好的我先查一下, 然后再看情况, 下一步继续推进。', true, '纯元话 必须杀');
T(aa.isOrchestrationLeak, '我先排查再确认, 等主人拍板, 这次直接干。', true, '纯元话2 必须杀');
T(aa.isOrchestrationLeak, '好的', false, '短确认 不杀');

console.log('═══ 3. task_done 唇枪舌剑 LIP_SERVICE (0 工具+计划话术 → 拒收) ═══');
T(gp.isLipServiceText, '收到，我这就开盘: 先列出清单再逐个读, 接下来读完再消化。', true, '光说不做 杀');
T(gp.isLipServiceText, '收到，开盘。', false, '短句不杀 (<30字防误伤)');
T(gp.isLipServiceText, '已完成 3 个子块消化: <course-source> (4558B) / <course-source> (5878B) / <course-source> (5519B) 全部落盘 digest/<course-source>/。', false, '真交付报告 不杀');

console.log('═══ 4. OVERCLAIM (全集断言拒收) ═══');
T((t) => gp.OVERCLAIM_RE.test(t), '全部消化完成, 7 个主题都搞定了', true, '全集断言 杀');
T((t) => gp.OVERCLAIM_RE.test(t), '排查已全部完成', true, '全集断言2 杀');
T((t) => gp.OVERCLAIM_RE.test(t), '已完成 3/7 块, 剩三命通会/易经全文/梅花原典/阳宅深化 4 块', false, '实数进度 不杀');

console.log('═══ 5. UNVERIFIED_CLAIM (0 工具系统状态断言 → 逼举证) ═══');
T((t) => gp.UNVERIFIED_CLAIM_RE.test(t), '该文件不存在, 所以无法读取', true, '凭空断言 杀');
T((t) => gp.UNVERIFIED_CLAIM_RE.test(t), '沙箱拦截了这个操作', true, '凭空断言2 杀');
T((t) => gp.UNVERIFIED_CLAIM_RE.test(t), '文件内容如下: 乾为天 坤为地', false, '正常引用 不杀');

console.log('═══ 6. FAKE_OUTPUT (0 写工具产出谎称) ═══');
T((t) => gp.FAKE_OUT_RE.test(t), '已写入 总结.md, 共 5.6KB 已存好', true, '谎称落盘 杀');
T((t) => gp.FAKE_OUT_RE.test(t), 'digest/ 下有 5 个 md 文件, 总计约 24KB', false, '查到的实况 不杀');
T((t) => gp.FAKE_EDIT_RE.test(t), '已修复 const 赋值的 bug', true, '谎称改码 杀');
T((t) => gp.FAKE_EDIT_RE.test(t), '建议把 const 改成 let 来修复', false, '建议非声称 不杀');

console.log('═══ 7. FAKE_TOOLCALL (文字假装调工具) ═══');
T((t) => gp.FAKE_TC_TEXT_RE.test(t), '(调用工具: exec_command) 我来跑一下', true, '假动作 杀');
T((t) => gp.FAKE_TC_TEXT_RE.test(t), '[调用工具: memory_search]', true, '假动作2 杀');
T((t) => gp.FAKE_TC_TEXT_RE.test(t), '我用 exec_command 跑了 ls, 结果如下', false, '叙述已发生的真调用 不杀');

console.log('═══ 8. 续跑确认 RESUME_ACK (单字母/短确认 = 续跑) ═══');
T((t) => gp.RESUME_ACK_RE.test(t), 'A', true, '单字母A 是续跑');
T((t) => gp.RESUME_ACK_RE.test(t), 'b', true, '单字母b 是续跑');
T((t) => gp.RESUME_ACK_RE.test(t), '继续', true, '继续 是续跑');
T((t) => gp.RESUME_ACK_RE.test(t), '继续消化三命通会', false, '带任务的继续 不是纯确认');
T((t) => gp.RESUME_ACK_RE.test(t), '全部消化', false, '新任务 不是确认');

console.log('═══ 9. 伪工具调用打捞 _extractToolCallsFromText ═══');
T((t) => j2h._extractToolCallsFromText(t).length > 0, '我先看清单。[调用工具: exec_command]][<command>cat /a.md 2>/dev/null]</command>]</invoke>]</tool_call>]', true, '老板05:24实案 方括号变体 打捞');
T((t) => j2h._extractToolCallsFromText(t).length > 0, '<tool_call>{"name":"exec_command","arguments":{"command":"ls /tmp"}}</tool_call>', true, '裸JSON 打捞');
T((t) => j2h._extractToolCallsFromText(t).length === 0, '正常回答没有任何标记', true, '正常文本 零打捞');
T((t) => !/<\/?(invoke|tool_call|command)>|调用工具/.test(j2h._stripPseudoToolMarkup(t)), '<tool_call>\n{"name": "exec_command", "argum', true, '未闭合截断 剥干净');

console.log('═══ 10. FOUNTAIN 复读检测 ═══');
T(() => {
  const st = { lastRoundText: null, fountainRepeat: 0 };
  for (let i = 0; i < 6; i++) shared._j2DetectFountain('同一段输出文本', st);
  return shared._j2DetectFountain('同一段输出文本', st).repeat; // 阈值 5, 第 7 次必触发
}, '', true, '同文本连发 必须杀');
T(() => {
  const st = { lastRoundText: null, fountainRepeat: 0 };
  shared._j2DetectFountain('第一段不同内容', st);
  shared._j2DetectFountain('第二段不同内容', st);
  return shared._j2DetectFountain('第三段不同内容', st).repeat;
}, '', false, '不同内容 不杀');

console.log('═══ 11. 对齐门 guardAnswer ═══');
T((t) => aa.guardAnswer('现在几点', t, '', '').aligned, '现在 03:20, 周一凌晨', true, '对题短答 放行');
T(() => aa.guardAnswer('/Users/you/Desktop/course-source 消化吸收进度', '我先查一下再确认, 等主人拍板', '', '').blocked, '', true, '跑题元话 拦截');

console.log('═══ 12. resolveTaskInput (短确认继承上任务) ═══');
T(() => {
  const msgs = [{ role: 'user', content: '消化 /Users/you/Desktop/course-source 全部资料' }, { role: 'assistant', content: '已完成 3/7。可继续拍: 剩余 4 块' }];
  return aa.resolveTaskInput('继续', msgs).includes('消化 /Users/you/Desktop/course-source');
}, '', true, '继续 → 继承原任务');
T(() => aa.resolveTaskInput('消化 /Users/you/Desktop/course-source 三命通会', []) === '消化 /Users/you/Desktop/course-source 三命通会', '', true, '新任务原样通过');

console.log('═══ 13. 外部 agent 痕迹零容忍 (2026-09-13 老板拍: 盘古完全独立, cd65f21 回归锁) ═══');
// 老板截图实案: 设置页工具箱曾挂 codex_delegate/review/resume/doctor 四个外部 agent 桥接工具。
// cd65f21 已删, 此节锁死: 工具注册表/角色映射/全局规则/system prompt 永远不许再出现外部 agent 工具名。
// 注意: 安全拦截规则 (bash_denylist 里 rm -rf ~/.openclaw 这类) 与历史档案 (docs/报告) 不在此列。
{
  const EXTERNAL_RE = /codex_delegate|codex_review|codex_resume|codex_doctor|openclaw_delegate|claudecode_delegate/i;
  const ts = M('tools_schema');
  const schemaNames = Object.keys(ts.TOOLS_SCHEMA || {});
  const badSchema = schemaNames.filter(n => EXTERNAL_RE.test(n));
  T(() => badSchema.length === 0, '', true, 'tools_schema 零外部 agent 工具 (实查 ' + schemaNames.length + ' 个, 残留 ' + badSchema.length + ')');
  const { TOOLS } = M('tools/index.js');
  const implNames = Object.keys(TOOLS || {});
  const badImpl = implNames.filter(n => EXTERNAL_RE.test(n));
  T(() => badImpl.length === 0, '', true, 'tools 实现注册表零外部 agent 工具 (实查 ' + implNames.length + ' 个, 残留 ' + badImpl.length + ')');
  // system prompt / 全局规则正文不许召集外部 agent (codex/openclaw/claude code/hermes/marvis)
  const fs = require('fs');
  const gar = fs.readFileSync(require('path').join(__dirname, '..', 'modules', 'global_agent_rules.js'), 'utf8');
  T(() => !/MULTI_AGENT_SOP|召集.{0,12}(Codex|Claude|Hermes|Marvis)/i.test(gar), '', true, '全局规则零召集外部 agent SOP');
}

console.log('');
console.log('═══ 审计结果: ' + pass + ' 过 / ' + fail + ' 挂 ═══');

// 2026-09-14 (老板拍 #10: 自愈页接每日审计栏): 每次跑都落状态文件 —
// 每日定时任务 (automation_418b36a6, 05:43) 和手动跑共用同一出口,
// 设置页「自愈」的每日审计栏从这里读。成功也记 — 没记录不等于健康。
try {
  const _fs2 = require('fs');
  const _os = require('os');
  const _stateDir = require('path').join(process.env.PANGU_HOME || require('path').join(_os.homedir(), '.pangu'), 'state', 'self_repair');
  _fs2.mkdirSync(_stateDir, { recursive: true });
  _fs2.writeFileSync(require('path').join(_stateDir, 'guard_audit_last.json'), JSON.stringify({
    ts: new Date().toISOString(), pass, fail,
    cases: pass + fail,
    failures: failures.slice(0, 20),
  }, null, 2));
} catch (_) { /* 状态落盘失败不影响审计结论 */ }

if (failures.length) {
  console.log('挂账明细:');
  failures.forEach(f => console.log('  ✗ [' + f.note + '] 期望' + (f.want ? '杀' : '放') + ' 实际' + f.got + ' | ' + f.text));
  process.exit(1);
}
