#!/bin/bash
# 测试沙箱 —— 把所有状态目录导到一次性临时目录, 测试一律不许碰生产数据。
#
# 为什么需要它 (2026-10-15 当场撞出来的, 不是洁癖):
#   session_store 的读取是 "AgentDB 优先, JSON 兜底", 而 AgentDB 认的是
#   PANGU_AGENTDB_DIR, **不受 PANGU_SESSIONS_DIR 管**。于是只重定向 SESSIONS_DIR 的测试:
#     - 读的时候打到生产库, 撞上同名旧 session, 拿到陈旧数据 (force-compact 那次读到 4 条
#       而不是刚写的 17 条, ratio 报 1.00, 压了个寂寞);
#     - 写的时候往生产库塞垃圾。实测跑完全量测试, 生产 AgentDB 里多出 bench-big /
#       r24-* / roletest / self_correct_* / fc-inline-* 等几十条测试 session 和它们的假消息。
#
#   这不是某一个测试的毛病 —— 123 条命令的链里每个测试进程各自为政,
#   谁忘了重定向谁就漏。所以沙箱做在**链的外层**, 而不是一个个测试里补。
#
# 已在链里的少数测试 (agentdb / guard_e2e / r39-backfill / session-store-runtime-env /
# sub-session-persist) 自己设了更精确的子目录, 会覆盖这里 —— 互不干扰。

set -uo pipefail

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/pangu-test-sandbox.XXXXXX")"
export PANGU_AGENTDB_DIR="$SANDBOX/agentdb"
export PANGU_SESSIONS_DIR="$SANDBOX/sessions"
export PANGU_BUDGET_DIR="$SANDBOX/budget"
export PANGU_CHECKPOINT_DIR="$SANDBOX/checkpoints"
export PANGU_OUTCOMES_DIR="$SANDBOX/outcomes"
export PANGU_PLAN_DIR="$SANDBOX/plans"
export PANGU_TASK_DIR="$SANDBOX/tasks"
export PANGU_HANDOFF_DIR="$SANDBOX/handoff"
# 2026-10-26 第 100 批: 进化账本 (L1 dogfooding) 也要导走。
# 之前漏了它 ⇒ 链里每个跑 agent 循环的测试都往**生产** ~/.pangu/evolution 写记录。
# 实测污染 (2026-10-25 账本): 579 条里 356 条"真失败"全是测试会话,
# 成功的那批也全是测试会话 —— 生产账本里一条真实用户会话都没有。
# 污染链: 失败率虚高 → 看门狗误报 → 修复跑批器拿日志当源码去问模型
#          → 45K token/次的本地 GPU 空转 (实测累计启动 10002 次, success=0)。
export PANGU_EVO_DIR="$SANDBOX/evolution"
# 2026-10-26 第 100 批: 还有三个 state 子目录没导走, 每跑一次链就往生产写一批测试产物。
# 实测 (跑链窗口内 diff 生产 ~/.pangu): 104 个文件进了生产 ——
#   state/harness/runs  72 个  (r24-chain-exhaust / j2-gate-behavior 等测试会话)
#   state/ledger        31 个  (roletest / test-delivery-* / wcmd-*)
#   state/compaction     5 个  (unit-compact-*)
#   外加 ~/.pangu/alignment-blocked.jsonl
# 解析规则见 modules/state_paths.js (专用开关 > PANGU_HOME > 生产默认)。
export PANGU_LEDGER_DIR="$SANDBOX/ledger"
export PANGU_COMPACTION_DIR="$SANDBOX/compaction"
export PANGU_RUN_TRACE_DIR="$SANDBOX/harness-runs"
export PANGU_ALIGNMENT_AUDIT_FILE="$SANDBOX/alignment-blocked.jsonl"
export PANGU_HARNESS_DIR="$SANDBOX/harness"
# 2026-10-26 第 101 批: **模型上下文缓存** (models-registry.json) 也要导走。
# modules/model_registry.js 认 PANGU_REGISTRY_PATH (专用开关 > 生产默认),
# 但沙箱之前没导 ⇒ 链里三个测试 (stream-prefill-budget /
# stream-reasoning-not-content / synthesis-stream-idle) 把测试条目直接写进
# **生产** ~/.pangu/models-registry.json —— 生产模型层里至今躺着
# fake-prefill / fake-synth / fake-reason / probe-local 这些测试残留。
#
# 先把生产那份**复制**一份当种子: 读方看到的还是同一批数据 (测试结论不变),
# 写方落在沙箱里, 生产不脏。
if [ -f "$HOME/.pangu/models-registry.json" ]; then
  cp "$HOME/.pangu/models-registry.json" "$SANDBOX/models-registry.json"
else
  : > "$SANDBOX/models-registry.json"
fi
export PANGU_REGISTRY_PATH="$SANDBOX/models-registry.json"
mkdir -p "$PANGU_AGENTDB_DIR" "$PANGU_SESSIONS_DIR" "$PANGU_BUDGET_DIR" \
         "$PANGU_EVO_DIR" "$PANGU_LEDGER_DIR" "$PANGU_COMPACTION_DIR" \
         "$PANGU_RUN_TRACE_DIR" "$PANGU_HARNESS_DIR" "$PANGU_OUTCOMES_DIR" \
         "$PANGU_CHECKPOINT_DIR" "$PANGU_PLAN_DIR" "$PANGU_TASK_DIR" "$PANGU_HANDOFF_DIR"

cleanup() {
  # 产物留着不删: 万一某个测试的行为需要复现时还能翻。手动清就删这个前缀的目录。
  echo ""
  echo "[sandbox] 产物留在: $SANDBOX"
}
trap cleanup EXIT

echo "[sandbox] 生产状态目录已隔离, 沙箱: $SANDBOX"
echo "[sandbox]   AgentDB  -> $PANGU_AGENTDB_DIR"
echo "[sandbox]   sessions -> $PANGU_SESSIONS_DIR"
echo ""

cd "$(dirname "$0")/.."
npm run test:chain
CHAIN_EXIT=$?

# ── 变异体检的残留检查 (2026-10-26 立) ──────────────────────────
#
# 变异守卫的做法是「把源码原地改成旧行为 ⇒ 守卫报红 ⇒ 改回来」。
# 如果进程被 kill / 崩了 / 两条链并行跑, 源码可能**留在变异状态** ——
# 那等于把「旧行为」直接写进生产代码, 而且没人知道 (git status 看得到, 但没人会去对)。
#
# 实测踩到过: model_capability.js 的软默认门卫被删掉留在工作区,
# 云端端点又吃本地软默认, 而超时走云端口径 ⇒ 同一模型两个口径。
#
# 所以链跑完必须检查: 有没有残留的变异备份 (有 ⇒ 源码可能是变异版)。
STALE_MUT=""
for f in *.pangu-mut-backup* modules/*.pangu-mut-backup* \
         pangu-single/*.pangu-mut-backup* pangu-single/routes/*.pangu-mut-backup* \
         tests/*.pangu-mut-backup* tests/helpers/*.pangu-mut-backup*; do
  [ -e "$f" ] && STALE_MUT="$STALE_MUT $f"
done
if [ -n "$STALE_MUT" ]; then
  echo ""
  echo "[sandbox] ⚠️ 有残留的变异备份:$STALE_MUT"
  echo "[sandbox]    这些源码可能是**变异版**(旧行为被写进了生产代码)。"
  echo "[sandbox]    下一轮守卫启动时会自动还原, 但现在就该看一眼 git diff。"
  exit 1
fi
exit $CHAIN_EXIT

