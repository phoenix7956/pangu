// modules/api_key_resolver.js — 共享 API Key 解析链 (**唯一真源**)
// 运行时 (llm_caller) 与探测 (model_probe) 必须用同一条链, 否则
// 配置里 key 存在 credentials.js / 环境变量的模型会被探测直接判 no-data.
//
// ── 2026-10-26 第 110 批: 链的顺序改了 ──
//   旧: model.api_key (明文, 优先!) > credentials.js > 环境变量
//   新: 显式凭证引用 > 显式环境变量 > credentials.js > 约定环境变量 > 明文(兜底)
//   理由: 明文 key 躺在**项目目录的配置文件**里, 会被备份/同步/误提交带走 ——
//   这跟开不开源无关, 本地开发同样该管。所以明文从「最高优先级」降成「兜底」,
//   正规来源 (凭证库 / 环境变量) 优先。收编机制 (modules/node_credentials.js)
//   会在启动时把落盘明文搬进 ~/.pangu/credentials.json, 于是明文这一路迟早是空的。
//
// ⚠️ 降级不等于废除: 明文仍然能取到 key —— 保留它是为了「当场传参」的场景
//   (UI 探测时把用户刚填的 key 直接喂进来, 那时它还没落盘, 不该被拦)。

'use strict';

const { isPlaceholderValue } = require('./secret_scan');

// 按 provider 推断 credentials / 环境变量名
//
// 2026-10-25 第 99 批: 原来这是一张**写死的表**, 换厂商要改代码。
// 现在改成「命名约定 + 显式档案」:
//   约定: <PROVIDER>_API_KEY (大写) —— 绝大多数厂商都符合这条
//   例外: 少数厂商的历史命名不同 (qwen→DASHSCOPE_API_KEY), 显式列出来
//   覆盖: 配置里写 api_key_env 的模型条目优先
// 这样「接一个新厂商」通常是**什么都不用改** (它自己的 KEY 就是 <NAME>_API_KEY)。
const _PROVIDER_CRED_KEYS = {
  minimax: 'MINIMAX_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  kimi: 'KIMI_API_KEY',
  qwen: 'DASHSCOPE_API_KEY',
  volcengine: 'VOLCENGINE_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  zhipu: 'ZHIPU_API_KEY',
};

// 命名约定 —— 表里没有的 provider 走这条。
// 例: 'moonshotai' → MOONSHOTAI_API_KEY, 'together' → TOGETHER_API_KEY。
// 用 env 名覆盖的 (ModelScope 之类) 由厂商自己定义, 不走这条约定。
function _conventionalCredKey(provider) {
  const p = String(provider || '').trim().toLowerCase();
  if (!p) return null;
  // 只接受能安全拼成环境变量名的 provider 名
  if (!/^[a-z0-9]+$/.test(p)) return null;
  return p.toUpperCase() + '_API_KEY';
}

// 解析这个模型该用哪个环境变量名。
// 优先级: 模型条目显式 api_key_env > 已知厂商表 > 命名约定。
function _credKeyFor(useModel) {
  if (!useModel) return null;
  const explicit = String(useModel.api_key_env || '').trim();
  if (explicit) return explicit;
  const provider = String(useModel.provider || '').trim().toLowerCase();
  if (_PROVIDER_CRED_KEYS[provider]) return _PROVIDER_CRED_KEYS[provider];
  return _conventionalCredKey(provider);
}

// 「这个 provider 对应的凭证库条目名」—— 不含 api_key_env 那一层。
//   为什么要跟 _credKeyFor 分开: api_key_env 指的是**环境变量名**,
//   拿它去凭证库里找条目是找不到的 (那是两个不同的命名空间)。
function _providerCredKey(useModel) {
  if (!useModel) return null;
  const provider = String(useModel.provider || '').trim().toLowerCase();
  if (_PROVIDER_CRED_KEYS[provider]) return _PROVIDER_CRED_KEYS[provider];
  return _conventionalCredKey(provider);
}

// 不带厂商身份的 provider —— 拿它们拼 '<PROVIDER>_API_KEY' 会撞名
//   (两个不同的自建网关都会算出 CUSTOM_API_KEY, 一把 key 覆盖另一把)。
const _GENERIC_PROVIDERS = new Set([
  'custom', 'local', 'generic', 'unknown', 'self-hosted', 'selfhosted',
  'openai-compatible', 'openai_compatible',
]);

/**
 * 这个模型的 key 该存在凭证库的哪个条目名下。
 * 优先级: 显式 api_key_credential > 厂商表 > 命名约定 > 模型 id 派生
 * @param {object} useModel
 * @returns {string|null} 凭证条目名 (null = 推不出来)
 */
function credentialNameFor(useModel) {
  if (!useModel) return null;
  const explicit = String(useModel.api_key_credential || '').trim();
  if (explicit) return explicit;
  const provider = String(useModel.provider || '').trim().toLowerCase();
  if (provider && !_GENERIC_PROVIDERS.has(provider)) {
    const byProvider = _providerCredKey(useModel);
    if (byProvider) return byProvider;
  }
  // 派生名: 模型 id 规范化。保证两个模型不会撞名。
  const id = String(useModel.id || useModel.name || '').trim();
  const derived = id.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return derived ? derived + '_API_KEY' : null;
}

// 占位符 key 会 401, 等价于没有 key
// (判据来自 modules/secret_scan.js —— 那是「像不像密钥」的唯一真源, 别在这儿另抄一份)
const _API_KEY_PLACEHOLDERS = new Set([
  '***', 'sk-...', 'sk-ant-...', 'key-...', 'EMPTY',
  'your-key', 'your-key-here', 'placeholder', 'todo', 'changeme',
  'replace-me', '<your-key>', 'PUT-YOUR-KEY-HERE',
]);

// 从凭证库取一把 key (带占位符过滤)。
function _credValue(name) {
  if (!name) return null;
  try {
    const creds = require('./credentials');
    const v = creds.get(name);
    if (v && !isPlaceholderValue(v)) return v;
  } catch (e) { console.warn('[api_key_resolver] credentials 加载失败:', e.message); }
  return null;
}

/**
 * 解析链 + 来源。**取 key 只应该走这里** (resolveApiKey 是它的薄封装)。
 * @returns {{key: string, source: 'credential'|'env'|'inline'|'none'}}
 */
function resolveApiKeyWithSource(useModel) {
  if (!useModel) return { key: '', source: 'none' };

  // 1. 显式凭证名 (模型条目点名要凭证库里哪一条)
  const explicitCred = String(useModel.api_key_credential || '').trim();
  if (explicitCred) {
    const v = _credValue(explicitCred);
    if (v) return { key: v, source: 'credential' };
  }

  // 2. 显式环境变量 (api_key_env > api_key_source: env:NAME > api_key 字段的 env:NAME 形式)
  //    ⚠️ 顺序含义: **显式指定赢过 provider 约定名**。
  //    `api_key: "env:FOO"` 是「这个模型就用 FOO」的意思, 不是兜底 ——
  //    它得排在「按 provider 猜的环境变量」前面, 否则模型级的显式指定会被约定名盖掉。
  const inlineEnv = (() => {
    const raw = String(useModel.api_key || '').trim();
    return raw.startsWith('env:') ? raw.slice(4).trim() : '';
  })();
  const envExplicit = String(useModel.api_key_env || '').trim()
    || String(useModel.api_key_source || '').replace(/^env:/, '').trim()
    || inlineEnv;
  if (envExplicit && process.env[envExplicit]) {
    return { key: process.env[envExplicit], source: 'env' };
  }

  // 3. 凭证库 (provider 约定的条目名)
  const credKey = _providerCredKey(useModel);
  if (credKey) {
    const v = _credValue(credKey);
    if (v) return { key: v, source: 'credential' };
    // 4. 环境变量 (同一个约定名)
    if (process.env[credKey]) return { key: process.env[credKey], source: 'env' };
  }

  // 5. 明文兜底 —— 落盘配置里的明文会被收编机制搬走, 这里只服务「当场传参」
  const inline = useModel.api_key;
  if (typeof inline === 'string') {
    const s = inline.trim();
    // `api_key: "env:FOO"` 已在第 2 步处理 (显式环境变量) —— 这里只管真明文。
    if (!s.startsWith('env:') && !isPlaceholderValue(s) && s.length > 4) {
      return { key: s, source: 'inline' };
    }
  }
  return { key: '', source: 'none' };
}

function resolveApiKey(useModel) {
  return resolveApiKeyWithSource(useModel).key;
}

/** 这个模型的 key 是从哪来的 (UI 展示 + 守卫判据用)。 */
function resolveApiKeySource(useModel) {
  return resolveApiKeyWithSource(useModel).source;
}

// 本地回环 endpoint 不需要 key (LM Studio / Ollama / vLLM)
// 2026-10-23 第 71 批: 判定收进 local_model 这个唯一真源。
// 这里保留**纯回环**口径 (不含内网) —— 本来就是这个语义, 别顺手改成"回环 or 内网",
// 那会让公司网里的自建代理也免 key, 而它未必不要 key。
function isLocalEndpoint(url) {
  try {
    return require('./local_model').isLoopbackEndpoint(url);
  } catch (_) { return false; }
}

module.exports = {
  resolveApiKey,
  resolveApiKeyWithSource,
  resolveApiKeySource,
  credentialNameFor,
  isLocalEndpoint,
  _PROVIDER_CRED_KEYS,
  _credKeyFor,
  _providerCredKey,
  _API_KEY_PLACEHOLDERS,
};
