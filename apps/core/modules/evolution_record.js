// modules/evolution_record.js — N5 refactor batch B4-Phase 3
// L1 dogfooding 落盘 — 每次 agent stream 结束写一行到 ~/.pangu/evolution/{date}.jsonl
// 依赖: 零外部 — 用 os/fs/path 内置模块

const os = require('os');
const fs = require('fs');
const path = require('path');
const { evolutionDir } = require('./evolution_paths');

function _recordEvolution(record) {
  try {
    // 2026-10-26 第 100 批: 遵守代码库统一约定 —— PANGU_HOME 可覆盖。
    //
    // 旧版硬编码 `os.homedir()/.pangu` ⇒ **无视 PANGU_HOME** ⇒
    // 设了 PANGU_HOME(指到临时目录) 的测试, 照样把记录写进**生产**账本。
    // 污染是实打实的 (2026-10-25 账本实测): 579 条里 356 条"真失败"、
    // 成功的那批也全是测试会话 (j2-gate-behavior / reread-probe / probe*) ——
    // 生产账本里**一条真实用户会话都没有**。
    // 后果链: 失败率虚高 → 看门狗报警 → 修复跑批器拿日志当源码去问模型
    // → 45K token/次的本地 GPU 空转 (实测累计 10002 次启动, success=0)。
    //
    // ⚠️ 必须在**调用时**解析 (不能提到模块顶层): 测试常在 require 之后才设环境变量。
    //
    // 解析规则收在 modules/evolution_paths.js (唯一真源) —— 读方 (self-evolution /
    // smart_router / llm_caller / inline_router / pangu-meta / l2-miner /
    // repair-watcher) 全都走它。写方和读方各写一份解析 = 迟早读写分裂。
    const evoDir = evolutionDir();
    if (!fs.existsSync(evoDir)) fs.mkdirSync(evoDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const evoFile = path.join(evoDir, today + '.jsonl');
    // 防御:确保所有字段类型安全
    const { classifyRuntimeVerdict } = require('./runtime_verdict');
    //
    // 2026-10-15 (现场实证, 不是推断 —— 账本里读出来的):
    //   input  "只回一个词: 盘古"  →  final_text "盘古" (完全正确的交付)
    //                               →  runtime_status "failed", success false
    // 根因: execution_succeeded 传的是 record.success, 而 record.success 的含义是
    // "本轮有没有 task_done 收口", **不是**"这一轮有没有跑成功"。两个概念混在一起,
    // 于是每一个没调 task_done 的正常轮次都被当成执行失败 —— 聊天 / 直答 / 短答全中。
    // 而 runtime_verdict 的 conversational 那道门恰好 `&& executionSucceeded`,
    // 于是短答判定在这里被整个抹掉, 正确答复在账本里变成假失败。
    // 这条假失败会继续喂给 L1 统计 → L2 提示 → L3 权重, 是会自我放大的。
    //
    // 正确语义: 执行层有没有**硬失败** (真报错, 且一个字都没产出)。
    // 有实质 final_text 就说明执行层跑完了; 没有文本又确实报错, 才是真失败。
    // 注意这不影响 2026-09-09 那条"0 工具 + 1 轮不许判 success"的防污染规则 ——
    // success/completed 由 task_done_accepted 单独把关, 与这个字段无关。
    const _hasRealText = String(record.final_text || '').trim().length > 0;
    const _hardError = !!record.error;
    const verdict = classifyRuntimeVerdict({
      real_tool_calls_total: record.real_tool_calls_total,
      tools_used: record.tool_names,
      final_text: record.final_text,
      alignment_blocked: record.runtime_status === 'failed' && record.success === false,
      task_done_status: record.task_done_status,
      task_done_accepted: record.task_done_accepted,
      execution_succeeded: _hasRealText || !_hardError,
      // 2026-10-15: 进化账本是对同一轮重新判分, 不是第二次评判。
      // 不给 user_input 的话, 主 agent 判成 partial 的短答, 到这里会被打回 failed,
      // 于是进化闭环记下一笔并不存在的失败。
      user_input: record.input,
    });
    const safeRecord = {
      ts: record.ts || new Date().toISOString(),
      endpoint: String(record.endpoint || '/unknown'),
      input: String(record.input || '').slice(0, 500),
      provider: String(record.provider || 'unknown'),
      model: String(record.model || 'unknown'),
      tool_calls_total: Number(record.tool_calls_total) || 0,
      tool_names: Array.isArray(record.tool_names) ? record.tool_names : [],
      tool_args: Array.isArray(record.tool_args) ? record.tool_args.slice(0, 20) : [],
      session_id: String(record.session_id || ''),
      mode: String(record.mode || ''),
      image_count: Number(record.image_count) || 0,
      total_chars: Number(record.total_chars) || 0,
      rounds: Number(record.rounds) || 0,
      success: verdict.success,
      // Caller-provided status may be stale; persist the single computed verdict.
      runtime_status: verdict.status,
      real_tool_calls_total: Number(record.real_tool_calls_total) || 0,
      // 2026-09-09 修 #2 假成功污染双保险: 即使 j2 主判定漏判,记录层也标记
      // 规则: 0 工具调用 + success=true → 强制改为 false (L1 数据立刻干净)
      // 真凭实据: L1 2026-09-08.jsonl 5 条污染样本 (15:04/15:06/21:43/22:25/22:57) tool_calls_total=0 但 success=true
      effective_success: verdict.success,
      duration_ms: Number(record.duration_ms) || 0,
      error: record.error || null,
      final_text: String(record.final_text || '')
        .replace(/<think>[\s\S]*?<\/think>\s*/gi, '')
        .replace(/<think>[\s\S]*$/gi, '')
        .trim().slice(0, 1000)
    };
    fs.appendFileSync(evoFile, JSON.stringify(safeRecord) + '\n');
  } catch(e) {
    // 静默失败, 不污染 /tmp
  }
}

module.exports = { _recordEvolution };
