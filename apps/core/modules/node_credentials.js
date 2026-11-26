// modules/node_credentials.js — 「明文密钥不许留在项目目录里」的执行者
//
// ── 这条机制跟开源无关 ──
//   密钥落盘的风险不取决于你要不要把仓库公开:
//     · 备份 / 时间机器 / 云同步会把配置目录带走
//     · `git add -A` 一把梭就把明文提交进去 (gitignore 挡不住已跟踪的文件)
//     · 换机器 / 拷配置给同事 ⇒ key 跟着走
//   所以规则是**同一个**: 密钥值只允许存在 ~/.pangu/credentials.json (600),
//   项目目录里的配置只准留**引用** (api_key_credential / api_key_env)。
//
// ── 为什么是「自动收编」而不是「让人记得手工搬」 ──
//   手工迁移是一次性动作 —— 下次有人手改配置又写回去, 就回到原样。
//   机制必须自己把明文收编掉, 人才不会跟它搏斗。
//   ⇒ 启动时扫一遍落盘配置, 见到明文就搬进凭证库, 文件里改留引用。
//
// ── 收编时谁的优先级高 ──
//   文件里的明文覆盖凭证库里的同名条目。理由: 明文出现在文件里, 说明它是
//   **最近一次**显式设置 (UI 保存 / 手改配置)。凭证库里那份可能是更早的。
//   ⇒ 收编后行为不变 (这正是「搬走」而不是「换掉」该有的性质)。

'use strict';

const fs = require('fs');
const credentials = require('./credentials');
const { looksLikeSecret, findSecretsInObject } = require('./secret_scan');
const { credentialNameFor } = require('./api_key_resolver');

// 凭证存储的接口: { get(name) -> string|null, set(name, value) -> {ok} }
//   默认用真凭证库 (modules/credentials.js, ~/.pangu/credentials.json)。
//   允许注入是为了让守卫测试**不碰真凭证库** ——
//   否则跑一次测试就往主人的凭证文件里写假条目。
function _store(opts) {
  return (opts && opts.store) || credentials;
}

// 落盘配置里, **不在模型池里**的密钥字段 (voice.stt_api_key / llm.openai_api_key …)
//   ⇒ 凭证名直接用字段名大写 (STT_API_KEY / OPENAI_API_KEY)。
//   它们目前没有活代码在读 (voice 走本地 :8765, openai_api_key 已废弃),
//   所以收编不会打断任何在跑的功能。
function _fieldCredentialName(fieldName) {
  const n = String(fieldName || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return n ? n : null;
}

/**
 * 把一把 key 存进凭证库。
 * @param {object} model 模型条目 (用来推导凭证名)
 * @param {string} key 明文 key
 * @param {object} [opts] { store } —— 注入凭证存储 (测试用)
 * @returns {{ok: boolean, name: string|null, error?: string}}
 */
function storeForModel(model, key, opts) {
  if (!looksLikeSecret(key, 'api_key')) return { ok: false, name: null, error: 'NOT_A_SECRET' };
  const name = credentialNameFor(model);
  if (!name) return { ok: false, name: null, error: 'NO_CREDENTIAL_NAME' };
  const r = _store(opts).set(name, key);
  if (!r || !r.ok) return { ok: false, name, error: (r && r.error) || 'STORE_FAILED' };
  return { ok: true, name };
}

/**
 * 写入端 (UI 保存模型): 用户当场填的 key ⇒ 存凭证库, 配置里只留引用。
 *   —— 这是「机制」而不是「补丁」的关键: 以后所有人从 UI 加模型,
 *      明文 key 都不会再落进项目目录, 不需要记得做迁移。
 * @param {object} model 待写入的模型条目 (会被就地改)
 * @param {string} submittedKey 用户提交的 key (可能是 '' / '***' / 真 key)
 * @param {object} [opts] { store }
 * @returns {{stored: boolean, name: string|null}}
 */
function applySubmittedKey(model, submittedKey, opts) {
  if (!model || typeof model !== 'object') return { stored: false, name: null };
  const raw = typeof submittedKey === 'string' ? submittedKey.trim() : '';
  // '***' 是前端回显的脱敏占位 —— 不能拿它当新 key 存, 也不能覆盖已有的引用。
  if (!raw || raw === '***') {
    delete model.api_key;
    return { stored: false, name: model.api_key_credential || null };
  }
  if (!looksLikeSecret(raw, 'api_key')) {
    // 不是密钥 (占位符 / 空 / 本地哨兵) ⇒ 当普通字段存着
    model.api_key = raw;
    return { stored: false, name: model.api_key_credential || null };
  }
  const r = storeForModel(model, raw, opts);
  if (!r.ok) {
    // 存不进去 (凭证名推不出来 / 写盘失败) ⇒ 不落明文, 保持引用为空。
    // 宁可模型暂时连不上, 也不把密钥写回项目目录。
    delete model.api_key;
    return { stored: false, name: null, error: r.error };
  }
  model.api_key_credential = r.name;
  delete model.api_key;
  return { stored: true, name: r.name };
}

/**
 * 启动时收编: 把落盘配置里的明文密钥搬进凭证库, 文件里改留引用。
 *   幂等 —— 收编过的文件再扫一遍是空的。
 * @param {object} config 节点配置 (会被就地改)
 * @param {object} [opts] { store }
 * @returns {{changed: boolean, harvested: Array<{path: string, name: string}>}}
 */
function harvestInlineSecrets(config, opts) {
  const report = { changed: false, harvested: [] };
  if (!config || typeof config !== 'object') return report;

  // ① 模型池 —— 凭证名按模型推导 (vendor 约定名优先, 通用 provider 用模型 id 派生)
  const models = (config.llm && Array.isArray(config.llm.models)) ? config.llm.models : [];
  models.forEach((model, i) => {
    if (!model || typeof model !== 'object') return;
    const key = model.api_key;
    if (!looksLikeSecret(key, 'api_key')) return;
    // 凭证名优先级: 模型自己点名 > 已知映射(别的配置里同一个模型用哪个条目)
    //   > 按模型推导。已知映射是为了让**平行的配置副本**指向同一条凭证 ——
    //   同一个模型在两份配置里用两条不同条目, 迟早漂移成两把 key。
    const name = (model.api_key_credential)
      || (opts && opts.knownNames && opts.knownNames[model.id])
      || null;
    const r = storeForModel(name ? { ...model, api_key_credential: name } : model, key, opts);
    if (!r.ok) {
      // 收编失败 (凭证名推不出来) ⇒ 不动它, 交给守卫报出来。静默丢掉 key 更糟。
      report.harvested.push({ path: `llm.models[${i}].api_key`, name: null, error: r.error });
      return;
    }
    model.api_key_credential = r.name;
    delete model.api_key;
    report.changed = true;
    report.harvested.push({ path: `llm.models[${i}].api_key`, name: r.name });
  });

  // ② 其余字段 (voice.stt_api_key / llm.openai_api_key …)
  const rest = findSecretsInObject(config, '');
  rest.forEach(hit => {
    // 模型池里的已经处理过了
    if (/^llm\.models\[\d+\]\.api_key$/.test(hit.path)) return;
    const name = _fieldCredentialName(hit.field);
    if (!name) return;
    const r = _store(opts).set(name, hit.value);
    if (!r || !r.ok) {
      report.harvested.push({ path: hit.path, name: null, error: (r && r.error) || 'STORE_FAILED' });
      return;
    }
    // 就地替换: 值清空 + 留一个 <field>_credential 引用
    const parts = hit.path.split('.');
    let cur = config;
    for (let k = 0; k < parts.length - 1; k++) cur = cur[parts[k]];
    const last = parts[parts.length - 1];
    if (cur && typeof cur === 'object') {
      cur[last] = '';
      cur[last + '_credential'] = name;
    }
    report.changed = true;
    report.harvested.push({ path: hit.path, name });
  });

  return report;
}

/**
 * 收编**一个文件**里的明文密钥 (读 → 收编 → 写回)。
 *   为什么要有它: 除了 config/nodes/node.json, 历史上还有几份平行的配置副本
 *   (如 ~/.pangu/config.json)。规则是「密钥值只允许存在凭证库」——
 *   规则要覆盖**所有**落盘副本, 否则「收编了主配置、副本里还躺着同一把 key」
 *   等于没收编。
 * @param {string} filePath 配置文件绝对路径
 * @param {object} [opts] { store, dryRun }
 * @returns {{changed: boolean, harvested: Array, error?: string}}
 */
function harvestFile(filePath, opts) {
  const empty = { changed: false, harvested: [] };
  if (!filePath || !fs.existsSync(filePath)) return empty;
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return { changed: false, harvested: [], error: 'BAD_JSON: ' + e.message };
  }
  const report = harvestInlineSecrets(cfg, opts);
  if (report.changed && !(opts && opts.dryRun)) {
    try {
      fs.writeFileSync(filePath, JSON.stringify(cfg, null, 2));
    } catch (e) {
      return { changed: report.changed, harvested: report.harvested, error: 'WRITE_FAILED: ' + e.message };
    }
  }
  return report;
}

module.exports = {
  storeForModel,
  applySubmittedKey,
  harvestInlineSecrets,
  harvestFile,
  credentialNameFor,
};
