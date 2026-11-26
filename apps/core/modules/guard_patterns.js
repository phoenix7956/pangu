// guard_patterns.js — 盘古全部守卫判定模式单一真源 (2026-09-14 老板拍: 全审计, 不做假)
// 此前守卫正则散落在 j2_agent_loop.js 内联闭包里 — 不可单测, 误杀只能靠老板撞见。
// 全部抽到本模块: 每个守卫 = 命名导出 + 审计矩阵 (tests/guard_audit.js) 里"该杀/不该杀"用例。

// ── task_done 验收 ─────────────────────────────────────────────
// OVERCLAIM: summary 全集断言 ("全部消化完") 但账本只有部分 → 拒收逼改实数
const OVERCLAIM_RE = /全部(消化|完成|排查|提取)|所有(消化|完成|排查|提取)|(?:都|已|全)(?:部)?(?:消化|排查|盘点)完|(?:消化|排查|盘点)(?:已完成|完毕|都完成)/;

// LIP_SERVICE: 全程 0 真工具 + 计划/承诺型 summary → 拒收 task_done
// LIP_SERVICE: 全程 0 真工具 + 计划/承诺型 summary → 拒收 task_done
// 2026-09-14 审计修: 原正则整组要求紧跟半角冒号 → "收到，我这就开盘" 这类主流话术全漏网。
// 冒号改可选 ([:：]?)。
const LIP_SERVICE_SUMMARY_RE = /(收到[，,。.！!]|(^|[^一-鿿])开盘|直接开盘|开做|开读|扫一?眼|定个顺序|我这就|这就去|现在直接|先(?:列出|挑|看|读|查|扫|定个)|先.{0,14}再.{0,10}(?:读|看|查|做|开做)|接下来.{0,8}(?:读|看|查|做|调|继续))[:：]?/;
const isLipServiceText = (t) => !!t && String(t).trim().length >= 30 && LIP_SERVICE_SUMMARY_RE.test(String(t).trim());

// ── 0 工具断言类 (反幻觉) ──────────────────────────────────────
// UNVERIFIED_CLAIM: 0 工具 + 系统状态断言 (沙箱/权限/不存在/未安装/连不上) → nudge 逼举证
const UNVERIFIED_CLAIM_RE = /(沙箱|权限不足|没有权限|无权限|权限.{0,4}(开|关|禁|限制)|文件不存在|目录不存在|没有安装|未安装|连不上|无法连接|不支持流式|0\s*个\s*MCP|没有\s*MCP)/;

// FAKE_OUTPUT: 0 写工具 + 产出/改码声称 → nudge 逼真做+举证
const WRITE_TOOLS = ['write_file', 'draw_layout', 'file_edit', 'file_edit_batch', 'exec_command', 'code_execute', 'self_iterate', 'git_commit'];
const FAKE_OUT_RE = /(已(经)?(出|生成|画好|写好|保存|存好|落盘|写入|复制到|交付)(了|好|完成)?(图|文件|SVG|DXF|FCStd|svg|dxf|FCSTD)?|文件.{0,8}(已|已经)(生成|写入|保存|落盘|就位)|\d+(\.\d+)?\s*(KB|MB|字节).{0,12}(已|验|存|写|真)|(落盘|写入|产出|交付)\s*[:：])/;
const FAKE_EDIT_RE = /(已(经)?(修改|改完|改好|修复|实装|挂载|接入|替换|重构|优化)(了|成|到)?|(改完|改好|修完|修好)了?[^—]{0,30}|(代码|补丁).{0,6}(已|已经)(改|修|打|提))/;

// FAKE_TOOLCALL: 模型把 "(调用工具: x)" 写成正文文字而不是真 tool_call
const FAKE_TC_TEXT_RE = /^[（(【\[]?\s*调用工具\s*[:：]/;

// ── 续跑确认 (体量预检分支用) ──────────────────────────────────
const RESUME_ACK_RE = /^(对|好|嗯|继续|可以|行|ok|a|b|c)$/i;

// ── 旁白型输出 (调过工具之后仍然只说"打算怎么做") ────────────────
//
// 现场 2026-10-23 b63-guagate (main 角色, 真实用户轮):
//   模型调完 bazi_calc + risk_assessment 之后说 ——
//     「主人给了生辰, 这是「长期状态 + 此刻时机」两层题。我先把八字盘排出来, 再给今天这个动作起一卦定方向。」
//   下一轮**原样又说一遍**, 0 工具调用 → 这一句被当最终答复 → 答复门拦下 →
//   用户拿到 ⚠️ 模板 (不是答案)。
//
// 为什么既有三道闸门都没接住 (机制层, 不是"模型笨"):
//   ① 0 工具的 lip-service 守门要求 toolsUsed.length === 0 —— "调过工具再嘴说"根本没人管
//   ② R80 LIP_SERVICE_AFTER_TOOLS 那道闸门写在 finalText=textContent; break; **之后** → 永远够不到
//   ③ 复读检测要求 length > 200 —— 这句 51 字, 够不到
//
// 这里补的是**结构信号**而不是词表:
//   · PROMISE_SEQUENCE_RE —— 「先…再…」两段式承诺 (我先 X 排出来, 再 Y 起一卦)
//   · LIP_SERVICE_AFTER_TOOLS_RE —— 「我先/我会/接下来」开头且带后续动作词的承诺句
// 词表永远补不齐 (见踩坑日志「词表只能靠抓真实语料长」), 所以另一条腿是**复读检测**:
//   同一句"打算"说第二遍 = 卡住, 不是结论 —— 见 j2_agent_loop 里的 _isRepeatOfEarlier。

// 「先…再…」两段式承诺。逗号可有可无 ("先排出来再起卦" / "先排出来, 再起卦")。
const PROMISE_SEQUENCE_RE = /先[^。！？!?\n]{1,18}[,，、]?\s*再[^。！？!?\n]{1,18}/;

// 「我先/我会/我来/接下来」+ 后续动作 —— 典型旁白。
const LIP_SERVICE_AFTER_TOOLS_RE = /(?:我先|我会|我来|接下来我|让我先|先(?:调|查|看|读|排|算|做|起|拉|发|摸))[^。！？!?\n]{0,20}?(?:再|然后|接着|就去|就调|就查|就排|就起)/;

// 文本是不是"旁白/承诺"型 (不是结论)。
// 长度门槛沿用 isLipServiceText 的口径: 太短的一句话 (例: "收到") 不算旁白。
const isNarrationText = (t) => {
  const s = String(t || '').trim();
  if (s.length < 12) return false;
  return PROMISE_SEQUENCE_RE.test(s) || LIP_SERVICE_AFTER_TOOLS_RE.test(s);
};

module.exports = {
  OVERCLAIM_RE, LIP_SERVICE_SUMMARY_RE, isLipServiceText,
  UNVERIFIED_CLAIM_RE, WRITE_TOOLS, FAKE_OUT_RE, FAKE_EDIT_RE,
  FAKE_TC_TEXT_RE, RESUME_ACK_RE,
  PROMISE_SEQUENCE_RE, LIP_SERVICE_AFTER_TOOLS_RE, isNarrationText,
};
