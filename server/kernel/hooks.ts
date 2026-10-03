// 钩子总线（自主演化设计 §5.4）：内核只在固定位置「开孔」，插件通过订阅钩子改变行为，而不是修改内核代码。
// 钩子的集合就是「可演化的边界」：新增钩子属于内核变更（T3），只能由人完成。
export const HOOKS = [
  'tick', // (dtGame) 每次模拟推进，仅限进程内的内置插件
  'hour', // ({ day, hour }) 每个游戏整点
  'dayStart', // ({ day }) 新的一天
  'agent.arrive', // ({ agent, locId }) 居民到达地点
  'conversation.end', // ({ a, b, res, convo }) 对话结束
  'proposal.approved', // (proposal) 建设提案获批：返回 true 表示「由我接管」（例如施工流程）
  'proposal.applied', // (proposal) 建设提案落地
  'avatar.arrive', // ({ avatar }) 访客化身到达地点
  'story.beat', // ({ beat }) 叙事导演发出节拍
] as const;
export type HookName = (typeof HOOKS)[number];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (payload: any) => unknown; // TODO(types): 各钩子的负载类型在 B5（Town）之后补

export class HookBus {
  handlers: Record<string, Array<{ fn: Handler; owner: string }>> = Object.fromEntries(HOOKS.map((h) => [h, []]));
  /** owner → 出错次数 */
  errors: Record<string, number> = {};

  on(event: string, fn: Handler, owner = 'kernel'): () => void {
    if (!Object.hasOwn(this.handlers, event)) throw new Error(`未知钩子：${event}`);
    this.handlers[event]!.push({ fn, owner });
    return () => { this.handlers[event] = this.handlers[event]!.filter((h) => h.fn !== fn); };
  }

  off(owner: string): void {
    for (const k of Object.keys(this.handlers)) this.handlers[k] = this.handlers[k]!.filter((h) => h.owner !== owner);
  }

  has(event: string): boolean { return (this.handlers[event]?.length ?? 0) > 0; }

  /** 依次调用所有处理函数；单个插件出错不影响其他插件与内核 */
  emit(event: string, payload?: unknown): unknown[] {
    const out: unknown[] = [];
    for (const h of this.handlers[event] || []) {
      try { out.push(h.fn(payload)); } catch (e) {
        this.errors[h.owner] = (this.errors[h.owner] || 0) + 1;
        console.warn(`[hook] ${h.owner} 处理 ${event} 出错：`, (e as Error).message);
      }
    }
    return out;
  }

  /** 询问是否有插件接管：第一个返回 true 的插件胜出 */
  claim(event: string, payload?: unknown): string | null {
    for (const h of this.handlers[event] || []) {
      try { if (h.fn(payload) === true) return h.owner; } catch (e) {
        this.errors[h.owner] = (this.errors[h.owner] || 0) + 1;
        console.warn(`[hook] ${h.owner} 处理 ${event} 出错：`, (e as Error).message);
      }
    }
    return null;
  }
}
