/**
 * 状态同步器
 * 职责: 维护全局状态, 角色间状态同步
 */
class StateSync {
  constructor() {
    this.states = new Map();      // role -> state
    this.history = [];            // 操作历史
    this.subscribers = new Map(); // role -> callback
  }

  // 注册角色
  register(role, initialState = {}) {
    this.states.set(role, {
      status: 'idle',     // idle | running | completed | failed
      progress: 0,        // 0-100
      result: null,
      error: null,
      startedAt: null,
      completedAt: null,
      ...initialState
    });
  }

  // 更新状态
  update(role, updates) {
    const state = this.states.get(role);
    if (!state) return false;
    
    Object.assign(state, updates);
    
    // 记录历史
    this.history.push({
      timestamp: Date.now(),
      role,
      updates
    });
    
    // 通知订阅者
    this.notify(role, state);
    
    return true;
  }

  // 订阅状态变化
  subscribe(role, callback) {
    if (!this.subscribers.has(role)) {
      this.subscribers.set(role, []);
    }
    this.subscribers.get(role).push(callback);
  }

  // 通知订阅者
  notify(role, state) {
    const callbacks = this.subscribers.get(role) || [];
    callbacks.forEach(cb => {
      try { cb(state); } catch (e) { /* ignore */ }
    });
  }

  // 获取状态
  get(role) {
    return this.states.get(role);
  }

  // 获取所有状态
  getAll() {
    const result = {};
    this.states.forEach((state, role) => {
      result[role] = state;
    });
    return result;
  }

  // 等待角色完成
  async waitFor(role, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const check = () => {
        const state = this.states.get(role);
        if (!state) return reject(new Error(`Role ${role} not registered`));
        if (state.status === 'completed') return resolve(state.result);
        if (state.status === 'failed') return reject(new Error(state.error));
      };
      
      check();
      const interval = setInterval(check, 100);
      
      setTimeout(() => {
        clearInterval(interval);
        reject(new Error(`Timeout waiting for ${role}`));
      }, timeout);
    });
  }

  // 重置
  reset() {
    this.states.clear();
    this.history = [];
    this.subscribers.clear();
  }
}

module.exports = new StateSync();
