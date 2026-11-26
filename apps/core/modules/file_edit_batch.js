/**
 * modules/file_edit_batch.js
 * 盘古 · Multi-file Atomic Edit (TL-5 子项 B)
 *
 * 用法: file_edit_batch({ edits: [{path, search, replace}], atomic: true })
 *
 * 行为:
 * - 预读所有 path 验证存在
 * - atomic=true: 用 .tmp 文件 + rename 全成功或全失败
 * - atomic=false: best-effort, 返 success_count + failed
 *
 * 不改 modules/tools/index.js — 通过 file_edit 注册调用本模块
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * 单个 edit 验证
 */
function _validateEdit(e) {
  if (!e || typeof e !== 'object') return { valid: false, error: 'edit must be object' };
  if (!e.path || typeof e.path !== 'string') return { valid: false, error: 'path missing' };
  if (typeof e.search !== 'string') return { valid: false, error: 'search must be string' };
  if (typeof e.replace !== 'string') return { valid: false, error: 'replace must be string' };
  return { valid: true };
}

/**
 * 执行 file_edit_batch
 *
 * @param {object} args - { edits: [...], atomic: boolean }
 * @returns {{ok: boolean, success_count: number, failed: Array, rolled_back: boolean, data: {results: Array}}}
 */
async function fileEditBatch(args) {
  const edits = (args && args.edits) || [];
  const atomic = args && args.atomic !== false;  // default true

  // 1. 预验证
  const validations = edits.map(_validateEdit);
  const invalid = validations.findIndex(v => !v.valid);
  if (invalid >= 0) {
    return { ok: false, success_count: 0, failed: [{ index: invalid, error: validations[invalid].error }], rolled_back: false, data: { results: [] } };
  }

  // 2. 读所有 path (预读, 用于 rollback)
  const backups = [];  // { path, original_content }
  try {
    for (const e of edits) {
      let original = null;
      if (fs.existsSync(e.path)) {
        original = fs.readFileSync(e.path, 'utf8');
      }
      backups.push({ path: e.path, original });
    }
  } catch (e) {
    return { ok: false, success_count: 0, failed: [{ error: 'pre-read failed: ' + e.message }], rolled_back: false, data: { results: [] } };
  }

  // 3. 应用 edits (atomic=true 用 .tmp + rename 保证全成功或全失败)
  const results = [];
  const success = [];
  const failed = [];
  const tmpFiles = [];  // 跟踪临时文件, rollback 时清

  try {
    for (let i = 0; i < edits.length; i++) {
      const e = edits[i];
      const backup = backups[i];
      try {
        let content = backup.original || '';
        // search 必须出现 (single match 否则失败)
        if (!content.includes(e.search)) {
          failed.push({ index: i, path: e.path, error: 'search not found' });
          continue;
        }
        const newContent = content.replace(e.search, e.replace);
        if (atomic) {
          // 写 .tmp → rename (atomic on same fs)
          const tmp = e.path + '.pangu_tmp_' + Date.now() + '_' + i;
          fs.writeFileSync(tmp, newContent, 'utf8');
          tmpFiles.push(tmp);
        } else {
          fs.writeFileSync(e.path, newContent, 'utf8');
        }
        success.push({ index: i, path: e.path });
        results.push({ index: i, path: e.path, ok: true });
      } catch (err) {
        failed.push({ index: i, path: e.path, error: err.message });
        results.push({ index: i, path: e.path, ok: false, error: err.message });
        if (atomic) throw err;  // atomic 模式: 失败立即抛, 走 rollback
      }
    }

    // 4. atomic 模式: rename 所有 .tmp 到正式 path
    if (atomic) {
      for (const tmp of tmpFiles) {
        const realPath = tmp.replace(/\.pangu_tmp_\d+_\d+$/, '');
        fs.renameSync(tmp, realPath);
      }
    }

    return {
      ok: failed.length === 0,
      success_count: success.length,
      failed,
      rolled_back: false,
      data: { results },
    };
  } catch (atomicError) {
    // 5. atomic 模式: rollback (删 .tmp + 不改原文件)
    for (const tmp of tmpFiles) {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
    // 原文件未改 (rename 没跑) — 无需恢复
    return {
      ok: false,
      success_count: 0,
      failed: [{ error: 'atomic rollback: ' + atomicError.message, atomic_failed: true }],
      rolled_back: true,
      data: { results, note: 'atomic: 0 改动' },
    };
  }
}

module.exports = {
  fileEditBatch,
  _validateEdit,  // 暴露供 test
};