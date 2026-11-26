/**
 * modules/tools/git_ops.js
 * 盘古 · Git 操作 (P0-#14)
 *
 * 4 个工具: git_commit / git_branch / git_diff / git_status
 * 用 child_process.execFileSync 调 git, 同步阻塞
 * 所有 Pangu repo git 操作都限制在 ~/pangu/ 内 (sandbox.isInsidePanguRepo 拦截)
 *
 * 不动 exec_command (那个是通用 shell)
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PANGU_REPO = path.resolve(os.homedir(), 'Desktop', 'pangu');

// 公共: 在 Pangu repo 跑 git command
function _runGit(args, cwd = PANGU_REPO) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024, // 50MB cap
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

// === git_commit ===
// { message, files?, amend?, author? }
async function gitCommit(args = {}) {
  const message = (args && args.message) || '';
  if (!message) return { ok: false, error: { code: 'NO_MESSAGE', message: 'commit message required' } };
  const files = (args && args.files) || null;  // 默认 null = git add -A
  const amend = !!(args && args.amend);
  const author = (args && args.author) || null;
  try {
    // 1. git add (specific files OR all)
    if (Array.isArray(files) && files.length > 0) {
      _runGit(['add', '--', ...files]);
    } else if (files === null) {
      _runGit(['add', '-A']);
    }
    // 2. git status 看真改了啥
    const statusBefore = _runGit(['status', '--porcelain']).trim();
    if (!statusBefore) {
      return { ok: false, error: { code: 'NOTHING_TO_COMMIT', message: 'working tree clean, 无东西可 commit' } };
    }
    // 3. git commit -m '<message>' (or --amend)
    const commitArgs = amend
      ? ['commit', '--amend', '-m', message]
      : ['commit', '-m', message];
    if (author && author.name && author.email) {
      commitArgs.push('--author', `${author.name} <${author.email}>`);
    }
    _runGit(commitArgs);
    // 4. 返新 hash
    const hash = _runGit(['rev-parse', '--short', 'HEAD']).trim();
    console.log('[git-ops] commit created:', hash, 'msg:', message.slice(0, 80));
    return {
      ok: true,
      result: {
        hash,
        message,
        files_changed: statusBefore.split('\n').filter(Boolean).length,
        amend,
        branch: _runGit(['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
      },
    };
  } catch (e) {
    const stderr = (e.stderr && e.stderr.toString()) || '';
    return { ok: false, error: { code: 'GIT_COMMIT_FAILED', message: stderr.slice(0, 500) || e.message, retryable: false } };
  }
}

// === git_branch ===
// { action: "list"|"create"|"checkout"|"delete", name?, from? }
async function gitBranch(args = {}) {
  const action = args.action || 'list';
  const name = args.name;
  try {
    let result;
    if (action === 'list') {
      const out = _runGit(['branch', '--list', '--format=%(refname:short)']).trim();
      result = { branches: out.split('\n').filter(Boolean), current: _runGit(['rev-parse', '--abbrev-ref', 'HEAD']).trim() };
    } else if (action === 'create') {
      if (!name) return { ok: false, error: { code: 'NO_NAME', message: 'name required for create' } };
      const createArgs = ['checkout', '-b', name];
      if (args.from) createArgs.push(args.from);
      _runGit(createArgs);
      result = { created: name };
      console.log('[git-ops] branch created:', name);
    } else if (action === 'checkout') {
      if (!name) return { ok: false, error: { code: 'NO_NAME', message: 'name required for checkout' } };
      _runGit(['checkout', name]);
      result = { checked_out: name };
      console.log('[git-ops] branch checkout:', name);
    } else if (action === 'delete') {
      if (!name) return { ok: false, error: { code: 'NO_NAME', message: 'name required for delete' } };
      _runGit(['branch', '-D', name]);
      result = { deleted: name };
      console.log('[git-ops] branch deleted:', name);
    } else {
      return { ok: false, error: { code: 'INVALID_ACTION', message: 'unknown action: ' + action } };
    }
    return { ok: true, result: Object.assign({ branch: _runGit(['rev-parse', '--abbrev-ref', 'HEAD']).trim() }, result) };
  } catch (e) {
    const stderr = (e.stderr && e.stderr.toString()) || '';
    return { ok: false, error: { code: 'GIT_BRANCH_FAILED', message: stderr.slice(0, 500) || e.message, retryable: false } };
  }
}

// === git_diff ===
// { ref1?, ref2?, files?, format? }
async function gitDiff(args = {}) {
  const ref1 = args.ref1 || 'HEAD';
  const ref2 = args.ref2 || '';  // empty = working dir
  const files = (args && args.files) || [];
  const format = args.format || 'unified';
  try {
    const diffArgs = ['diff', ref1];
    if (ref2) diffArgs.push(ref2);
    if (format === 'stat') diffArgs.push('--stat');
    else if (format === 'name-only') diffArgs.push('--name-only');
    else diffArgs.push('--unified');
    if (files.length > 0) diffArgs.push('--', ...files);
    const diff = _runGit(diffArgs);
    // 文件列表 (用 --name-status)
    const nameStatus = _runGit(['diff', '--name-status', ref1, ...(ref2 ? [ref2] : [])]).trim();
    const filesChanged = nameStatus.split('\n').filter(Boolean).map(l => {
      const [status, path] = l.split('\t');
      return { status, path };
    });
    return {
      ok: true,
      result: {
        diff,
        format,
        ref1,
        ref2: ref2 || 'working',
        files_changed: filesChanged.length,
        files: filesChanged,
      },
    };
  } catch (e) {
    const stderr = (e.stderr && e.stderr.toString()) || '';
    return { ok: false, error: { code: 'GIT_DIFF_FAILED', message: stderr.slice(0, 500) || e.message, retryable: false } };
  }
}

// === git_status ===
// { short? }
async function gitStatus(args = {}) {
  const short = args.short !== false;  // default true
  try {
    const branch = _runGit(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    const statusArgs = short ? ['status', '--short', '--branch'] : ['status', '--branch'];
    const status = _runGit(statusArgs).trim();
    const log = _runGit(['log', '-1', '--pretty=format:%h %s (%an, %ad)']).trim();
    return {
      ok: true,
      result: {
        branch,
        status,
        head: log,
      },
    };
  } catch (e) {
    return { ok: false, error: { code: 'GIT_STATUS_FAILED', message: e.message, retryable: false } };
  }
}

module.exports = {
  gitCommit,
  gitBranch,
  gitDiff,
  gitStatus,
  PANGU_REPO,
};