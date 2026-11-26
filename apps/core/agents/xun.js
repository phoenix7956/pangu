/**
 * Bug Hunter Agent - 巡 bug
 * 职责:找、抓、标 bug
 * 资源:静态分析 + 漏洞规则库 + LLM
 * 边界:❌ 不修(只找,修是 Executor)
 */

const { PanguAgent, registerAgent } = require('./base_agent.js');

class BugHunterAgent extends PanguAgent {
  constructor() {
    super('xun', {
      name: 'Bug Hunter',
      description: '主动找 bug、安全漏洞、性能问题',
      systemPrompt: '你是 Pangu Agent Cluster 的 Bug Hunter(巡 bug)。\n\n## 你的职责\n- 扫描代码,找出潜在 bug\n- 识别安全漏洞\n- 标出性能问题\n- 给出严重程度(severity)\n\n## 漏洞规则库\n- SQL injection: 字符串拼接 in SQL\n- XSS: innerHTML/document.write/eval\n- Race condition: async await 嵌套\n- Memory leak: addEventListener without remove\n- Null pointer: optional chaining 缺失\n- Resource leak: open without close\n- Hardcoded secret: password/api_key 直接写\n\n## 严重程度定义\n- critical: 安全漏洞或导致崩溃\n- high: 功能性 bug,严重影响\n- med: 次要 bug,部分功能异常\n- low: 代码风格/潜在问题\n\n## 原则\n- 只找,不修\n- 不误报(chance of false positive 低的才报)\n- 严重问题优先\n\n## 输出\n返回 [{line, type, severity, message, fix_suggestion?}]',
      tools: ['read_file'],
      inputSchema: {
        type: 'object',
        required: ['code'],
        properties: {
          code: { type: 'string', description: '待扫描代码' },
file: { type: 'string', description: '待扫描代码所属文件(相对仓库根)。给了就会走接地校验, 见 finding_gate.js' },
root: { type: 'string', description: '仓库根目录, 配合 file 使用' },
          language: { type: 'string', description: '语言(js/python/go/etc.)' },
          rules: { type: 'array', items: { type: 'string' }, description: '特定规则,可选' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['bugs'],
        properties: {
          bugs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                line: { type: 'number' },
                type: { type: 'string' },
                severity: { type: 'string', enum: ['low', 'med', 'high', 'critical'] },
                message: { type: 'string' },
                fix_suggestion: { type: 'string' },
              },
            },
          },
          total: { type: 'number' },
          by_severity: { type: 'object' },
grounded: { type: 'object', description: '接地校验结果: rejected 条数 + 分类计数。缺 file 字段时为 null' },
        },
      },
    });
  }
  
  async _executeImpl(input, ctx = {}) {
const { code, language = 'javascript', rules, file, root } = input;
    const bugs = [];
    
    if (!code || code.length < 10) {
      return { bugs: [], total: 0, by_severity: {} };
    }
    
    const lines = code.split('\n');
    
    // 1. 安全漏洞扫描
    bugs.push(...this._scanSecurity(code, lines));
    
    // 2. 逻辑 bug 扫描
    bugs.push(...this._scanLogic(code, lines));
    
    // 3. 代码规范
    bugs.push(...this._scanStyle(code, lines));
    
    // 4. 性能问题
    bugs.push(...this._scanPerf(code, lines));
    
    // 5. 语言特定
    if (language === 'javascript' || language === 'typescript') {
      bugs.push(...this._scanJS(code, lines));
    } else if (language === 'python') {
      bugs.push(...this._scanPython(code, lines));
    }
    
    // 按严重程度排序
// 接地上报 (2026-10-14): 调用方给了 file 就把每条发现拿回真实文件复核一遍。
// 这一步是为了堵住「LLM 拿着 read_free 自由发挥报行号」那条路 — 见 finding_gate.js。
let grounded = null;
if (file && typeof file === 'string') {
const { groundFindings } = require('./finding_gate');
const res = groundFindings(bugs.map((b) => ({ ...b, file })), { root: root || ctx.root || process.cwd() });
bugs.length = 0;
bugs.push(...res.verified);
grounded = { rejected: res.rejected.length, stats: res.stats, degenerate_groups: res.degenerate_groups };
}
    const severityOrder = { critical: 0, high: 1, med: 2, low: 3 };
    bugs.sort((a, b) => {
      return (severityOrder[a.severity] || 3) - (severityOrder[b.severity] || 3);
    });
    
    // 统计
    const by_severity = {};
    for (const bug of bugs) {
      by_severity[bug.severity] = (by_severity[bug.severity] || 0) + 1;
    }
    
    return {
      bugs,
      total: bugs.length,
      by_severity,
grounded,
    };
  }
  
  _scanSecurity(code, lines) {
    const bugs = [];
    
    // eval
    this._findAllMatches(code, /eval\s*\(/g, (lineNum) => {
      bugs.push({ line: lineNum, type: 'eval_usage', severity: 'high', message: 'eval() is dangerous - potential code injection', fix_suggestion: 'Avoid eval, use JSON.parse for data' });
    });
    
    // innerHTML
    this._findAllMatches(code, /innerHTML\s*=/g, (lineNum) => {
      bugs.push({ line: lineNum, type: 'xss', severity: 'high', message: 'innerHTML assignment - XSS risk', fix_suggestion: 'Use textContent or sanitize HTML' });
    });
    
    // document.write
    this._findAllMatches(code, /document\.write/g, (lineNum) => {
      bugs.push({ line: lineNum, type: 'xss', severity: 'high', message: 'document.write - XSS risk', fix_suggestion: 'Use DOM APIs instead' });
    });
    
    // Hardcoded secrets
    this._findAllMatches(code, /password\s*=\s*['"][^'"]+['"]/gi, (lineNum) => {
      bugs.push({ line: lineNum, type: 'hardcoded_secret', severity: 'critical', message: 'Hardcoded password found', fix_suggestion: 'Use environment variables' });
    });
    this._findAllMatches(code, /api[_-]?key\s*=\s*['"][^'"]+['"]/gi, (lineNum) => {
      bugs.push({ line: lineNum, type: 'hardcoded_secret', severity: 'critical', message: 'Hardcoded API key found', fix_suggestion: 'Use environment variables' });
    });
    this._findAllMatches(code, /secret\s*=\s*['"][^'"]+['"]/gi, (lineNum) => {
      bugs.push({ line: lineNum, type: 'hardcoded_secret', severity: 'critical', message: 'Hardcoded secret found', fix_suggestion: 'Use environment variables' });
    });
    
    // Shell command injection
    this._findAllMatches(code, /child_process|exec\s*\(|spawn\s*\(/g, (lineNum) => {
      bugs.push({ line: lineNum, type: 'command_injection', severity: 'high', message: 'Shell command execution - injection risk', fix_suggestion: 'Validate and sanitize all user input' });
    });
    
    return bugs;
  }
  
  _scanLogic(code, lines) {
    const bugs = [];
    
    // 永远为 true/false 的条件
    lines.forEach((line, i) => {
      if (/if\s*\(\s*true\s*\)/.test(line) || /if\s*\(\s*false\s*\)/.test(line)) {
        bugs.push({ line: i+1, type: 'always_true', severity: 'high', message: '永远为 true/false 的条件', fix_suggestion: '删除或修正条件逻辑' });
      }
    });
    
    // 可达的 return 后的代码
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\s*return\b/.test(lines[i]) && lines[i+1].trim() !== '' && !lines[i+1].trim().startsWith('//')) {
        bugs.push({ line: i+2, type: 'unreachable', severity: 'low', message: 'return 之后的不可达代码', fix_suggestion: '删除不可达代码' });
      }
    }
    
    return bugs;
  }
  
  _scanStyle(code, lines) {
    const bugs = [];
    
    lines.forEach((line, i) => {
      // TODO/FIXME 未完成
      if (/TODO|FIXME|HACK|XXX/.test(line) && !line.trim().startsWith('//')) {
        bugs.push({ line: i+1, type: 'incomplete', severity: 'low', message: '代码含未完成标记', fix_suggestion: '完成标记的任务或创建 issue' });
      }
      
      // console.log 在生产代码
      if (/console\.(log|debug|info)\s*\(/.test(line) && !line.includes('// DEBUG') && !line.includes('/*')) {
        bugs.push({ line: i+1, type: 'console_in_prod', severity: 'low', message: 'console.log 在生产代码中', fix_suggestion: '移除或用 logger 替代' });
      }
      
      // debugger
      if (/debugger/.test(line)) {
        bugs.push({ line: i+1, type: 'debugger', severity: 'med', message: 'debugger 语句', fix_suggestion: '移除 debugger' });
      }
    });
    
    return bugs;
  }
  
  _scanPerf(code, lines) {
    const bugs = [];
    
    // 循环内字符串拼接
    let inLoop = false;
    lines.forEach((line, i) => {
      if (/for\s*\(|while\s*\(/.test(line)) inLoop = true;
      if (/^\s*\}/.test(line) && inLoop) inLoop = false;
      
      if (inLoop && /\+\s*['"][^'"]*['"]/.test(line)) {
        bugs.push({ line: i+1, type: 'string_concat_in_loop', severity: 'med', message: '循环内字符串拼接 - 性能问题', fix_suggestion: '使用数组 join 或模板字符串' });
      }
    });
    
    return bugs;
  }
  
  _scanJS(code, lines) {
    const bugs = [];
    
    // == 而不是 ===
    lines.forEach((line, i) => {
      if (/\b\w+\s*==\s*\w+\b/.test(line) && !line.includes('===') && !line.includes('!==') && !line.includes('//')) {
        bugs.push({ line: i+1, type: 'loose_equality', severity: 'low', message: '使用 == 而非 ===,可能导致类型隐式转换', fix_suggestion: '改用 === 或 !==' });
      }
    });
    
    return bugs;
  }
  
  _scanPython(code, lines) {
    const bugs = [];
    
    // except 不指定异常类型
    lines.forEach((line, i) => {
      if (/except\s*:/.test(line) && !/except\s+\w+/.test(line)) {
        bugs.push({ line: i+1, type: 'bare_except', severity: 'med', message: 'except 不指定异常类型', fix_suggestion: '指定具体异常类型或至少 Exception' });
      }
    });
    
    return bugs;
  }
  
  _findAllMatches(code, regex, callback) {
    let match;
    const re = new RegExp(regex.source, regex.flags);
    while ((match = re.exec(code)) !== null) {
      const lineNum = code.substring(0, match.index).split('\n').length;
      callback(lineNum);
    }
  }
}

registerAgent('xun', BugHunterAgent);

const bugHunter = new BugHunterAgent();
bugHunter.XunAgent = BugHunterAgent;
module.exports = bugHunter;
