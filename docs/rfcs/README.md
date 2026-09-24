# 需求文档（RFC）

这里的需求文档大多来自小镇里的 AI：叙事导演和世界架构师在运行中想做、但现有能力做不到的事，会被记进「AI 心愿单」（能力缺口）。

## 流程

```
运行中的 AI 发现缺口 ──► AI 心愿单（管理面板「🛠 建设 → 🧩 AI 心愿单」）
        │                        │ 管理员「采纳」
        ▼                        ▼
  相似缺口自动合并计数     mise run evolve ──► docs/rfcs/NNNN-*.md（有 LLM 时由强模型撰写，否则生成骨架）
                                             │ 维护者补全、评审
                                             ▼
                          在 server/ext/ 实现 + 测试 ──► 人工审核合并
                                             │
                                             ▼
                          能力清单自动更新（mise run manifest）──► 世界架构师开始使用新能力
```

按项目决定，**这条流水线只生成文档，不写代码、不开 PR**；实现与合并始终由人完成。运行中的服务器不持有代码仓库的写权限，也不会加载未合并的代码。

## 常用命令

```bash
mise run evolve                      # 处理已采纳、还没有文档的缺口（最多 3 个）
node tools/evolve.js --all           # 也处理未处理的缺口（按出现次数）
node tools/evolve.js --offline       # 不调用 LLM，只生成带数据的骨架
node tools/evolve.js --dry-run       # 只看会生成什么
mise run manifest                    # 重新生成 docs/capabilities.md
```

缺口与文档的对应关系记在 `data/evolve.json`，管理面板会显示「已有需求文档」。

## 在扩展点上实现

新能力放在 `server/ext/*.js`，启动时自动加载：

```js
import { registerEffect, registerExprFn } from './registry.js';
import { checkTarget, resolveTargets } from '../kernel/effects.js';

registerEffect('myEffect', {
  doc: '{"op":"myEffect",…} 一句话说明（会进入能力清单，AI 据此使用）',
  check(args, spec) { /* 校验并限制所有参数范围，返回错误文本或 null */ },
  apply(town, ctx, args) { /* 只通过小镇已有的方法修改状态 */ },
});

registerExprFn('myFn', ({ town, real }, e) => /* 只读，返回普通值 */ 0, 'myFn(e) 说明');
```

扩展只能新增、不能覆盖内核已有的能力；缺少说明、名字冲突或加载失败都会让服务直接启动失败。

## 已有文档

| 编号 | 标题 | 状态 |
| --- | --- | --- |
| [0001](0001-go-to.md) | 让居民立刻动身前往指定地点（效果 `goTo`） | ✅ 已实现 |
