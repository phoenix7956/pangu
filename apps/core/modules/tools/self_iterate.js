/**
 * modules/tools/self_iterate.js
 * 盘古 · 自我迭代 (老板 2026-08-02 拍: "我需要盘古可以自我修改代码，自我迭代")
 *
 * 完整闭环: 改代码 (file_edit/write_file) → self_iterate → 语法验证 → git 快照提交
 *   → 延迟重启 (让当前 SSE 回完) → 看门狗健康检查 → 挂了就自动 revert 本次提交再重启
 *
 * 安全哲学 (老板): 不拦能力, 拦灾难 — 全自动, 但每一步都可逆:
 *   - 改完自动 commit (工作区永不丢)
 *   - 看门狗脚本写在 /tmp (repo 外, git revert 不会把自己抹掉)
 *   - 健康检查不过 → 自动 revert 本次提交 → 再重启 → 结果落 /tmp/pangu-self-iterate-result.json
 *
 * (首测标记: 2026-08-02 盘古自我迭代闭环首测通过标记)
 * action:
 *   apply  (默认) — 验证+提交+重启+看门狗
 *   status — 查上次迭代结果 (重启后盘古自己调这个闭环: "我上次改的活没活")
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawn } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');
const RESULT_FILE = '/tmp/pangu-self-iterate-result.json';
const LOCK_FILE = '/tmp/pangu-self-iterate.lock';
const HEALTH_URL = process.env.PANGU_HEALTH_URL || 'http://127.0.0.1:18901/health';
const LAUNCHD_LABEL = 'local.pangu-single';

function _git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// porcelain 状态不能整体 trim — 会吃掉首行 XY 状态列的前导空格 (首测实案: " M apps/..." → "M apps/...", slice(3) 错位)
function _gitStatus() {
  return execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\n+$/, '');
}

function _changedFiles(status) {
  return status.split('\n').filter(Boolean).map(line => line.slice(3).trim());
}

function _readResult() {
  try { return JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8')); } catch (_) { return null; }
}

async function selfIterate(args = {}) {
  const action = args.action || 'apply';

  if (action === 'status') {
    const r = _readResult();
    if (!r) return { ok: true, result: { last: null, message: '没有自我迭代记录 (还没迭代过, 或结果文件被清)' } };
    return { ok: true, result: { last: r } };
  }

  const note = String(args.note || '').trim();
  const restartOnly = !!args.restart_only;
  const requestedFiles = Array.isArray(args.files) ? args.files.map(String).filter(Boolean) : [];
  if (!restartOnly && !note) {
    return { ok: false, error: { code: 'NO_NOTE', message: 'note 必填 — 用一句话说清这次迭代改了什么/为什么 (会进 commit message 和结果文件)' } };
  }
  const delayS = Math.min(Math.max(parseInt(args.delay_s, 10) || 3, 2), 30);
  const healthTimeoutS = Math.min(Math.max(parseInt(args.health_timeout_s, 10) || 90, 20), 300);

  // 并发锁: 上一个迭代看门狗还在跑就不许再点火 (锁 >10 分钟视为 stale 自动清)
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const lockAge = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
      if (lockAge < 10 * 60 * 1000) {
        return { ok: false, error: { code: 'ITERATE_IN_PROGRESS', message: '上一次自我迭代的看门狗还在跑 (锁 ' + Math.round(lockAge / 1000) + 's 前点的火), 等它出结果后再试; 或调 self_iterate {action:"status"} 看结果' } };
      }
      fs.unlinkSync(LOCK_FILE);
    }
  } catch (_) {}

  // 1) 工作区状态
  const status = _gitStatus();
  if (!status && !restartOnly) {
    return { ok: false, error: { code: 'NOTHING_TO_ITERATE', message: '工作区干净, 没有改动可迭代。先用 file_edit/write_file 改代码, 再调 self_iterate。只想重启: {restart_only:true}' } };
  }

  const changedFiles = _changedFiles(status);
  if (!restartOnly && requestedFiles.length > 0) {
    const requested = new Set(requestedFiles);
    const unexpected = changedFiles.filter(file => !requested.has(file));
    if (unexpected.length > 0) {
      return { ok: false, error: { code: 'UNRELATED_WORKTREE_CHANGES', message: '自我迭代拒绝提交不属于本提案的改动: ' + unexpected.join(', ') } };
    }
    const missing = requestedFiles.filter(file => !changedFiles.includes(file));
    if (missing.length > 0) {
      return { ok: false, error: { code: 'PATCH_NOT_DETECTED', message: '预期补丁没有出现在工作区: ' + missing.join(', ') } };
    }
  }

  // 2) 语法验证: 所有改动的 .js 过 node --check (炸在这里 = 不提交不重启, 零风险)
  const changedJs = changedFiles
    .filter(f => f.endsWith('.js') && !f.startsWith('node_modules/') && fs.existsSync(path.join(REPO_ROOT, f)));
  const syntaxErrors = [];
  for (const f of changedJs) {
    try {
      execFileSync(process.execPath, ['--check', path.join(REPO_ROOT, f)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      syntaxErrors.push(f + ': ' + String(e.stderr || e.message).slice(0, 300));
    }
  }
  if (syntaxErrors.length > 0) {
    return { ok: false, error: { code: 'SYNTAX_CHECK_FAILED', message: 'node --check 没过, 已拦下 (没提交没重启)。先修语法:\n' + syntaxErrors.join('\n') } };
  }

  // 3) git 快照: prev = 回滚目标, new = 本次迭代 commit
  const prevSha = _git(['rev-parse', 'HEAD']);
  let newSha = prevSha;
  if (!restartOnly) {
    _git(requestedFiles.length > 0 ? ['add', '--', ...requestedFiles] : ['add', '-A']);
    _git(['commit', '-m', 'self-iterate: ' + note.slice(0, 200)]);
    newSha = _git(['rev-parse', 'HEAD']);
  }

  // 4) 看门狗脚本写 /tmp (repo 外 — git reset --hard 抹不掉它)
  const ts = Date.now();
  const scriptPath = '/tmp/pangu-self-heal-' + ts + '.sh';
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
  // 结果 JSON 在 Node 侧预生成 (note/sha 都是已知值, 只剩 ts/health 是运行时值)
  // — 不在 bash 里搞多层转义 (之前那版 printf+python3 嵌套引号太脆)
  const _resultBase = { note, new_sha: newSha, prev_sha: prevSha, restarted: true };
  const okJson = JSON.stringify({ ..._resultBase, ts: '__TS__', healthy: true, rolled_back: false }, null, 2);
  const rbJson = JSON.stringify({ ..._resultBase, ts: '__TS__', healthy: false, rolled_back: true, rollback_healthy: true }, null, 2)
    .replace('"rollback_healthy": true', '"rollback_healthy": __RB__');
  const revertFailedJson = JSON.stringify({ ..._resultBase, ts: '__TS__', healthy: false, rolled_back: false, rollback_healthy: false, rollback_error: 'git revert failed; manual resolution required' }, null, 2);
  const okJsonFile = scriptPath + '.ok.json';
  const rbJsonFile = scriptPath + '.rb.json';
  const revertFailedJsonFile = scriptPath + '.revert-failed.json';
  fs.writeFileSync(okJsonFile, okJson);
  fs.writeFileSync(rbJsonFile, rbJson);
  fs.writeFileSync(revertFailedJsonFile, revertFailedJson);
  const script = [
    '#!/bin/bash',
    '# 盘古自我迭代看门狗 (self_iterate 生成, ' + new Date(ts).toISOString() + ')',
    'PREV_SHA="' + prevSha + '"',
    'NEW_SHA="' + newSha + '"',
    'REPO="' + REPO_ROOT + '"',
    'RESULT="' + RESULT_FILE + '"',
    'LOCK="' + LOCK_FILE + '"',
    'HEALTH="' + HEALTH_URL + '"',
    'LABEL="' + LAUNCHD_LABEL + '"',
    'touch "$LOCK"',
    'sleep ' + delayS,
    'launchctl kickstart -k gui/' + uid + '/"$LABEL"',
    '_poll() { local limit=$1; local waited=0; while [ $waited -lt $limit ]; do code=$(curl -s -o /dev/null -w "%{http_code}" -m 5 "$HEALTH" 2>/dev/null); if [ "$code" = "200" ]; then return 0; fi; sleep 2; waited=$((waited+2)); done; return 1; }',
    'sleep 3',
    'if _poll ' + healthTimeoutS + '; then',
    '  sed "s/__TS__/$(date -u +%Y-%m-%dT%H:%M:%SZ)/" "' + okJsonFile + '" > "$RESULT"',
    '  rm -f "$LOCK"; exit 0',
    'fi',
    '# 健康检查失败 → 仅反向提交本次迭代，保留其他工作区修改 → 再重启 → 再查',
    'if ! (cd "$REPO" && git revert --no-edit "$NEW_SHA"); then',
    '  sed "s/__TS__/$(date -u +%Y-%m-%dT%H:%M:%SZ)/" "' + revertFailedJsonFile + '" > "$RESULT"',
    '  rm -f "$LOCK"; exit 1',
    'fi',
    'launchctl kickstart -k gui/' + uid + '/"$LABEL"',
    'sleep 3',
    'if _poll 60; then RB_HEALTHY=true; else RB_HEALTHY=false; fi',
    'sed -e "s/__TS__/$(date -u +%Y-%m-%dT%H:%M:%SZ)/" -e "s/__RB__/$RB_HEALTHY/" "' + rbJsonFile + '" > "$RESULT"',
    'rm -f "$LOCK"',
  ].join('\n');
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  // 5) detached 点火 (看门狗必须活过 daemon 自己的死亡)
  const logPath = '/tmp/pangu-self-heal-' + ts + '.log';
  const child = spawn('/bin/bash', [scriptPath], {
    detached: true,
    stdio: ['ignore', fs.openSync(logPath, 'a'), fs.openSync(logPath, 'a')],
  });
  child.unref();

  console.log('[self-iterate] fired. note="' + note.slice(0, 80) + '" new=' + newSha.slice(0, 8) + ' prev=' + prevSha.slice(0, 8) + ' restart in ' + delayS + 's, watchdog=' + scriptPath);
  return {
    ok: true,
    result: {
      committed: newSha,
      rollback_target: prevSha,
      syntax_checked: changedJs,
      restart_in_s: delayS,
      healthy_check: HEALTH_URL,
      watchdog_log: logPath,
      message: '已提交 ' + newSha.slice(0, 8) + ' (语法验证过 ' + changedJs.length + ' 个 js), ' + delayS + ' 秒后自动重启, 看门狗 ' + healthTimeoutS + 's 内健康检查不过就自动回滚到 ' + prevSha.slice(0, 8) + '。本轮回复发完连接会断 — 重启后调 self_iterate {action:"status"} 确认迭代结果, 再向老板汇报。',
    },
  };
}

module.exports = { selfIterate };
