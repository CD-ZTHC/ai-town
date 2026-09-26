// 内置插件：施工（从 server/worldai/proposals.js 迁出）。
// 内核只负责「提案获批 → 落地」；有新建筑的提案由本插件接管：搭脚手架、给负责施工的居民排上日程，
// 并把提案标为 building、写好完工时间，到点后由内核落地。以后「先备料再开工」「建筑会慢慢破旧」之类的玩法，
// 都可以写成新插件挂在同样的钩子上，不用修改内核。
import { fmtTime } from '../../../server/memory.js';

export function startConstruction(town, p) {
  const { site, hours, by } = p.construction;
  p.status = 'building';
  p.finishT = Math.floor(town.t) + hours * 60;
  town.spawnStructure('scaffold', { x: site.x + site.w / 2 - 0.5, y: site.y + site.h - 1, inside: null }, hours * 60);
  const start = Math.floor(town.minute) + 10;
  const workers = [];
  for (const name of by) {
    const a = town.agents.find((x) => x.name === name || x.id === name);
    if (!a || a.kind === 'creature') continue;
    if (site.near && start < 22 * 60 && town.addCommitment(a, { time: fmtTime(start), duration: Math.min(hours * 60, 22 * 60 - start), location: site.near, activity: `施工：${p.title}`, emoji: '🚧' }, '（小镇的建设任务）')) workers.push(a.name);
  }
  town.log('proposal', `🚧 「${p.title}」开工了${workers.length ? `，${workers.join('、')}负责施工` : ''}，预计 ${fmtTime(p.finishT)} 完工`, {});
  town.emit('proposals');
}

export default {
  setup(town, api) {
    api.on('proposal.approved', (p) => {
      if (!p.construction) return false;
      startConstruction(town, p);
      return true;
    });
  },
};
