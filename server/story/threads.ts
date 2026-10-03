// 剧情线程看板：记录每条伏笔的状态（open / advanced / resolved）与进展，供导演、日报和前端使用
import type { Town } from '../sim.ts';
import type { Thread } from '../types/spec.ts';

export type ThreadStatus = 'open' | 'advanced' | 'resolved';
/** 一条线程的进展（存档 threadState[id]） */
export interface ThreadState { status: ThreadStatus; notes: Array<{ t: number; text: string }> }
export function threadState(town: Town, id: string): ThreadState {
  return (town.threadState[id] ||= { status: 'open', notes: [] });
}

export function advanceThread(town: Town, id: string, status: ThreadStatus, note = ''): boolean {
  const def = town.spec.threads!.find((t) => t.id === id);
  if (!def) return false;
  const st = threadState(town, id);
  if (st.status === 'resolved') return false;
  st.status = status;
  if (note) st.notes.push({ t: Math.floor(town.t), text: note });
  if (st.notes.length > 8) st.notes.shift();
  const owners = def.owners!.filter((o) => town.byId[o]);
  town.log('thread', `${status === 'resolved' ? '🎀 伏笔回收' : '🧵 剧情推进'}「${def.title}」${note ? `：${note}` : ''}`, { agents: owners, thread: id, status });
  town.emit('story');
  return true;
}

export function threadList(town: Town): Array<Thread & ThreadState> {
  return town.spec.threads!.map((t) => ({ ...t, ...threadState(town, t.id) }));
}

/** 写进导演提示词的线程摘要 */
export function threadsBlock(town: Town): string {
  return threadList(town).map((t) => `- [${t.id}]「${t.title}」（${{ open: '未展开', advanced: '进行中', resolved: '已回收' }[t.status]}）${t.hook}${t.notes.length ? `；最近：${t.notes.at(-1)!.text}` : ''}`).join('\n');
}
