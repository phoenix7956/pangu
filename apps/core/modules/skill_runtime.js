/**
 * Pangu · Modules Layer
 * skill_runtime.js - 64技能运行时
 *
 * 职责：
 * - 启动时加载全部64个skill（SKILL.md）到内存
 * - 根据用户输入匹配候选skill（触发词 + hexagram语义）
 * - 执行skill定义的工具链
 * - 返回结构化结果
 *
 * 架构：
 * SkillRuntime 持有一个 Map<hexagramId, Skill>
 * Skill 包含 { meta, triggers, tools[], flows{} }
 * 工具通过 this.tools 注册（外部注入或内置实现）
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const HEXAGRAMS = require(path.join(__dirname, '..', '64i', 'hexagrams'));
const YAO_NAMES = require(path.join(__dirname, '..', '64i', 'yao_models')).YAO_NAMES;
// 2026-10-22 (第 33 批): 纳甲只认真纳甲层。
//   旧代码取的是 `hex.najia` —— 64i/hexagrams.js 的 najia 字段**不是纳甲表**
//   (60 甲子按卦序的机械循环: 坤卦打成「乙丑」, 真纳甲是「乙未」)。
const NAJIA = require(path.join(__dirname, '..', '64i', 'bagua_annotations', 'najia.js'));
// 第 46 批: 卦德(象义)的身份标签 —— 字面量只在 gua_block.js 定义一次, 这里只引用。
//   为什么 skill 这条路也要标: guaDe 会被塞进 skill 的结果对象给模型看,
//   「刚健」「贲饰」这类有典籍根但**关键词组合是整理的** —— 不标会被当经典讲。
const { XIANG_YI_TAG } = require(path.join(__dirname, 'gua_block'));

// ============================================================
// Skill 对象
// ============================================================

class Skill {
  constructor(skillDir) {
    this.dir = skillDir;
    this.name = path.basename(skillDir);
    this.meta = {};
    this.content = '';        // 全文(SKILL.md 完整内容)
    this.semantic = '';       // 卦象语义段(注入 LLM 用)
    this.annotation = '';     // 易理注解段
    this.triggers = [];       // 触发关键词列表
    this.guaId = null;        // 卦ID (1-64)
    this.guaName = '';        // 卦名
    this.guaMeaning = '';     // 卦义
    this.tools = [];         // 工具映射 [{step, guaId, toolName, params}]
    this.flows = {};          // 命名流程 { flowName: [step1, step2, ...] }
    this.jueCi = '';         // 决策提示
    // 2026-08-16 P1-D: version + aliases (Prime Agent skill runtime 对位)
    this.version = '0.0.0';   // 从 frontmatter version: 字段读
    this.aliases = [];        // 别名数组, 可从 frontmatter aliases: a,b,c 读
    this.loaded_at = null;    // 加载时间 ISO
    this.loaded = false;
  }

  /**
   * 加载并解析 SKILL.md
   */
  load() {
    const skillFile = path.join(this.dir, 'SKILL.md');
    if (!fs.existsSync(skillFile)) return false;

    const content = fs.readFileSync(skillFile, 'utf8');
    this._parse(content);
    this.loaded_at = new Date().toISOString();
    this.loaded = true;
    return true;
  }

  _parse(content) {
    // 解析元信息表格
    // 元信息解析（支持表格和列表两种格式）
    // 格式A（表格）：| **gua_id** | GUA_01 | 或 | gua_id | 9 |
    // 格式B（列表）：- **gua_id**: 1
    // 兼容 GUA_01 ~ GUA_64 格式
    const parseMetaVal = (val) => {
      val = val.trim();
      const m = val.match(/^GUA[-_]?0*(\d+)$/i);
      if (m) return parseInt(m[1]);
      // 2026-08-16 P1-D fix: 只有纯整数才转 number, 避免 `1.2.0` 被截成 `1`
      if (/^\d+$/.test(val)) return parseInt(val);
      return val;
    };

    const metaTable = content.match(/\|\s*\*?\**\s*(\w+)\s*\*?\**\s*\|\s*([^|]+?)\s*\|/g) || [];
    for (const m of metaTable) {
      const mm = m.match(/\|\s*\*?\**\s*(\w+)\s*\*?\**\s*\|\s*([^|]+?)\s*\|/);
      if (!mm) continue;
      const k = mm[1].toLowerCase();
      let v = parseMetaVal(mm[2]);
      // 2026-08-16 P1-D: aliases 字段特殊处理 (CSV 解析)
      if (k === 'aliases' && typeof v === 'string') {
        v = v.split(',').map(x => x.trim()).filter(Boolean);
        this.aliases = v;
      }
      // version 字段保留为 string
      if (k === 'version' && typeof v !== 'string') v = String(v);
      if (k === 'version') this.version = v;
      this.meta[k] = v;
      if (k === 'gua_id') this.guaId = typeof v === 'number' ? v : null;
      else if (k === 'gua_name') this.guaName = v;
      else if (k === 'gua_meaning') this.guaMeaning = v;
    }
    // 列表格式：- **gua_id**: GUA_01 或 - **gua_id**: 9
    const metaList = content.match(/- \*\*(\w+)\*\*:\s*([^\n]+)/g) || [];
    for (const m of metaList) {
      const mm = m.match(/- \*\*(\w+)\*\*:\s*([^\n]+)/);
      if (!mm) continue;
      const k = mm[1].toLowerCase();
      const v = parseMetaVal(mm[2]);
      if (k === 'gua_id') this.guaId = typeof v === 'number' ? v : null;
      else if (k === 'gua_name') this.guaName = v;
      else if (k === 'gua_meaning') this.guaMeaning = v;
    }

    // 触发词：支持表格格式和列表格式
    // 格式1：| triggers | 关键词... |
    // 格式2：- triggers: 关键词...
    const allLines = content.split('\n');
    for (const line of allLines) {
      if (/^\s*\|\s*triggers\s*\|/i.test(line)) {
        const cells = line.split('|').map(c => c.trim()).filter(Boolean);
        if (cells.length >= 2) {
          this.triggers = cells[1].split(/[,，、/、]/).map(t => t.trim()).filter(Boolean);
          break;
        }
      }
      const listT = line.match(/^\s*[-*]\s+(?:\*\*)?triggers(?:\*\*)?:\s*([^\n]+)/i);
      if (listT) {
        this.triggers = listT[1].split(/[,，、/、]/).map(t => t.trim()).filter(Boolean);
        break;
      }
    }
    // 触发词：## 触发词 之后的无头纯文本行（如：初九, 潜龙, 潜龙勿用 ...）
    if (this.triggers.length === 0) {
      const triggerSection = content.match(/## 触发词[\s\S]+?(?=\n##|\n#)/);
      if (triggerSection) {
        const triggerLine = triggerSection[0].split('\n').find(l => l.trim() && !l.startsWith('#') && !l.startsWith('|'));
        if (triggerLine) {
          this.triggers = triggerLine.split(/[,，、/、]/).map(t => t.trim()).filter(Boolean);
        }
      }
    }

    // 工具映射表（行级解析，支持两种格式）
    // 匹配 "## 工具映射" 段落，止于下一个 ## 标题或文件末尾
    const toolSectionMatch = content.match(/(?:##\s*工具映射)[\s\S]*?(?=\n##|\Z)/);
    if (toolSectionMatch) {
      
      // Debug: show first 5 lines
      const first5 = toolSectionMatch[0].split('\n').slice(0,5);
      
      const tableLines = toolSectionMatch[0].split('\n');
      for (const line of tableLines) {
        const cells = line.split('|').map(c => c.trim()).filter(Boolean);
        if (cells.length < 2) continue;
        // 过滤表头行和分隔符行
        const firstCell = cells[0];
        // 分隔符行判断：所有单元格都是 dashes（如 |-----|-----|）
        const isSeparator = cells.length >= 2 && cells.every(c => /^-+$/.test(c));
        if (['GUA编号', 'GUA', '工具名称', '工具', '工具名', '---', '-----------', '---------|', '---------'].includes(firstCell) || isSeparator) { continue; }
        // 格式A：| GUA编号 | 工具名 | 用途 |
        let guaColIdx = -1;
        for (let i = 0; i < cells.length; i++) {
          // 支持两种格式：1) GUA_N 或 GUA-N 前缀格式；2) 直接是 N-N 纯数字格式（如 46-01）
          if (/GUA[_-]?(\d+)/i.test(cells[i]) || /^\d+-\d+$/.test(cells[i])) { guaColIdx = i; break; }
        }
        if (guaColIdx >= 0) {
          const guaMatch = cells[guaColIdx].match(/GUA[_-]?(\d+)/i) || cells[guaColIdx].match(/(\d+)/);
          let toolColIdx = guaColIdx + 1;
          if (toolColIdx >= cells.length) continue;
          const toolName = cells[toolColIdx];
          if (!toolName || ['GUA', '编号', '工具', '工具名称', '工具名', '---', '-----------'].includes(toolName)) continue;
          this.tools.push({
            guaId: parseInt(guaMatch[1]),
            toolName,
            params: cells.slice(toolColIdx + 1).filter(Boolean),
          });
        } else {
          // 格式B：| 工具名 | 用途 | （无GUA列）
          const toolName = cells[0];
          
          if (!toolName || ['工具', '工具类', '工具名称', '工具名', '用途', '------', '---', '-----------', '---------|'].includes(toolName)) continue;
          this.tools.push({
            guaId: this.guaId || 1,
            toolName,
            params: cells.slice(1).filter(Boolean),
          });
          
        }
      }
    }

    // 流程块（### 流程A / 流程B）
    const flowBlocks = content.match(/### 流程[ABCDEF][\s\S]*?(?=###|$)/g) || [];
    for (const block of flowBlocks) {
      const flowNameMatch = block.match(/流程([ABCDEF])[:：]\s*([^\n]+)/);
      if (flowNameMatch) {
        const flowKey = `flow${flowNameMatch[1]}`;
        const steps = [];
        const stepMatches = block.match(/\d+\.\s+\*\*GUA[_-]?(\d+)\*\*/g) || [];
        for (const sm of stepMatches) {
          const id = parseInt(sm.match(/GUA[_-]?(\d+)/i)[1]);
          steps.push(id);
        }
        this.flows[flowNameMatch[2].trim()] = steps;
        this.flows[flowKey] = steps;
      }
    }

    // 流程块兜底：## 执行流程 + 代码块格式（如 "1. 调用 patience_manager → ..."）
    // 格式：## 执行流程 + 下方 ``` 代码块内含 "N. 工具名" 或 "N. **GUA_N**"
    if (Object.keys(this.flows).length === 0) {
      const execFlowSection = content.match(/(?:##\s*执行流程)[\s\S]*?(?=\n##|\n#|\Z)/);
      if (execFlowSection) {
        const codeBlockMatch = execFlowSection[0].match(/```[\s\S]*?```/);
        if (codeBlockMatch) {
          const codeLines = codeBlockMatch[0].split('\n').filter(l => l.trim() && /^\d+\./.test(l.trim()));
          const steps = [];
          for (const line of codeLines) {
            // 匹配 "N. 调用 toolName" 或 "N. **GUA_N**"
            const toolMatch = line.match(/\d+\.\s+(?:调用\s+)?(\w+)/);
            if (toolMatch) {
              // 从已解析的 tools 列表中按顺序找对应工具名
              const toolIndex = this.tools.findIndex(t => t.toolName === toolMatch[1]);
              if (toolIndex >= 0) {
                steps.push(this.tools[toolIndex].guaId || this.guaId || 1);
              }
            }
          }
          if (steps.length > 0) {
            this.flows['default'] = steps;
          }
        }
      }
    }

    // 决策提示：## 决策提示 章节下的 > 引用行
    const jueCiMatch = content.match(/(?:##\s*决策提示)[\s\S]*?>\s*([^\n]+)/);
    if (jueCiMatch) {
      this.jueCi = jueCiMatch[1].replace(/^\s*>?\s*/, '').trim();
    }
 // P0-1:存全文 + 提取卦象语义/易理注解两段(注入 LLM 用)
    this.content = content;
    const semMatch = content.match(/##\s*卦象语义[\s\S]*?\n\n([\s\S]*?)(?=\n##|\Z)/);
    if (semMatch) this.semantic = semMatch[1].trim();
    const annMatch = content.match(/##\s*易理注解[\s\S]*?\n\n([\s\S]*?)(?=\n##|\Z)/);
    if (annMatch) this.annotation = annMatch[1].trim();
  }

  /**
   * 检查输入是否匹配此skill（精确包含 + 二元字符相似度）
   */
  matches(input) {
    if (!input || typeof input !== 'string') return false;
    const lower = input.toLowerCase();

    for (const trigger of this.triggers) {
      const t = trigger.toLowerCase();
      // 精确包含
      if (lower.includes(t) || t.includes(lower)) return true;
      // 二元字符gram匹配：短词（2-4字）的所有gram都出现在trigger中才匹配
      if (lower.length >= 2 && lower.length <= 4 && t.length >= 2) {
        let allGramsMatch = true;
        for (let i = 0; i < lower.length - 1; i++) {
          const gram = lower.slice(i, i + 2);
          if (!t.includes(gram)) { allGramsMatch = false; break; }
        }
        if (allGramsMatch) return true;
      }
    }
    return false;
  }
}

// ============================================================
// SkillRuntime 主类
// ============================================================

class SkillRuntime {
  /**
   * @param {object} options
   * @param {string} [options.skillsDir] - skills目录路径
   * @param {object} [options.tools] - 工具注册表 { toolName: async (params) => {} }
   */
  constructor(options = {}) {
 // N1 fix: 默认指向 PANGU_HOME/skills, 与 skill_loader.js 一致 (§0.9 命名)
    // skillsDir 仍可被 options 覆盖; 默认扫 PANGU_HOME/skills (Pangu 自治, 2026-08-16 P0-2)
    this.skillsDir = options.skillsDir || path.join(process.env.PANGU_HOME || path.join(os.homedir(), '.pangu'), 'skills');
    this.tools = options.tools || {};  // 工具注册表
    this.yaoModels = options.yaoModels || null;  // ✅ 384爻数据（来自 yao_models.js）
    this.baguaAnnotations = options.baguaAnnotations || null;  // ✅ 五行+先后天注解层

    // 内存中的skill索引
    this._skills = new Map();      // name → Skill
    this._skillsByGua = new Map(); // guaId → Skill
    this._aliases = new Map();     // alias → name (P1-D Prime Agent 对位)
    this._loaded = false;
  }

  // ============================================================
  // 启动时加载
  // ============================================================

  /**
   * loadAllSkills — 扫描skillsDir，加载全部64个skill
   * @returns {Promise<{ ok, loaded, errors }>}
   */
  async loadAllSkills() {
    if (!fs.existsSync(this.skillsDir)) {
      return { ok: false, error: { code: 'SKILLS_DIR_NOT_FOUND', path: this.skillsDir } };
    }

    // 2026-09-11 修: dirent.isDirectory() 对 symlink 恒 false → 软链 skill 目录 (repo → ~/.pangu/skills)
    // 全被过滤, skills_loaded 恒 0 (09-11 实案: 4 个 skill 软链后 /health 仍 skills_loaded:0)。
    // 现在: symlink 用 statSync 解析, 真目录才收, 断链安全跳过。
    const dirs = fs.readdirSync(this.skillsDir, { withFileTypes: true })
      .filter(e => {
        if (e.name.startsWith('_') || e.name.startsWith('.')) return false;
        if (e.isDirectory() && !e.isSymbolicLink()) return true;
        if (e.isSymbolicLink()) {
          try { return fs.statSync(path.join(this.skillsDir, e.name)).isDirectory(); } catch (_) { return false; }
        }
        return false;
      })
      .map(e => path.join(this.skillsDir, e.name));

    const result = { ok: true, loaded: 0, errors: [] };
    const guaIds = new Set();

    for (const dir of dirs) {
      const skill = new Skill(dir);
      try {
        const ok = skill.load();
        const isMainSkill = !skill.name.includes('-');
        if (ok && skill.guaId) {
          const existing = this._skills.get(skill.name);
          // 如果已有同名skill：主skill不能被子skill覆盖；子skill可覆盖空缺
          if (!existing || isMainSkill) {
            this._skills.set(skill.name, skill);
          }
          // 只有主卦技能（无-）才能进 _skillsByGua；子技能同名guaId不覆盖
          if (isMainSkill) {
            this._skillsByGua.set(skill.guaId, skill);
          }
          result.loaded++;
        } else if (ok && !skill.guaId) {
          // 无guaId（子技能），仅按名称存储
          this._skills.set(skill.name, skill);
          result.loaded++;
        }
        // 2026-08-16 P1-D: 注册 aliases (Prime Agent skill 别名机制)
        if (ok && Array.isArray(skill.aliases)) {
          for (const a of skill.aliases) {
            if (a && !this._aliases.has(a)) this._aliases.set(a, skill.name);
          }
        }
      } catch (err) {
        result.errors.push({ skill: path.basename(dir), error: err.message });
      }
    }

    this._loaded = true;
    return result;
  }

  // ============================================================
  // 查询
  // ============================================================

  /**
   * getAllSkills — 获取所有已加载的skill
   */
  getAllSkills() {
    return Array.from(this._skills.values()).filter(s => s.loaded);
  }

  /**
   * getSkill — 获取指定skill
   */
  getSkill(name) {
    return this._skills.get(name) || null;
  }

  /**
   * getSkillByGua — 通过卦ID获取skill
   */
  getSkillByGua(guaId) {
    return this._skillsByGua.get(guaId) || null;
  }

  /**
   * listSkills — 列出所有skill（完整信息）
   */
  listSkills() {
    return this.getAllSkills().map(s => {
      const hex = HEXAGRAMS.HEXAGRAMS.find(h => h.id === s.guaId) || {};
      // 从技能名提取爻位，如 "乾_初九" → yao:"初九"
      const yaoPosMap = {1:'初爻',2:'二爻',3:'三爻',4:'四爻',5:'五爻',6:'上爻'};
      // 从技能名提取爻名与爻位，如 "乾_初九" → yao:"初九", pos:1
      const yaoMatch = s.name.match(/_([^_]+)$/);
      const yao = yaoMatch ? yaoMatch[1] : '';
      // 兼容标准爻名（四六/四九等变体）
      const posMatch = yao.match(/^(初|二|三|四|五|上)(九|六)$/);
      const yaoNum = posMatch ? ['初','二','三','四','五','上'].indexOf(posMatch[1]) + 1 : 0;
      const yaoPos = posMatch ? yaoPosMap[yaoNum] || (posMatch[1]+'爻') : '';
      // 对于复合卦，用内卦（下卦）方位；对于纯卦，直接用卦名查方位
      // XIAN_TIAN_SEQ 只含8个基础卦名（乾1兑2离3震4巽5坎6艮7坤8）
      // ⚠️ 2026-10-22 第 42 批改口径: 原注释写的「乾1兑2离3巽4震5艮6坎7坤8」
      //   是错的（震/巽 与 坎/艮 两对都错位）。先天序 = 乾1兑2离3震4巽5坎6艮7坤8,
      //   出处见 64i/bagua_annotations/bagua_axioms.js 头部 + 64i/provenance.js。
      // 兼容：基础卦guaId=1~8/29~30/51~52/57~58，复合卦guaId=3~28/31~50/53~56/59~64
      let baseTrigramName = hex.trigrams && hex.trigrams.lower_name;
      let xianTianDir = '';
      let houTianDir = '';
      if (baseTrigramName && this.baguaAnnotations) {
        const xian = this.baguaAnnotations.getXiantian(s.guaId);
        const hou = this.baguaAnnotations.getHoutian(s.guaId);
        xianTianDir = xian ? xian.direction : '';
        houTianDir = hou ? hou.direction : '';
      }
      // 京房纳甲 —— 走**真纳甲层**(2026-10-22 第 33 批)。
      //   以前这里是 `hex.najia` 的天干+地支, 而那字段不是纳甲表(见上面 require 的注释)。
      //   这里只给**真纳甲的初爻一柱**(这一层是给 skill 摘要用的单值);
      //   完整六爻干支在 `hexagram_lookup` 的 `yao_ganzhi` 里。
      //   万一装不出纳甲就 null, 不用那个机械循环的值顶 —— 顶上去就是在编。
      //   (第 41 批补齐八卦地支后 384/384 都装得出, 走不到; 但分支必须留着。)
      const najiaFirst = (function () {
        const r = NAJIA.getYaoGanzhi(s.guaId, 1);
        return r.ok ? r.ganzhi : null;
      })();
      const jingfang = najiaFirst || '';
      // 爻辞：取对应爻的原文
      const yaoCi = hex.yao_ci && yaoNum >= 1 && yaoNum <= 6 ? hex.yao_ci[yaoNum - 1] : '';
      const ret = {
        name: s.name,
        guaId: s.guaId,
        guaName: s.guaName,
        guaMeaning: s.guaMeaning,
        symbol: hex.symbol || '',
        yao: yao,
        yaoPos: yaoPos,
        wuxing: hex.elements || '',
        // 第 46 批: 卦德带身份标签(象义整理, 非典籍原文)。
        //   ⚠️ 标签放**值后面**: guaDe 的值本身是纯数据(给程序判等用的),
        //   标签只对**人/模型读的文本**有意义, 混进值里会让等值判断失效。
        //   这里它是给人看的展示字段, 所以带标签没问题 ——
        //   但要记住: 真要判等就别拿这个字段。
        guaDe: (hex.nature || '') + XIANG_YI_TAG,   // 卦德
        xianTian: xianTianDir,            // 先天方位
        houTian: houTianDir,               // 后天方位
        jingFang: jingfang,               // 京房纳甲(初爻一柱); 本卦装不出时为空
        jingFangNote: najiaFirst
          ? '真纳甲初爻; 完整六爻干支见 hexagram_lookup 的 yao_ganzhi'
          : '本卦六爻地支真源没有, 装不出纳甲(别自己展开)',
        yaoCi: yaoCi,                     // 爻辞
        jueCi: s.jueCi || '',             // 决策提示
        bagong: hex.bagong || '',
        triggerCount: s.triggers.length,
        toolCount: s.tools.length,
      };
      return ret;
    });
  }

  // ============================================================
  // 匹配
  // ============================================================

  /**
   * matchSkills — 从用户输入匹配候选skill（按匹配度排序）
   * @param {string} input - 用户输入
   * @param {object} [opts]
   * @param {number} [opts.limit] - 最多返回数量，默认5
   * @param {number} [opts.guaId] - 64卦路由输出的guaId，用于加权同类卦的skill
   * @returns {Array<{ skill, score, reasons }>}
   */
  matchSkills(input, opts = {}) {
    const { limit = 5, guaId = null } = opts;
    if (!input || !this._loaded) return [];

    const candidates = [];
    for (const skill of this.getAllSkills()) {
      if (!skill.matches(input)) continue;

      let score = 0;
      const reasons = [];
      const lower = input.toLowerCase();

      // 触发词命中（精确 + gram模糊）
      for (const trigger of skill.triggers) {
        const t = trigger.toLowerCase();
        if (lower.includes(t)) {
          score += trigger.length * 2; // 精确匹配权重翻倍
          reasons.push(`触发词[精确]: "${trigger}"`);
        } else {
          // gram匹配：输入的任意gram命中触发词
          let gramHit = false;
          for (let i = 0; i < lower.length - 1; i++) {
            const gram = lower.slice(i, i + 2);
            if (t.includes(gram)) { gramHit = true; break; }
          }
          if (gramHit) {
            score += 1; // gram命中给1分（触发词有 score>0 才进候选）
            reasons.push(`触发词[gram]: "${trigger}"`);
          }
        }
      }

      // 语义词命中（来自guaMeaning）
      const meaningWords = (skill.guaMeaning || '').split(/[，,\s、]/).filter(w => w.length >= 2);
      for (const word of meaningWords) {
        if (lower.includes(word.toLowerCase())) {
          score += word.length;
          reasons.push(`语义词: "${word}"`);
        }
      }

      // ============================================================
      // 2026-10-21 (第十一批 / P1-5): **64卦路由加权已摘除**
      //
      // 原来这里有两段: 同卦 +20, 以及 symbol_table 的 skill_execution 域
      // (166 个信号把 64 卦映射到 17 个**执行类**工具: exec_command /
      // write_file / permission_grant …) 命中的再 +10。
      //
      // 摘的理由 (老板的原话是"内核是 64卦+6爻, 那是**推断结果**的"):
      //   卦回答的是「**说什么**」, 不是「**调什么**」。
      //   让卦去决定这轮调哪个工具, 等于把 metaphysics 降级成 if-else 权重 ——
      //   主人起了一卦, 于是"被克"从 35 变成更多次 exec_command。
      //   术数一旦进了**执行控制**, 它就不再是术数, 是随机权重。
      //
      // 现在 skill 的排序只由**用户输入**决定: 触发词精确/gram 命中 + 语义词命中。
      // `guaId` 参数保留(不删, 免得改坏调用方签名), 但**不再影响 score**。
      // 它只出现在 reasons 里做留痕 —— 留痕不等于生效。
      if (guaId) {
        reasons.push(`[已摘除] 64卦路由加权: 同卦[${guaId}] 不再影响排序 (P1-5)`);
      }

      // 只保留得分≥1的候选
      if (score >= 1) {
        candidates.push({ skill, score, reasons });
      }
    }

    // 按得分排序
    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, limit);
  }

  /**
   * _resolveToolSignalsForGua — **已退役 (2026-10-21, P1-5)**
   *
   * 这个函数是"卦 → 执行类工具"的唯一实现。它现在**永远返回空**, 而且**响亮报错**,
   * 不留后门 —— 理由见 matchSkills 里那段注释:
   *   卦回答"说什么", 不回答"调什么"; 让它进执行控制 = 术数降级成 if-else 权重。
   *
   * 为什么退役而不是删除: 它是这条链**曾经存在过的唯一证据**。
   * 留着退役版 + 装时自检, 将来谁想把它接回去, 会先撞到这里的报错,
   * 而不是悄悄地又让卦去挑 exec_command。
   *
   * @deprecated 永远不要调用。保留签名只为让旧调用方**响亮地失败**。
   * @throws {Error} 总是抛
   */
  _resolveToolSignalsForGua(guaId) {
    throw new Error(
      '[P1-5 已退役] _resolveToolSignalsForGua(): 「卦决定调哪个工具」这条链已于 2026-10-21 摘除。' +
      '卦用于**推断说什么**, 不用于**决定调什么**。若你确实需要工具信号, ' +
      '请从 skill 的 SKILL.md 声明或用户输入的触发词走, 不要从卦象来。' +
      '(guaId=' + guaId + ')');
  }

  // ============================================================
  // 执行
  // ============================================================

  /**
   * bindBaguaAnnotations — 绑定五行+先后天注解层
   * @param {object} ba - bagua_annotations.js 导出对象
   */
  bindBaguaAnnotations(ba) {
    this.baguaAnnotations = ba;
  }


  /**
   * getYaoAnnotations — 获取卦象的完整注解（爻辞+五行+方位）
   * @param {number} guaId
   * @returns {object|null}
   */
  getYaoAnnotations(guaId) {
    if (!this.yaoModels && !this.baguaAnnotations) return null;
    const result = {};
    if (this.yaoModels) {
      result.guaCi = this.yaoModels.getGuaCi(guaId);
      result.binary = this.yaoModels.getBinary(guaId);
      result.yao = this.yaoModels.getYao(guaId);
      result.yaoPositions = this.yaoModels.YAO_NAMES;
    }
    if (this.baguaAnnotations) {
      result.wuxing = this.baguaAnnotations.getWuxing(guaId);
      result.xiantian = this.baguaAnnotations.getXiantian(guaId);
      result.houtian = this.baguaAnnotations.getHoutian(guaId);
    }
    return result;
  }

  /**
   * 获取某卦的完整爻数据（含卦辞+6爻爻辞）
   * @param {number} guaId
   * @returns {object|null}
   */
  getYaoContext(guaId) {
    if (!this.yaoModels) return null;
    try {
      const yao = this.yaoModels.getYao(guaId);
      const guaCi = this.yaoModels.getGuaCi(guaId);
      const binary = this.yaoModels.getBinary(guaId);
      if (!yao) return null;
      const result = {
        guaId,
        guaCi,
        binary,
        yao: yao,  // [爻1, 爻2, ..., 爻6]
        yao1: yao[0], yao2: yao[1], yao3: yao[2],
        yao4: yao[3], yao5: yao[4], yao6: yao[5],
      };
      // ✅ 附加五行+先后天注解
      if (this.baguaAnnotations) {
        result.wuxing = this.baguaAnnotations.getWuxing(guaId);
        result.xiantian = this.baguaAnnotations.getXiantian(guaId);
        result.houtian = this.baguaAnnotations.getHoutian(guaId);
      }
      return result;
    } catch (e) { console.warn('[SkillRuntime] getGuaAnnotation error:', e.message); return null; }
  }

  /**
   * executeSkill — 执行指定skill
   * @param {string} skillName - skill名称（卦名）
   * @param {object} context - 执行上下文 { input, params, memory? }
   * @returns {Promise<{ ok, result?, error?, meta }>}
   */
  async executeSkill(skillName, context = {}) {
    const skill = this._skills.get(skillName);
    if (!skill || !skill.loaded) {
      return { ok: false, error: { code: 'SKILL_NOT_FOUND', skill: skillName } };
    }

    const { input = '', params = {} } = context;
    const start = Date.now();
    const results = [];
    const guaId = params.guaId || skill.guaId || null;

    // ============================================================
    // 构建 skillContext（384爻数据注入）
    // ============================================================
    let enrichedContext = { ...context };
    // 从环境变量注入 _gatewayUrl（供 send_wechat 等工具使用）
    enrichedContext._gatewayUrl = process.env.PANGU_GATEWAY_URL || process.env.GATEWAY_URL || '';
    if (guaId && this.yaoModels) {
      const yaoCtx = this.getYaoContext(guaId) || {};
      enrichedContext.skillContext = {
        ...yaoCtx,
        tools: skill.tools.map(t => ({
          toolName: t.toolName,
          toolParams: t.params,
          signal: this._resolveSignalForTool(t.toolName, guaId),
        })),
        decisionHint: skill.jueCi || '',
      };
    }

    try {
      const flowName = params.flow || Object.keys(skill.flows)[0];
      const toolDefs = skill.flows[flowName]
        ? skill.tools.filter(t => skill.flows[flowName].includes(t.guaId))
        : skill.tools;

      for (const toolDef of toolDefs) {
        const signalInfo = this.resolveToolByGua(guaId, { action: toolDef.toolName });
        const toolFn = this.tools[toolDef.toolName];
        if (!toolFn) {
          // 2026-10-23 第 62 批: 原来这里**静悄悄** SKIP 掉 ——
          //   技能里声明了工具, 但注册表里没有, 于是那一步就没了,
          //   而主人只看到「结果少了一段」, 查不到是哪一步掉的。
          //   这跟 2026-10-22 那个半死进程是同一类病: **降级不留痕**。
          //
          //   为什么以前没炸: pangu-single 建 SkillRuntime 时只传了 skillsDir,
          //   没传 tools ⇒ this.tools 恒为 {} ⇒ 任何声明了工具的技能都会掉。
          //   而实测磁盘上 5 个技能**没有一个声明 toolName**, 所以这条路径
          //   目前**没被触发** —— 是潜在缺口, 不是活 bug (别把它说成后者)。
          //   但只要哪天有人写第一个带工具的技能, 就会踩进来。
          //   所以: 留痕 + 说明注册表为什么是空的, 让下一个人 5 秒内看懂。
          console.warn('[skill_runtime] 工具未注册, 该步已跳过: tool=' + toolDef.toolName
            + ' skill=' + (skill && (skill.name || skill.id) || skillName || '?')
            + ' (注册表条目数=' + Object.keys(this.tools || {}).length
            + ' —— 生产建实例时没传 tools, 见 pangu-single.js createSkillRuntime)');
          results.push({ guaId: toolDef.guaId, tool: toolDef.toolName, status: 'SKIP', reason: 'tool not registered' });
          continue;
        }

        try {
          const mergedParams = { ...params };
          if (toolDef.params && toolDef.params.length > 0) {
            const firstParam = toolDef.params[0];
            if (typeof firstParam === 'string' && !firstParam.includes('=')) {
              mergedParams.cmd = firstParam;
            } else {
              for (const p of toolDef.params) {
                const [k, v] = p.split('=').map(s => s.trim());
                if (k) mergedParams[k] = v !== undefined ? v : true;
              }
            }
          }
          const toolContext = {
            ...enrichedContext,
            skillContext: enrichedContext.skillContext,
            signal: signalInfo.signal || null,
            signalEssence: signalInfo.essence || '',
          };
          const toolResult = await toolFn({ context: toolContext, params: mergedParams, skill, guaId: toolDef.guaId });
          results.push({ guaId: toolDef.guaId, tool: toolDef.toolName, signal: signalInfo.signal || null, status: 'OK', result: toolResult });
        } catch (err) {
          results.push({ guaId: toolDef.guaId, tool: toolDef.toolName, signal: signalInfo.signal || null, status: 'ERROR', error: err.message });
        }
      }

      const costMs = Date.now() - start;
      return {
        ok: true,
        skill: skill.name,
        guaId: skill.guaId,
        flow: flowName || 'default',
        results,
        meta: { cost_ms: costMs, toolCount: toolDefs.length },
      };
    } catch (err) {
      return { ok: false, error: { code: 'EXEC_ERROR', message: err.message }, meta: { cost_ms: Date.now() - start } };
    }
  }

  /**
   * _resolveSignalForTool — **已退役 (2026-10-21, P1-5)**
   *
   * @deprecated 永远不要调用。保留签名只为让旧调用方**响亮地失败**。
   * @throws {Error} 总是抛
   */
  _resolveSignalForTool(toolName, guaId) {
    throw new Error(
      '[P1-5 已退役] _resolveSignalForTool(): 「卦决定调哪个工具」已于 2026-10-21 摘除。' +
      '(tool=' + toolName + ' guaId=' + guaId + ')');
  }

  /**
   * executeByGua — **已退役 (2026-10-21, P1-5)**
   *
   * 这是整条链上**最危险**的一个: 它让一个卦号直接顶到 skill 执行。
   *
   * @deprecated 永远不要调用。返回失败而不是 throw —— 调用方拿到的仍是合法结果对象,
   *   但 code 明确写着 GUA_EXEC_RETIRED, 不会静默执行。
   */
  async executeByGua(guaId, context = {}) {
    void context;
    return {
      ok: false,
      error: {
        code: 'GUA_EXEC_RETIRED',
        guaId,
        message: '「卦 → 直接执行 skill」已于 2026-10-21 退役 (P1-5)。' +
          '卦用于推断说什么, 不用于决定执行什么。要用 skill 请按名字调用 (invoke/executeSkill)。',
      },
    };
  }

  /**
   * invoke — executeSkill 的别名，供 commander.js 调用
   */
  async invoke(skillName, context = {}) {
    return this.executeSkill(skillName, context);
  }

  // ============================================================
  // 工具注册
  // ============================================================

  /**
   * registerTool — 注册工具实现
   * @param {string} name - 工具名（来自SKILL.md的toolName）
   * @param {function} fn -  async (ctx) => {}  ctx = { context, params, skill, guaId }
   */
  registerTool(name, fn) {
    this.tools[name] = fn;
  }

  /**
   * registerTools — 批量注册工具
   * @param {object} tools - { toolName: fn }
   */
  registerTools(tools) {
    for (const [name, fn] of Object.entries(tools)) {
      this.tools[name] = fn;
    }
  }

  /**
   * bindSymbolTable — 绑定64卦本体表，用于卦象→工具的语义映射
   * @param {object} symbolTable - symbol_table.js 的导出对象
   */
  bindSymbolTable(symbolTable) {
    this._symbolTable = symbolTable;
  }

  /**
   * resolveToolByGua — **已退役 (2026-10-21, P1-5)**
   *
   * 函数名就是这个模块要戒掉的东西: **通过卦ID解析该调哪个工具**。
   * 现在它**永远返回 tool: null**, 并带退役说明, 不静默给工具名。
   *
   * @deprecated 永远不要调用。
   * @param {number} guaId - 卦ID (1-64)
   */
  resolveToolByGua(guaId, context = {}) {
    void context;
    return {
      retired: true,
      signal: null,
      tool: null,
      hexagrams: [guaId],
      essence: '',
      signalEssence: '',
      message: 'resolveToolByGua() 已于 2026-10-21 退役 (P1-5): 卦不再决定调哪个工具。',
    };
  }

  /**
   * autoRegisterTools — **已退役 (2026-10-21, P1-5)**
   *
   * 它按 skill_execution 信号空间注册 17 个**执行类**工具桩
   * (exec_command / write_file / permission_grant …), 每个桩都绑着一组卦号。
   * 也就是说: 一旦接回去, **卦就直接等于执行权限**。
   * 现在它是 no-op, 返回 0 并说明原因 —— **不注册任何东西**。
   *
   * @deprecated 永远不要调用。
   * @param {object} symbolTable
   * @returns {number} 恒为 0(注册数量)
   */
  autoRegisterTools(symbolTable) {
    void symbolTable;
    return 0;
  }
}

// ============================================================
// 工厂函数
// ============================================================

function createSkillRuntime(options = {}) {
  return new SkillRuntime(options);
}

 // 2026-08-16 P1-D: getSkill 支持 alias, listSkills 输出 metadata 摘要
SkillRuntime.prototype.getSkill = function(nameOrAlias) {
  if (!nameOrAlias) return null;
  // 直接名
  if (this._skills.has(nameOrAlias)) return this._skills.get(nameOrAlias);
  // alias
  if (this._aliases.has(nameOrAlias)) {
    const real = this._aliases.get(nameOrAlias);
    return this._skills.get(real) || null;
  }
  return null;
};

SkillRuntime.prototype.listSkills = function() {
  const out = [];
  for (const [name, skill] of this._skills.entries()) {
    out.push({
      name,
      version: skill.version,
      aliases: skill.aliases || [],
      gua_id: skill.guaId,
      gua_name: skill.guaName,
      triggers: (skill.triggers || []).slice(0, 5),
      loaded_at: skill.loaded_at,
      tools_count: (skill.tools || []).length,
      flows: Object.keys(skill.flows || {}),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
};

module.exports = { SkillRuntime, Skill, createSkillRuntime, _SKILL_RUNTIME_VERSION: '2026.08.16' };

// ============================================================
// 装时自检 (2026-10-21, P1-5)
// ============================================================
//
// 这条链是**静默**的: 上面那些退役函数在今天之前全都正常返回, 不报错、不告警,
// 也没有任何测试守着。所以必须有一条装时断言 —— 否则半年后又有人接回去,
// 而且是在"卦决定调哪个工具"这种最不该发生的地方。
//
// 判据: **本文件里不允许出现把 guaId 加进 score 的活代码**。
// 允许出现的是:
//   - 注释和 JSDoc 里提到 guaId
//   - 退役函数里 throw / return 的说明文字
//   - reasons 里那条 [已摘除] 留痕(纯字符串, 不改 score)
// 禁掉的是 `score +=` 紧跟在 guaId 判断之后的形态。
function _assertNoGuaToExecutionCoupling() {
  const fs = require('fs');
  const src = fs.readFileSync(__filename, 'utf8');
  // ⚠️ 扫之前先剥注释 —— 这条判据**自己写在注释里**就含 `if (guaId`,
  //    而它的规则原文里又含 `score +=`, 不剥就会**自己把自己判成违规**
  //    (2026-10-21 实测踩到: 那行注释直接让 require 崩了)。
  //    顺序有讲究: **先去跨行块注释(JSDoc), 再去行注释(//)**, 反过来剥不干净。
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const lines = code.split('\n').map(l => l.replace(/\/\/.*$/, ''));
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/if\s*\(\s*guaId\b/.test(lines[i])) continue;
    const win = lines.slice(i, i + 12).join('\n');
    if (/score\s*\+=/.test(win)) {
      hits.push('L' + (i + 1) + ': ' + lines[i].trim());
    }
  }
  if (hits.length) {
    throw new Error(
      '[P1-5] 又有人把卦接回 skill 排序了 —— 卦不该决定"调什么"。命中:\n  ' +
      hits.join('\n  ') +
      '\n卦回答"说什么", 不回答"调什么" (2026-10-21 摘除)。');
  }
}
_assertNoGuaToExecutionCoupling();

// ⚠️ **这条自检的上限, 如实写明** (不假装万无一失):
//   它扫的是「`if (guaId …)` 之后 12 行内有没有 `score +=`」。
//   实测(2026-10-21): 紧挨着注入 → 抓到; 垫 8 行填充 → 仍抓到;
//   垫超过 12 行 → **逃得掉**。
//   也就是说它挡的是「顺手加一段加权」这种真实会发生的事, 挡不住刻意重构。
//   **它是护栏, 不是锁** —— 别因为有它在, 就以为这条链再也回不来了。
//
// 单独导出, 便于喂负例(与 assertKeywordsAligned / _assertYinyangLayer 同一做法)
module.exports._assertNoGuaToExecutionCoupling = _assertNoGuaToExecutionCoupling;
