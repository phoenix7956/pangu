const path = require('path');
const fs = require('fs');

/**
 * Executor - 执行者
 * 职责: 写/改/生成 artifact
 * 权限: 调 TOOLS 写文件、跑命令
 * 边界: 不分析、不验证
 */
class Executor {
  async execute(task, context) {
    // 兼容旧测试脚本的输入格式: { task: '...', params: {...} }
    if (task && typeof task === 'object' && !task.type && task.task !== undefined) {
      const goal = task.task || task.goal || '';
      const filePath = task.path || task.file || task.filePath || (task.params && task.params.path);
      if (goal.toLowerCase().includes('hello world') || filePath) {
        task = { type: 'write_file', path: filePath || '/tmp/test_hw.txt', content: goal };
      } else if (goal.toLowerCase().includes('run') || goal.toLowerCase().includes('command')) {
        task = { type: 'run_command', command: goal };
      } else {
        task = { type: 'write_file', path: filePath || '/tmp/test_hw.txt', content: goal };
      }
    }

 // 修: 兼容 pangu-single dispatch 路由的输入 { type: 'default', goal, context }
    if (task && typeof task === 'object' && task.type === 'default' && task.goal !== undefined) {
      const goal = task.goal || '';
      if (goal.toLowerCase().includes('run') || goal.toLowerCase().includes('command')) {
        task = { type: 'run_command', command: goal };
      } else if (task.path || goal.toLowerCase().includes('write') || goal.toLowerCase().includes('file')) {
        task = { type: 'write_file', path: task.path || '/tmp/pangu_output.txt', content: goal };
      } else {
        task = { type: 'write_file', path: '/tmp/pangu_output.txt', content: goal };
      }
    }

    const { TOOLS } = require(path.join(__dirname, '..', 'modules', 'tools'));

    // 兼容: goal 字段可作为 command/content 使用
    const cmd = task.command || task.goal;
    const filePath = task.path || task.file || task.filePath;
    const content = task.content || task.goal;

    switch (task.type) {
      case 'write_file':
        return await this.writeFile(filePath, content, TOOLS);
      case 'edit_file':
        return await this.editFile(filePath, task.oldText, task.newText, TOOLS);
      case 'run_command':
        return await this.runCommand(cmd, TOOLS);
      case 'create_directory':
        return await this.createDir(filePath, TOOLS);
      default:
        return { ok: false, error: `Unknown task type: ${task.type}` };
    }
  }

  async writeFile(filePath, content, TOOLS) {
    try {
      // Bug #6 fix: 不再走 shell heredoc (content 里特殊字符/路径检查绕过风险)
      // 直接 fs 写, 但过 sandbox 路径红线
      const { isPathAllowed } = require(path.join(__dirname, '..', 'modules', 'sandbox'));
      if (!isPathAllowed(filePath)) {
        return { ok: false, error: { code: 'SANDBOX_BLOCKED', message: `path not allowed: ${filePath}`, retryable: false } };
      }
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content == null ? '' : String(content), 'utf8');
      return { ok: true, summary: `Wrote ${filePath}`, data: { path: filePath, bytes: Buffer.byteLength(String(content || '')) } };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async editFile(filePath, oldText, newText, TOOLS) {
    try {
      const result = await TOOLS.file_edit({
        context: { user: 'feng' },
        params: { path: filePath, oldText, newText }
      });
      return { ok: true, summary: `Edited ${filePath}`, data: result };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async runCommand(command, TOOLS) {
    try {
 // 修: 用户输入常带 "run command" 前缀，实际应去掉前缀（支持冒号、中文冒号）
      const realCommand = command.replace(/^\s*(run\s+)?(command\s*)?[:：]?\s*/i, '').trim();
 // 修: exec_command 要求 cwd 在白名单，用 ~/Desktop 作为安全 cwd
      const result = await TOOLS.exec_command({
        context: { user: 'feng' },
        params: { command: realCommand || command, cwd: require('path').join(require('os').homedir(), 'Desktop') }
      });
      return { ok: true, summary: `Ran: ${command}`, data: result };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async createDir(dirPath, TOOLS) {
    try {
      const result = await TOOLS.exec_command({
        context: { user: 'feng' },
        params: { command: `mkdir -p ${dirPath}`, cwd: require('path').join(require('os').homedir(), 'Desktop') }
      });
      return { ok: true, summary: `Created ${dirPath}`, data: result };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}

module.exports = new Executor();
module.exports.KunAgent = Executor;
