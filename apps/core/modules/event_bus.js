/**
 * 盘古事件流总线 (EventBus)
 * 基于发布-订阅模式的事件通信中心
 */

class EventBus {
  constructor() {
    this.listeners = new Map();
    this.onceFlags = new Set();
  }

  /**
   * 订阅事件
   * @param {string} event - 事件名称
   * @param {Function} callback - 回调函数
   * @returns {Function} 取消订阅的函数
   */
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);

    // 返回取消订阅函数
    return () => this.off(event, callback);
  }

  /**
   * 订阅一次性事件
   * @param {string} event - 事件名称
   * @param {Function} callback - 回调函数
   */
  once(event, callback) {
    const wrappedCallback = (...args) => {
      try {
        callback(...args);
      } catch (error) {
        console.error(`EventBus once callback error in "${event}":`, error);
      } finally {
        this.off(event, wrappedCallback);
      }
    };
    this.on(event, wrappedCallback);
  }

  /**
   * 取消订阅
   * @param {string} event - 事件名称
   * @param {Function} callback - 回调函数
   */
  off(event, callback) {
    if (!this.listeners.has(event)) return;
    const callbacks = this.listeners.get(event);
    const index = callbacks.indexOf(callback);
    if (index > -1) {
      callbacks.splice(index, 1);
    }
  }

  /**
   * 发布事件
   * @param {string} event - 事件名称
   * @param  {...any} args - 传递给回调的参数
   */
  emit(event, ...args) {
    if (!this.listeners.has(event)) return;
    const callbacks = [...this.listeners.get(event)];
    callbacks.forEach(callback => {
      try {
        callback(...args);
      } catch (error) {
        console.error(`EventBus error in event "${event}":`, error);
      }
    });
  }

  /**
   * 清除事件的所有监听器
   * @param {string} event - 事件名称
   */
  clear(event) {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }

  /**
   * 获取事件监听器数量
   * @param {string} event - 事件名称
   * @returns {number}
   */
  listenerCount(event) {
    return this.listeners.has(event) ? this.listeners.get(event).length : 0;
  }
}

// 导出工厂函数（用于依赖注入/多实例场景）
function createEventBus() {
  return new EventBus();
}

module.exports = { createEventBus };
module.exports.default = new EventBus();
