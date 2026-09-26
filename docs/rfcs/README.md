# 需求文档（RFC）

这里是**给人实现**的需求文档。自主演化（[设计方案](../design/autonomous-evolution.md)）上线后，AI 心愿单里的大部分需求由进化引擎自动实现成插件（`plugins/evolved/`）；只有需要修改内核的需求（T3），以及维护者想亲手实现的需求，才会走这里。

## 两条路

```
运行中的 AI 发现缺口 ──► AI 心愿单（🛠 建设 → 🧩 AI 心愿单）
        │
        ├─► 进化引擎（evolution/，自动）：需求文档 → 需求评审 → 实施 → 多轮评审 → 安全终审 → 影子试运行
        │        ├─ T0 / T1 / T2：做成插件，交给表决 / 管理员 / AI 裁决官决定是否上线（🧬 进化）
        │        └─ T3（需要改内核）：只写需求文档到 data/evolution/rfcs/，等人实现
        │
        └─► mise run evolve:rfc（手动）：把缺口整理成 docs/rfcs/NNNN-*.md，由维护者实现为内置插件
```

## 常用命令

```bash
mise run evolve:rfc                  # 处理已采纳、还没有文档的缺口（最多 3 个）
node tools/evolve.js --all           # 也处理未处理的缺口（按出现次数）
node tools/evolve.js --offline       # 不调用 LLM，只生成带数据的骨架
node tools/evolve.js --dry-run       # 只看会生成什么
mise run manifest                    # 重新生成 docs/capabilities.md
```

缺口与文档的对应关系记在 `data/evolve.json`，管理面板会显示「已有需求文档」。

## 实现为内置插件

内置插件放在 `plugins/builtin/<名字>/`：`plugin.json`（id、版本、说明）+ `server.js`。启动时自动加载，在进程内运行，可以使用小镇对象：

```js
// plugins/builtin/my-feature/server.js
import { registerEffect } from '../../../plugin-host/registry.js';
import { checkTarget, resolveTargets } from '../../../server/kernel/effects.js';

// 效果是进程级的全局注册：在模块加载时注册一次
registerEffect('myEffect', {
  doc: '{"op":"myEffect",…} 一句话说明（会进入能力清单，AI 据此使用）',
  check(args, spec) { /* 校验并限制所有参数范围，返回错误文本或 null */ },
  apply(town, ctx, args) { /* 只通过小镇已有的方法修改状态 */ },
}, 'my-feature');

export default {
  // 每个小镇实例调用一次：订阅钩子（tick / hour / dayStart / agent.arrive / conversation.end / proposal.* / avatar.arrive / story.beat）
  setup(town, api) { api.on('hour', ({ hour }) => { /* … */ }); },
};
```

扩展只能新增、不能覆盖内核已有的能力；缺少说明、名字冲突或加载失败都会让服务直接启动失败。修改 `plugins/builtin/` 属于冻结区改动，完成后运行 `mise run core:lock`。

## 已有文档

| 编号 | 标题 | 状态 |
| --- | --- | --- |
| [0001](0001-go-to.md) | 让居民立刻动身前往指定地点（效果 `goTo`） | ✅ 已实现（`plugins/builtin/go-to/`） |
