/**
 * Checker - 检查者
 * 职责: 评/验/测结果
 * 权限: 读文件、跑测试、验证输出
 * 边界: 不改代码、不执行新任务
 */
const fs = require('fs');
const path = require('path');
class Checker {
  async execute(task, context) {
    // 兼容旧测试脚本输入: { output: '...', criteria: [...], type: 'code' }
    if (task && typeof task === 'object' && !task.type) {
      if (task.output !== undefined && task.criteria !== undefined) {
        task = { type: 'security_scan', output: task.output };
      } else if (task.filePath !== undefined) {
        task = { type: 'review_code', filePath: task.filePath };
      } else if (task.testPath !== undefined) {
        task = { type: 'run_tests', testPath: task.testPath };
      } else if (task.path !== undefined) {
        task = { type: 'review_code', filePath: task.path };
      } else if (task.goal !== undefined) {
        task = { type: 'security_scan', output: task.goal };
      }
    }

 // 修: 兼容 pangu-single dispatch 路由的输入 { type: 'default', goal, context }
    if (task && typeof task === 'object' && task.type === 'default' && task.goal !== undefined) {
      const goal = task.goal || '';
      if (task.path || goal.toLowerCase().includes('file') || goal.toLowerCase().includes('code')) {
        task = { type: 'review_code', filePath: task.path || goal };
      } else if (goal.toLowerCase().includes('test')) {
        task = { type: 'run_tests', testPath: goal };
      } else {
        task = { type: 'security_scan', output: goal };
      }
    }

    switch (task.type) {
      case 'verify_output':
        return await this.verifyOutput(task.expected, task.actual);
      case 'run_tests':
        return await this.runTests(task.testPath, context);
      case 'lint_code':
      case 'lint':
        return await this.lintCode(task.filePath || task.path, context);
      case 'review_code':
      case 'review':
        return await this.reviewCode(task.filePath || task.path, context);
      case 'security_scan':
      case 'code':
      case 'check':
      case 'scan':
        return await this.securityScan(task.output || task.code || task.actual || task.text || task.goal, context);
      default:
        // 兜底：只要输出/代码/文本存在，就做安全扫描
        if (task.output || task.code || task.actual || task.text || task.goal) {
          return await this.securityScan(task.output || task.code || task.actual || task.text || task.goal, context);
        }
        return { ok: false, error: `Unknown check type: ${task.type}` };
    }
  }

  async verifyOutput(expected, actual) {
    const match = JSON.stringify(expected) === JSON.stringify(actual);
    return {
      ok: match,
      summary: match ? 'Output matches expected' : 'Output mismatch',
      data: { expected, actual, diff: this.diff(expected, actual) }
    };
  }

  async runTests(testPath, context) {
    const { TOOLS } = require(path.join(__dirname, '..', 'modules', 'tools'));
    try {
      const result = await TOOLS.exec_command({
        context: { user: 'feng' },
        params: { command: `cd ${process.env.PANGU_HOME || path.resolve(__dirname, '..', '..', '..')} && npm test -- ${testPath}` }
      });
      const passed = result.data && result.data.exit === 0;
      return {
        ok: passed,
        summary: passed ? 'All tests passed' : 'Tests failed',
        data: result.data
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async lintCode(filePath, context) {
    const { TOOLS } = require(path.join(__dirname, '..', 'modules', 'tools'));
    try {
      const result = await TOOLS.exec_command({
        context: { user: 'feng' },
        params: { command: `npx eslint ${filePath} 2>&1 || true` }
      });
      const hasErrors = result.data && result.data.stdout && result.data.stdout.includes('error');
      return {
        ok: !hasErrors,
        summary: hasErrors ? 'Lint errors found' : 'Lint clean',
        data: result.data
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async reviewCode(filePath, context) {
    const { TOOLS } = require(path.join(__dirname, '..', 'modules', 'tools'));
    try {
      // L4: 保存 metadata (filePath, hash, lineCount, sizeBytes) 不只是 content.data
      const text = await TOOLS.read_file({
        context: { user: 'feng' },
        params: { path: filePath }
      });

      const content = (text && text.data) ? (typeof text.data === 'string' ? text.data : JSON.stringify(text.data)) : '';
      const issues = [];
      const lines = content.split('\n');
      const metadata = {
        filePath,
        lineCount: lines.length,
        sizeBytes: Buffer.byteLength(content, 'utf8'),
        sha256: require('crypto').createHash('sha256').update(content).digest('hex'),
      };

      lines.forEach((line, idx) => {
        if (line.length > 120) issues.push({ line: idx + 1, issue: 'Line too long' });
        if (line.includes('console.log') && !line.includes('//')) issues.push({ line: idx + 1, issue: 'Leftover console.log' });
        if (line.includes('TODO') || line.includes('FIXME')) issues.push({ line: idx + 1, issue: 'Unresolved TODO' });
      });

      return {
        ok: issues.length === 0,
        summary: issues.length === 0 ? 'Code review passed' : `${issues.length} issues found`,
        data: { issues, metadata }  // L4: metadata 暴露给后续 reporter/diff 工具
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async securityScan(code, context) {
    const issues = [];
    const lines = (code || '').split('\n');
    const patterns = [
      { regex: /\beval\s*\(/, issue: 'Use of eval() is dangerous', severity: 'critical' },
      { regex: /\.innerHTML\s*=/, issue: 'innerHTML can introduce XSS', severity: 'high' },
      { regex: /password\s*=\s*["'][^"']+["']/, issue: 'Hardcoded password', severity: 'critical' },
      { regex: /\bexec\s*\(/, issue: 'Potential command injection via exec()', severity: 'high' },
      { regex: /document\.write\s*\(/, issue: 'document.write can introduce XSS', severity: 'medium' },
    ];

    lines.forEach((line, idx) => {
      patterns.forEach(p => {
        if (p.regex.test(line)) {
          issues.push({ line: idx + 1, issue: p.issue, severity: p.severity });
        }
      });
    });

    return {
      ok: issues.length === 0,
      pass: issues.length === 0,
      summary: issues.length === 0 ? 'Security scan clean' : `${issues.length} security issues found`,
      score: issues.length === 0 ? 100 : Math.max(0, 100 - issues.length * 20),
      issues
    };
  }

  diff(expected, actual) {
    const expStr = JSON.stringify(expected, null, 2);
    const actStr = JSON.stringify(actual, null, 2);
    return expStr === actStr ? null : `Expected:\n${expStr}\n\nActual:\n${actStr}`;
  }
}

module.exports = new Checker();
module.exports.DuiAgent = Checker;
