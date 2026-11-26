'use strict';
/**
 * tests/secret-hygiene-20261026.test.js -- 密钥卫生守卫 (第 110 批)
 *
 * 这条守卫守的是什么:
 *   老板原话: 「key 的问题其实无论开源还是本地开发, 不是都一样的要求嘛」。
 *   => 密钥不落盘**不是发布前的一次性检查**, 而是运行时机制的一部分:
 *     本地开发 / 单元测试 / CI 跑的是同一套判据, 谁也别想绕过去。
 *
 *   机制: 密钥值只允许存在 ~/.pangu/credentials.json (600);
 *         项目目录里的配置只准留**引用** (api_key_credential / api_key_env)。
 *         启动时自动收编 (modules/node_credentials.js), 守卫负责盯住它别退化。
 *
 * 判据:
 *   1 生效配置 (node_config 解析出来的那份) 里没有明文密钥
 *   2 项目目录 config/ 下所有 json 里没有明文密钥
 *   3 判据本身不空转 -- 造一份含明文的配置, 必须被检出 (防恒真守卫)
 *   4 明文不许直接进鉴权 header (源码层)
 *   5 写入端不许把用户提交的 key 直接写进模型对象
 *   6 收编幂等 + 收编后只剩引用
 *   7 凭证库文件权限只有 owner 能读
 *   8 解析链顺序: 凭证库 > 环境变量 > 明文 (明文只兜底)
 *   9 守卫会咬人: 把「明文提回第一优先级」变异回去, 8 必须报红
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CORE = path.join(__dirname, '..');            // apps/core
const scan = require(path.join(CORE, 'modules', 'secret_scan'));

function stripComments(src) {
  return src.split('\n').filter(l => {
    const t = l.trim();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
  }).join('\n');
}

function readSrc(rel) {
  return fs.readFileSync(path.join(CORE, rel), 'utf8');
}

// 1 生效配置里没有明文密钥
test('1 生效配置里没有明文密钥 (收编机制已把明文搬进凭证库)', () => {
  const cfgPath = require(path.join(CORE, 'config', 'node_config')).resolveNodeConfigPathOrExample();
  assert.ok(cfgPath && fs.existsSync(cfgPath), '解析不到节点配置路径');
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    assert.fail('节点配置不是合法 JSON: ' + cfgPath + ' -- ' + e.message);
  }
  const hits = scan.findSecretsInObject(cfg, '');
  assert.equal(
    hits.length, 0,
    '生效配置里还有明文密钥 ' + JSON.stringify(hits.map(h => h.path))
    + ' => 启动时应该已经被收编进 ~/.pangu/credentials.json。'
    + ' (收编器: modules/node_credentials.js; 凭证名推导: modules/api_key_resolver.credentialNameFor)',
  );
});

// 2 项目目录的配置文件里没有明文密钥
test('2 项目目录 config/ 下所有 json 里没有明文密钥', () => {
  const dir = path.join(CORE, 'config');
  const offenders = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) { walk(abs); continue; }
      if (!e.name.endsWith('.json')) continue;
      let obj;
      try { obj = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (_) { continue; }
      const hits = scan.findSecretsInObject(obj, '');
      if (hits.length) offenders.push(path.relative(CORE, abs) + ' -> ' + hits.map(h => h.path).join(','));
    }
  };
  walk(dir);
  assert.equal(offenders.length, 0, '这些配置文件里有明文密钥:\n  ' + offenders.join('\n  '));
});

// 3 判据不空转 (防恒真守卫)
test('3 判据本身不空转: 造一份含明文的配置, 必须被检出', () => {
  const fake = {
    llm: {
      models: [
        { id: 'x', provider: 'minimax', api_key: 'sk-cp-' + 'a'.repeat(40) },
        { id: 'y', provider: 'custom', api_key: 'Zx9'.repeat(12) },
        { id: 'z', provider: 'kimi', api_key: 'sk-REPLACE-ME' },
        { id: 'w', provider: 'kimi', api_key: '' },
        { id: 'v', provider: 'kimi', api_key: 'local-lmstudio' },
      ],
      max_tokens: 32768,
    },
  };
  const hits = scan.findSecretsInObject(fake, '');
  assert.equal(hits.length, 2, '判据漏检: ' + JSON.stringify(hits));
  assert.ok(hits.some(h => h.path === 'llm.models[0].api_key'), '有前缀的 sk- key 必须检出');
  assert.ok(hits.some(h => h.path === 'llm.models[1].api_key'), '无前缀的 key 必须靠字段名检出');
  assert.ok(!hits.some(h => h.path.includes('models[2]')), '占位符 sk-REPLACE-ME 不该被当成密钥');
  assert.ok(!hits.some(h => h.path.includes('models[3]')), '空值不该被当成密钥');
  assert.ok(!hits.some(h => h.path.includes('models[4]')), 'local- 哨兵值不该被当成密钥');
  assert.ok(!hits.some(h => h.path.includes('max_tokens')), 'max_tokens 不该被当成密钥字段');
});

// 4 明文不许直接进鉴权 header
test('4 明文不许直接进鉴权 header (取 key 只能走统一解析链)', () => {
  const files = [
    'pangu-single/routes/inline_router.js',
    'modules/self_repair.js',
    'modules/llm_capabilities_selfreport.js',
    'scripts/l2-miner.js',
    'modules/llm_caller.js',
  ];
  const offenders = [];
  for (const f of files) {
    const code = stripComments(readSrc(f));
    if (/Bearer[^'\n]*['"`]\s*\+\s*[A-Za-z_$][\w.$]*\.api_key\b/.test(code)) {
      offenders.push(f + ' -> 把 .api_key 直接拼进了 Authorization');
    }
    if (/['"`]x-api-key['"`]\s*[:,]\s*[A-Za-z_$][\w.$]*\.api_key\b/.test(code)) {
      offenders.push(f + ' -> 把 .api_key 直接拼进了 x-api-key');
    }
  }
  assert.equal(
    offenders.length, 0,
    '这些地方绕过了解析链直接读明文 key:\n  ' + offenders.join('\n  ')
    + '\n  => 明文已从配置里收编进凭证库, 这里会拿到空串。取 key 走 modules/api_key_resolver.resolveApiKey。',
  );
});

// 5 写入端不许把提交的 key 直接写进模型对象
test('5 写入端把用户提交的 key 转存凭证库, 不直接写进模型对象', () => {
  const code = stripComments(readSrc('pangu-single/routes/inline_router.js'));
  assert.doesNotMatch(
    code, /api_key:\s*(override|safeM|body|req_body|m)\b/,
    '模型对象里还在直接写 api_key: <提交上来的值> => 明文会落进项目目录',
  );
  assert.match(
    code, /applySubmittedKey/,
    '写入端必须走 node_credentials.applySubmittedKey (存凭证库 + 只留引用)',
  );
});

// 6 收编幂等 + 收编后只剩引用
test('6 收编幂等: 第一次搬走明文, 第二次无事可做, 收编后只剩引用', () => {
  const nc = require(path.join(CORE, 'modules', 'node_credentials'));
  const store = {
    data: {},
    get(n) { return this.data[n] || null; },
    set(n, v) { this.data[n] = v; return { ok: true, name: n }; },
  };
  const cfg = {
    llm: {
      models: [
        { id: 'minimax-m3', provider: 'minimax', api_key: 'sk-cp-' + 'b'.repeat(60) },
        { id: 'agnes-3.0-flash', provider: 'custom', api_key: 'Ag' + 'c'.repeat(30) },
      ],
    },
  };
  const r1 = nc.harvestInlineSecrets(cfg, { store });
  assert.equal(r1.changed, true, '第一次收编必须有动作');
  assert.equal(r1.harvested.length, 2);
  assert.equal(cfg.llm.models[0].api_key, undefined, '收编后明文字段必须消失');
  assert.equal(cfg.llm.models[0].api_key_credential, 'MINIMAX_API_KEY');
  assert.ok(store.data.MINIMAX_API_KEY, '凭证库里必须有 MINIMAX_API_KEY');
  assert.ok(store.data.AGNES_3_0_FLASH_API_KEY, '通用 provider => 按模型 id 派生凭证名');
  assert.equal(scan.findSecretsInObject(cfg, '').length, 0, '收编后还剩明文');
  const r2 = nc.harvestInlineSecrets(cfg, { store });
  assert.equal(r2.changed, false, '第二次收编必须无事可做 (幂等)');
  assert.equal(r2.harvested.length, 0);
});

// 7 凭证库文件权限
test('7 凭证库文件只有 owner 能读 (chmod 600)', () => {
  const credFile = require(path.join(CORE, 'modules', 'credentials')).CRED_FILE;
  if (!fs.existsSync(credFile)) return;
  const mode = fs.statSync(credFile).mode & 0o777;
  assert.equal(
    mode & 0o077, 0,
    '凭证库 ' + credFile + ' 权限是 ' + mode.toString(8)
    + ' => 别的用户能读。必须是 600 (owner-only)。',
  );
});

function freshResolver() {
  const p = path.join(CORE, 'modules', 'api_key_resolver.js');
  delete require.cache[require.resolve(p)];
  return require(p);
}

// 8 解析链顺序
test('8 解析链: 凭证库 > 环境变量 > 明文 (明文只兜底)', () => {
  const R = freshResolver();
  const saved = {};
  const setEnv = (k, v) => {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  };
  try {
    setEnv('PANGU_CRED_MINIMAX_API_KEY', 'sk-cp-from-credential-store');
    const both = { id: 'm', provider: 'minimax', api_key: 'sk-cp-inline-should-lose' };
    assert.equal(R.resolveApiKey(both), 'sk-cp-from-credential-store',
      '凭证库里的 key 必须赢过配置里的明文 -- 明文是最容易被备份/同步带走的那份');
    assert.equal(R.resolveApiKeySource(both), 'credential');

    // 明文兜底: 用一个**凭证库里肯定没有**的 provider,
    //   否则凭证库赢过明文, 这条就测不到「兜底」了 (minimax 在本机凭证库里是有的)。
    setEnv('PANGU_CRED_MINIMAX_API_KEY', undefined);
    const inlineOnly = { id: 'm', provider: 'novendorinstore', api_key: 'sk-cp-inline-only' };
    assert.equal(R.resolveApiKey(inlineOnly), 'sk-cp-inline-only');
    assert.equal(R.resolveApiKeySource(inlineOnly), 'inline');

    setEnv('MYVENDOR_API_KEY', 'sk-myvendor-env');
    assert.equal(R.resolveApiKey({ id: 'v', provider: 'myvendor' }), 'sk-myvendor-env');
    assert.equal(R.resolveApiKeySource({ id: 'v', provider: 'myvendor' }), 'env');

    setEnv('PANGU_CRED_EXPLICIT_ONE', 'sk-explicit-credential');
    assert.equal(
      R.resolveApiKey({ id: 'v', provider: 'myvendor', api_key_credential: 'EXPLICIT_ONE' }),
      'sk-explicit-credential',
    );

    setEnv('FOO_KEY', 'sk-foo-from-env');
    assert.equal(R.resolveApiKey({ id: 'v', provider: 'myvendor', api_key: 'env:FOO_KEY' }), 'sk-foo-from-env');

    assert.equal(R.resolveApiKey({ id: 'v', provider: 'nosuchvendor' }), '');
    assert.equal(R.resolveApiKeySource({ id: 'v', provider: 'nosuchvendor' }), 'none');
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    freshResolver();
  }
});

// 9 守卫会咬人 (变异体检)
test('9 守卫会咬人: 把「明文提回第一优先级」变异回去, 8 必须报红', () => {
  const mg = require(path.join(__dirname, 'helpers', 'mutation_guard'));
  const ANCHOR = "function resolveApiKeyWithSource(useModel) {\n  if (!useModel) return { key: '', source: 'none' };";
  const MUTANT = ANCHOR + "\n  if (typeof useModel.api_key === 'string' && !isPlaceholderValue(useModel.api_key) && useModel.api_key.trim().length > 4) return { key: useModel.api_key, source: 'inline' };";

  const runGuard = () => {
    const R = freshResolver();
    const saved = process.env.PANGU_CRED_MINIMAX_API_KEY;
    try {
      process.env.PANGU_CRED_MINIMAX_API_KEY = 'sk-cp-from-credential-store';
      const got = R.resolveApiKey({ id: 'm', provider: 'minimax', api_key: 'sk-cp-inline-should-lose' });
      if (got !== 'sk-cp-from-credential-store') {
        return 'not ok 1 - 凭证库没有赢过明文 (got=' + got + ')';
      }
      return null;
    } catch (e) {
      return 'not ok 1 - ' + e.message;
    } finally {
      if (saved === undefined) delete process.env.PANGU_CRED_MINIMAX_API_KEY;
      else process.env.PANGU_CRED_MINIMAX_API_KEY = saved;
    }
  };

  mg.mutateAndExpectRed({
    file: 'modules/api_key_resolver.js',
    from: ANCHOR,
    to: MUTANT,
    suffix: '.secret-hygiene-mut.bak',
    root: CORE,
    runGuard,
  });
  assert.equal(runGuard(), null, '还原后守卫必须重新变绿');
});
