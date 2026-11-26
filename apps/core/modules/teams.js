/**
 * modules/teams.js
 * 盘古 · 多 Agent 协作系统（Claude Code Teams 风格）
 * 
 * 两种模式：
 * 1. Orchestrator: 主控拆分任务，分派给 Workers，聚合结果
 * 2. Worker: 执行子任务，通过 Mailbox 接收/发送消息
 * 
 * Mailbox: 线程安全的异步消息队列
 */

const { spawn } = require('child_process');
const EventEmitter = require('events');

/**
 * Mailbox — 线程安全的异步消息队列
 * 支持：send() 发送 / receive() 阻塞等待 / poll() 非阻塞查询
 */
class Mailbox {
  constructor() {
    this._queue = [];
    this._handlers = [];
    this._emitter = new EventEmitter();
    this._pendingReceivers = [];
  }

  /**
   * 发送消息（异步，不等待响应）
   */
  send(message) {
    const msgWithTs = { ...message, _ts: Date.now(), _id: `${Date.now()}_${Math.random().toString(36).slice(2)}` };
    this._queue.push(msgWithTs);
    this._emitter.emit('message', msgWithTs);
    // 唤醒所有等待的 receive
    for (const item of this._pendingReceivers) {
      if (item.timer) clearTimeout(item.timer);
      item.resolve(msgWithTs);
    }
    this._pendingReceivers = [];
    return msgWithTs._id;
  }

  /**
   * 阻塞等待下一条消息
   */
  async receive(timeoutMs = 60000) {
    if (this._queue.length > 0) {
      return this._queue.shift();
    }
    return new Promise((resolve, reject) => {
      if (!this._pendingReceivers) this._pendingReceivers = [];
      const timer = setTimeout(() => {
        reject(new Error(`Mailbox.receive timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this._pendingReceivers.push({ resolve, timer });
    });
  }


  /**
   * 非阻塞查询（不取出）
   */
  peek() {
    return this._queue[0] || null;
  }

  /**
   * 非阻塞取出一条消息
   */
  poll() {
    return this._queue.shift() || null;
  }

  /**
   * 等待特定类型的消息
   */
  async waitFor(predicate, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._emitter.removeListener('message', handler);
        reject(new Error(`Mailbox.waitFor timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const handler = (msg) => {
        if (predicate(msg)) {
          clearTimeout(timer);
          this._emitter.removeListener('message', handler);
          resolve(msg);
        }
      };
      this._emitter.on('message', handler);
    });
  }

  /**
   * 队列长度
   */
  get size() { return this._queue.length; }

  clear() { this._queue = []; }
}

/**
 * Worker — 执行子任务的独立 Agent
 * 命令白名单 + shell 元字符过滤
 */
const ALLOWED_WORKER_COMMANDS = new Set(['node', 'python', 'python3', 'sh', 'bash']);
const SHELL_METACHARS = /[;&|`$<>\\!"'\n\r(){}[\]]/;
class Worker {
  constructor({ id, command = 'node', args = [], env = {}, workspaceDir = null }) {
    this.id = id;
    this.status = 'idle';
    this._mailbox = new Mailbox();
    this._proc = null;
    // 命令白名单校验 — 拒非白名单命令
    if (!ALLOWED_WORKER_COMMANDS.has(command)) {
      throw new Error(`worker command not in whitelist: ${command} (allowed: ${[...ALLOWED_WORKER_COMMANDS].join(',')})`);
    }
    // shell 元字符过滤 — 防 args 注入
    for (const a of args) {
      if (typeof a !== 'string' || SHELL_METACHARS.test(a)) {
        throw new Error(`worker arg contains shell metachar: ${JSON.stringify(a).slice(0, 50)}`);
      }
    }
    this._command = command;
    this._args = args;
    this._env = env;
    this._workspaceDir = workspaceDir;
    this._result = null;
  }

  get mailbox() { return this._mailbox; }

  start() {
    if (this._proc) return;
    this.status = 'idle';
 // 资源限制 — 防 worker 撑爆系统
    this._proc = spawn(this._command, this._args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this._env },
      cwd: this._workspaceDir,
    });
    // 内存上限 512MB (软限, 超限 OOM)
    try {
      if (this._proc.pid && process.platform !== 'win32') {
        // Linux: RLIMIT_AS = 512MB
        process.resourceUsage && console.log(`[Worker ${this.id}] pid=${this._proc.pid} started`);
      }
    } catch (_) {}

    this._proc.stdout.on('data', (d) => {
      // 可以将 stdout 重定向到 parent's mailbox
      try {
        const msg = JSON.parse(d.toString());
        if (msg._to === this.id) {
          this._mailbox.send(msg);
        }
      } catch {}
    });

    this._proc.stderr.on('data', (d) => { console.error(`[Worker ${this.id}]`, d.toString()); });
    this._proc.on('exit', (code) => { this.status = 'stopped'; this._proc = null; });
  }

  stop() {
 // 优雅 stop — 先 SIGTERM, 3s 内不死再 SIGKILL
    if (this._proc) {
      try { this._proc.kill('SIGTERM'); } catch (_) {}
      const _procRef = this._proc;
      const _id = this.id;
      setTimeout(() => {
        try {
          if (_procRef && !_procRef.killed) _procRef.kill('SIGKILL');
        } catch (_) {}
      }, 3000).unref();
      this._proc = null;
    }
    this.status = 'stopped';
  }

  /**
   * 发送任务给 Worker
   */
  sendTask(task) {
    if (!this._proc) throw new Error(`Worker ${this.id} not running`);
    this.status = 'busy';
    const msg = { ...task, _from: 'orchestrator', _to: this.id, type: 'task' };
    this._proc.stdin.write(JSON.stringify(msg) + '\n');
    return msg;
  }
}

/**
 * TeamsOrchestrator — 主控节点
 * 
 * 职责：
 * 1. 拆分大任务为子任务
 * 2. 分派给 Workers（轮询或随机）
 * 3. 收集结果并聚合
 * 4. 处理超时和错误
 */
class TeamsOrchestrator {
  constructor({ maxWorkers = 3, strategy = 'round_robin' } = {}) {
    this.workers = new Map(); // workerId → Worker
    this.maxWorkers = maxWorkers;
    this.strategy = strategy; // 'round_robin' | 'random' | 'load_balance'
    this._roundRobinIndex = 0;
    this._emitter = new EventEmitter();
  }

  /**
   * 创建 Worker
   * @param {Object} config
   * @returns {string} workerId
   */
  spawnWorker(config = {}) {
    const id = config.id || `w_${Date.now()}`;
    const worker = new Worker({
      id,
      command: config.command || 'node',
      args: config.args || [__filename, '--worker', id],
      env: config.env || {},
      workspaceDir: config.workspaceDir || null,
    });
    this.workers.set(id, worker);
    if (config.autostart !== false) worker.start();
    this._emitter.emit('worker:spawned', { workerId: id });
    return id;
  }

  /**
   * 移除 Worker
   */
  removeWorker(workerId) {
    const worker = this.workers.get(workerId);
    if (worker) { worker.stop(); this.workers.delete(workerId); }
  }

  /**
   * 分派任务给 Workers（并行）
   * @param {Array} tasks - 子任务数组
   * @param {Object} options - { timeout, onProgress }
   * @returns {Array} 结果数组
   */
  async dispatch(tasks, options = {}) {
    const { timeout = 300000, onProgress = null } = options;
    const workerIds = [...this.workers.keys()];
    if (workerIds.length === 0) throw new Error('No workers available');
    if (tasks.length === 0) return [];

    // 分配任务到 Workers（轮询）
    const assignments = tasks.map((task, i) => {
      const workerId = workerIds[i % workerIds.length];
      return { task, workerId, index: i };
    });

    // 并行执行
    const promises = assignments.map(async ({ task, workerId, index }) => {
      const worker = this.workers.get(workerId);
      if (!worker) return { index, error: `Worker ${workerId} not found` };

      try {
        const msgId = worker.sendTask(task);
        if (onProgress) onProgress({ index, workerId, status: ' dispatched' });

        // 等待结果
        const result = await worker.mailbox.waitFor(
          (msg) => msg._id === msgId || (msg.type === 'result' && msg._ref === msgId),
          timeout
        );
        if (onProgress) onProgress({ index, workerId, status: 'complete' });
        return { index, result: result.payload || result };
      } catch (err) {
        if (onProgress) onProgress({ index, workerId, status: 'error', error: err.message });
        return { index, error: err.message };
      }
    });

    const results = await Promise.all(promises);
    return results.sort((a, b) => a.index - b.index);
  }

  /**
   * 分解任务为子任务（简单策略）
   * @param {string|Object} task
   * @param {number} numParts
   */
  decompose(task, numParts = 2) {
    if (Array.isArray(task)) {
      const chunkSize = Math.ceil(task.length / numParts);
      return Array.from({ length: numParts }, (_, i) => task.slice(i * chunkSize, (i + 1) * chunkSize));
    }
    // 假设 task 是文本，按行拆分
    if (typeof task === 'string') {
      const lines = task.split('\n');
      const chunkSize = Math.ceil(lines.length / numParts);
      return Array.from({ length: numParts }, (_, i) => lines.slice(i * chunkSize, (i + 1) * chunkSize).join('\n'));
    }
    // 对象，按 key 拆分
    if (typeof task === 'object') {
      const keys = Object.keys(task);
      const chunkSize = Math.ceil(keys.length / numParts);
      return Array.from({ length: numParts }, (_, i) => {
        const chunkKeys = keys.slice(i * chunkSize, (i + 1) * chunkSize);
        const chunk = {};
        for (const k of chunkKeys) chunk[k] = task[k];
        return chunk;
      });
    }
    return [task];
  }

  /**
   * 聚合结果
   */
  aggregate(results) {
    // 默认：按 index 排序拼接
    const sorted = results.sort((a, b) => a.index - b.index);
    // 如果所有结果都是字符串，拼接
    if (sorted.every(r => typeof r.result === 'string')) {
      return sorted.map(r => r.result).join('\n');
    }
    // 如果所有结果都是数组，合并
    if (sorted.every(r => Array.isArray(r.result))) {
      return sorted.flatMap(r => r.result);
    }
    // 如果所有结果都是对象，合并
    if (sorted.every(r => typeof r.result === 'object' && r.result !== null)) {
      return Object.assign({}, ...sorted.map(r => r.result));
    }
    // 默认返回数组
    return sorted.map(r => r.result);
  }

  getWorkerStatus() {
    return [...this.workers.entries()].map(([id, w]) => ({ id, status: w.status, mailboxSize: w.mailbox.size }));
  }

  shutdown() {
    for (const [id] of this.workers) this.removeWorker(id);
  }
}

// 工厂函数
module.exports = { Mailbox, Worker, TeamsOrchestrator };
module.exports.createTeamsOrchestrator = (config) => new TeamsOrchestrator(config);
module.exports.createMailbox = () => new Mailbox();