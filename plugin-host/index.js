// 插件宿主（自主演化设计 §3、§5）：内核与插件之间唯一的接口层。
// - 内置插件（plugins/builtin/）：人工维护，进程内运行，可以直接使用小镇对象
// - AI 插件（plugins/evolved/）：见 evolved.js，数据类以规格覆盖层叠加，代码类在沙箱子进程里运行
import { builtins } from './builtin.js';
import { registerEffect, registerExprFn } from './registry.js';
import { get as setting } from '../server/settings/index.ts';

export class PluginHost {
  /**
   * @param {import('../server/sim.ts').Town} town
   * @param {{ disable?: string[] }} [opts] disable：不加载的内置插件（测试或排查用，也可用环境变量 PLUGINS_DISABLE=a,b）
   */
  constructor(town, opts = {}) {
    this.town = town;
    this.list = [];
    const disable = new Set(opts.disable ?? setting('PLUGINS_DISABLE'));
    for (const b of builtins) {
      if (disable.has(b.id)) continue;
      b.mod.setup(town, this.api(b.id));
      this.list.push({ id: b.id, kind: 'builtin', manifest: b.manifest, status: 'active' });
    }
  }

  /** 内置插件拿到的接口（可信代码，可以直接操作小镇） */
  api(id) {
    const town = this.town;
    return {
      id,
      on: (event, fn) => town.hooks.on(event, fn, id),
      registerEffect: (name, def) => registerEffect(name, def, id),
      registerExprFn: (name, impl, doc) => registerExprFn(name, impl, doc, id),
      log: (text) => town.log('plugin', text, { plugin: id }),
    };
  }

  has(id) { return this.list.some((p) => p.id === id && p.status !== 'disabled'); }

  view() {
    return this.list.map((p) => ({ id: p.id, kind: p.kind, title: p.manifest.title, summary: p.manifest.summary, version: p.manifest.version, tier: p.manifest.tier, status: p.status, errors: this.town.hooks.errors[p.id] || 0 }));
  }

  stop() {
    for (const b of builtins) b.mod.teardown?.(this.town);
  }
}
