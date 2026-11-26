// modules/secret_scan.js — 「这串东西是不是密钥」的唯一判据
//
// ── 为什么必须是唯一真源 ──
//   密钥治理有三个地方需要同一个判断:
//     ① 写入端: 保存模型时, 该不该把用户填的 key 转存进凭证库
//     ② 收编端: 扫到落盘配置里的明文 key ⇒ 搬走
//     ③ 守卫端: 落盘配置里还有明文 key ⇒ 报红
//   三处各写一套启发式 ⇒ 迟早漂移, 而漂移的方向几乎总是「守卫漏判」——
//   漏判的守卫比没有守卫更坏: 它给人「已经管住了」的错觉, 让人放心地把仓库 push 出去。
//
// ── 判据分两层, 取并集 ──
//   ① 值层 (不看字段名): 高置信前缀 (sk- / ghp_ / AIza / JWT …)
//      —— 无论放在哪个字段里, 它就是密钥。
//   ② 字段层 (看字段名): 字段名**精确**命中密钥字段表 + 值不是占位符。
//      精确表而不是模糊正则: 'max_tokens' 里也含 'token', 模糊匹配会把
//      `max_tokens: 32768` 当成密钥 —— 一个会误报的守卫, 很快会被当成噪音关掉。
//
// ⚠️ 这套判据跟「开源与否」无关: 本地开发、单元测试、CI 跑的是同一套。
//    密钥不该落盘这件事, 对谁都成立。

'use strict';

// 值层: 高置信密钥前缀 —— 命中即密钥, 不管它在哪个字段里。
const SECRET_VALUE_PREFIXES = [
  'sk-', 'sk_', 'sk-cp-', 'sk-ant-', 'sk-proj-',
  'ghp_', 'ghs_', 'gho_', 'ghu_', 'github_pat_',
  'xoxb-', 'xoxp-', 'xapp-',
  'glpat-', 'npm_', 'dop_v1_', 'hf_', 'r8_',
  'AIza', 'AKIA', 'ASIA', 'eyJ',
];

// 占位符值 —— 这些**不是**密钥, 是「这里本来就没配 key」。
// 注意 'local-' 前缀: scripts/add-mlx-model.js 写 `api_key: 'local-' + provider`,
// 那是个本地哨兵值, 不是凭证 —— 把它当密钥收编会凭空造出一个假凭证。
const PLACEHOLDER_VALUES = new Set([
  '', '***', 'empty', 'null', 'none', 'undefined', 'not-needed', 'no-key', 'local',
  'lm-studio', 'ollama', 'vllm', 'llamacpp', 'sk-...', 'sk-ant-...', 'sk-cp-...',
  'sk-replace-me', 'sk-ant-replace-me', 'sk-cp-replace-me',
  'key-...', 'your-key', 'your-key-here', 'placeholder', 'todo', 'changeme',
  'replace-me', '<your-key>', 'put-your-key-here', 'replace-me-with-your-key',
]);

// 字段层: 精确的密钥字段名表 (小写比较)。
// 用精确表而非模糊匹配 —— 见文件头「为什么」。
const SECRET_FIELD_NAMES = new Set([
  'api_key', 'apikey', 'api-key', 'api_token',
  'openai_api_key', 'stt_api_key', 'tts_api_key', 'x_api_key',
  'access_token', 'auth_token', 'refresh_token', 'id_token', 'token',
  'client_secret', 'secret', 'password', 'passwd', 'passphrase',
  'credential', 'bearer', 'authorization', 'evomap_token',
]);

/** 值是不是「环境变量引用」形态 `${FOO}`。 */
function isEnvReference(v) {
  return typeof v === 'string' && /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(v.trim());
}

/** 这个值算不算占位符 (即「本来就没配」)。 */
function isPlaceholderValue(v) {
  if (typeof v !== 'string') return true;
  const s = v.trim();
  if (!s) return true;
  if (PLACEHOLDER_VALUES.has(s.toLowerCase())) return true;
  if (s.toLowerCase().startsWith('local-')) return true;
  if (s.includes('***')) return true;
  if (isEnvReference(s)) return true;
  return false;
}

/** 值层判定: 有没有高置信密钥前缀。 */
function hasSecretPrefix(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  return SECRET_VALUE_PREFIXES.some(p => s.startsWith(p));
}

/**
 * 这个字段的值是不是一把真密钥。
 * @param {*} value 字段值
 * @param {string} [fieldName] 字段名 (字段层判据要用)
 * @returns {boolean}
 */
function looksLikeSecret(value, fieldName) {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (isPlaceholderValue(s)) return false;
  if (hasSecretPrefix(s)) return true;
  const f = String(fieldName || '').trim().toLowerCase();
  if (f && SECRET_FIELD_NAMES.has(f)) {
    // 字段层还要过「形态」这一关:
    //   密钥是**一串没有空格、纯 ASCII 的连续字符**。
    //   没有这道关, `api_key: "留空也行 —— 代码会去 credentials 找"` 这种
    //   说明文字会被当成密钥 —— 而那正是仓内模板 example-node.json 里的写法。
    if (/\s/.test(s)) return false;
    if (/[^\x20-\x7E]/.test(s)) return false;
    return s.length >= 8;
  }
  return false;
}

/**
 * 递归扫一个对象, 找出所有明文密钥。
 * @param {*} obj 待扫对象
 * @param {string} [basePath] 路径前缀 (给报告用)
 * @returns {Array<{path: string, field: string, value: string}>}
 */
function findSecretsInObject(obj, basePath) {
  const out = [];
  const prefix = basePath || '';
  const walk = (o, path) => {
    if (Array.isArray(o)) {
      o.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (!o || typeof o !== 'object') return;
    for (const k of Object.keys(o)) {
      const v = o[k];
      const p = path ? `${path}.${k}` : k;
      if (v && typeof v === 'object') {
        walk(v, p);
      } else if (looksLikeSecret(v, k)) {
        out.push({ path: p, field: k, value: String(v) });
      }
    }
  };
  walk(obj, prefix);
  return out;
}

/** 对外暴露时把密钥换成 `***` (与 inline_router 里既有的脱敏口径一致)。 */
function redactSecret(v) {
  return looksLikeSecret(v, 'api_key') ? '***' : v;
}

module.exports = {
  SECRET_VALUE_PREFIXES,
  PLACEHOLDER_VALUES,
  SECRET_FIELD_NAMES,
  isEnvReference,
  isPlaceholderValue,
  hasSecretPrefix,
  looksLikeSecret,
  findSecretsInObject,
  redactSecret,
};
