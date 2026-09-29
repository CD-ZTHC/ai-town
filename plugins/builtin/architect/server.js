// 内置插件：世界架构师。居民聊出来的建设点子（对话结束钩子）和导演、访客、管理员的意图都交给它。
import { Architect } from './architect.ts';

export default {
  setup(town, api) {
    town.architect = new Architect(town);
    api.on('tick', () => town.architect.tick());
    // 居民聊出来的建设点子交给世界架构师（每天最多一个）
    api.on('conversation.end', ({ a, res }) => {
      if (typeof res?.idea === 'string' && res.idea.trim().length >= 4) town.architect.enqueue(res.idea, `agent:${a.id}`);
    });
  },
  teardown(town) { town.architect = null; },
};
