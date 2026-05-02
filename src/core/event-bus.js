/**
 * Event Bus — Cross-component communication system
 * Decouples modules via publish/subscribe pattern.
 */
export class EventBus {
  constructor() {
    this._listeners = new Map();
  }

  on(event, callback) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(callback);
    return () => this.off(event, callback);
  }

  off(event, callback) {
    const set = this._listeners.get(event);
    if (set) set.delete(callback);
  }

  emit(event, data) {
    const set = this._listeners.get(event);
    if (set) set.forEach(cb => {
      try { cb(data); } catch (e) { console.error(`[EventBus] Error in '${event}':`, e); }
    });
  }

  once(event, callback) {
    const unsub = this.on(event, (data) => { unsub(); callback(data); });
    return unsub;
  }
}

export const bus = new EventBus();
