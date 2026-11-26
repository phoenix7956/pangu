/**
 * 角色间消息协议
 * 格式: JSON, 带版本控制
 */
const MESSAGE_VERSION = '2.0.0';

class Message {
  constructor(type, from, to, payload, meta = {}) {
    this.version = MESSAGE_VERSION;
    this.id = this.generateId();
    this.timestamp = Date.now();
    this.type = type;      // request | response | event | error
    this.from = from;      // 发送角色
    this.to = to;          // 接收角色 (broadcast = 所有)
    this.payload = payload;
    this.meta = {
      priority: meta.priority || 'normal',  // critical | high | normal | low
      ttl: meta.ttl || 30000,               // 超时 ms
      retry: meta.retry || 0,               // 重试次数
      ...meta
    };
  }

  generateId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  toJSON() {
    return {
      version: this.version,
      id: this.id,
      timestamp: this.timestamp,
      type: this.type,
      from: this.from,
      to: this.to,
      payload: this.payload,
      meta: this.meta
    };
  }

  static fromJSON(json) {
    return new Message(json.type, json.from, json.to, json.payload, json.meta);
  }
}

// 消息类型常量
const MESSAGE_TYPES = {
  TASK_ASSIGN: 'task.assign',       // 分配任务
  TASK_COMPLETE: 'task.complete',   // 任务完成
  TASK_FAILED: 'task.failed',       // 任务失败
  DATA_REQUEST: 'data.request',     // 请求数据
  DATA_RESPONSE: 'data.response',   // 响应数据
  EVENT_PROGRESS: 'event.progress', // 进度事件
  EVENT_ERROR: 'event.error',       // 错误事件
  SYNC_STATE: 'sync.state'          // 状态同步
};

module.exports = { Message, MESSAGE_TYPES };
