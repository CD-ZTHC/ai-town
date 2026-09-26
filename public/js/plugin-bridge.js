// AI 插件面板的桥（运行在 sandbox iframe 里，由小镇提供，不是插件代码）。
// iframe 没有 allow-same-origin，CSP 禁止一切网络请求；插件面板只能通过这里拿到公开的小镇状态、调用自己的接口。
(() => {
  const waits = new Map();
  const listeners = [];
  let seq = 0;
  let state = null;
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const m = e.data || {};
    if (m.type === 'state') { state = m.state; for (const fn of listeners) { try { fn(state); } catch (err) { console.warn(err); } } }
    if (m.type === 'result' && waits.has(m.id)) {
      const w = waits.get(m.id);
      waits.delete(m.id);
      m.ok ? w.resolve(m.result) : w.reject(new Error(m.error || '调用失败'));
    }
  });
  const town = Object.freeze({
    onState(fn) { if (typeof fn === 'function') { listeners.push(fn); if (state) fn(state); } },
    call(route, body = null) {
      const id = ++seq;
      window.parent.postMessage({ type: 'call', id, route: String(route), body }, '*');
      return new Promise((resolve, reject) => waits.set(id, { resolve, reject }));
    },
  });
  Object.defineProperty(window, 'town', { value: town });
})();
