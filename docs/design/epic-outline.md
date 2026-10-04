# 世界史诗、世界大纲、结局与分级修改 —— 设计方案

> 状态：已实施（2026-10-04，分支 `feat/epic-outline`），实施记录见 §11。
> 相关：[night-watch.md](night-watch.md)（黑暗叙事、威胁与化解）、[multi-world.md](multi-world.md)（世界登记、创世、授权）、[ai-world-evolution.md](ai-world-evolution.md)（世界操作与重放、叙事导演）

## 0. 一句话概括

每个世界都可以有一部**不断续写的小说（史诗）**、一份**会随世界发展调整的计划（大纲）**，以及可选的**结局**；达成结局后世界停止演进、史诗迎来大结局，之后可以开启第二部。世界的**内容分级可以修改**（例如把冒险级的《小红帽》改成黑暗级），修改时由 AI 为世界补齐新分级需要的内容。

四项能力都是**通用的**：内核不出现任何世界专有的名词；官方世界和用户创世的世界拥有同样的能力；没有声明相关字段的世界行为不变。

---

## 1. 总体结构

```
           ┌──────── 世界大纲（计划：未来往哪走）─────────┐
           │  部 → 幕 → 节点        终局分支（好 / 坏结局）   │
           └───▲──────────┬─────────────────▲─────────────┘
     大纲维护：  │          │ 当前幕计划        │ 节点 ↔ 章节 双向链接
   回写进度、    │          ▼                 │
   调整未来      │     叙事导演（只安排局面）     │
                 │          ▼                 │
                 │   世界模拟（规则与骰子决定结果）
                 │          ▼                 │
                 └── 史料账本 ──► 史诗续写（部 → 卷 → 章）
                                    ▲
                     结局判定 ──► 终幕 → 大结局 → 冻结 → （可开第二部）
```

| 层 | 模块 | 存在哪里 |
|---|---|---|
| 史诗 | `server/story/epic.ts` | 存档：`epic`（kv）、`epicNotes`、`epicChapters`（只追加列表） |
| 大纲 | `server/story/outline.ts`、`server/kernel/outline-spec.ts` | 世界包 `outline`（初始）→ 存档 `outline`（运行时）、`outlineRevisions`（只追加） |
| 结局 | `server/story/endings.ts` | 大纲里的 `endings`（运行时以它为准）；存档 `endState` |
| AI 评审闸门 | `server/worldai/review-gate.ts` | 运行时（评审登记 30 分钟有效） |
| 分级修改 | `server/worldai/rerate.ts` + 世界操作 | 世界操作历史（按时间线重放）+ 世界登记 |

- 大纲和结局都**按时间线**存放（在存档里），时间线分支自然得到"另一种未来"。
- 一幕 = 史诗的一卷；一部 = 史诗的一部。

---

## 2. 史诗

### 2.1 配置（世界包 `epic`，全部可选）

```jsonc
"epic": {
  "title": "夜巡录",                       // 默认「<世界名>纪」
  "narrator": "冷峻克制的第三人称都市怪谈",  // 叙事口吻，默认取日报风格
  "chapter": { "everyDays": 5, "minDays": 1, "weight": 12, "words": [1500, 2500] },
  "volumeEveryChapters": 10                 // 没有大纲时按章数分卷
}
```

- 默认对所有世界开启（全站设置 `EPIC`：`on` / `off`；世界设置 `epic: false` 可以单独关闭）。
- 没有模型时不写章节，素材保留到有模型为止。

### 2.2 史料账本 `epicNotes`

- 挂在 `town.log` 上，按类型取权重：具名角色死亡 5、威胁结果（收容 / 化解 / 消灭）4、剧情弧 3、伏笔回收 3、投票 2、宿主 / 阵营 / 幸存 2、人员来去 1、事件 / 线索 / 遭遇 / 世界变化 1……；没有权重的类型不记。结局 10。
- 每天编年时刻之后，再记下当天日报的头条和导语、主要人物当天日记的摘录（提到次数最多的 4 人）。
- 写章节成功后游标前移、已用素材删除；失败时素材保留。账本最多 600 条，超出时丢掉最早的低权重条目。

### 2.3 分章

每天编年时刻之后检查一次（错过时次日补检）：

```
距上一章 ≥ everyDays 且有素材
或 累计权重 ≥ weight 且距上一章 ≥ minDays
或 世界刚刚完结（写大结局）
```

### 2.4 续写

一章一次 smart 调用（标签「撰写史诗」，P2）。提示词：世界设定与支柱、分级写法、叙事口吻、**全书梗概**、**人物志**、上一章结尾、本章素材、未回收的伏笔、大纲里**作者知道的方向**（当前幕计划、接下来的节点；明确要求只埋伏笔、不写未发生的事）。

输出 `{title, body, summary, synopsis, cast, beats}`：
- `synopsis`、`cast` 滚动更新，下一章使用；
- `beats` 是本章推进的大纲节点 id（校验后写入双向链接）。

检查：正文过短重写；命中 `lore.breakers`（例如《夜巡》避开《神秘复苏》的专有名词）或关键词审核时带着问题重写一次，仍不通过则放弃本次、素材保留。

### 2.5 章节

```
{ part, volume, volumeTitle, n, title, body, summary, from, to, beats[], t, ending? }
```

写入只追加列表，之后不再修改。大结局章带 `ending: {id, title, kind}`，正文后附**尾声**（主要角色各自的结局）。

---

## 3. 大纲

### 3.1 结构

```ts
Outline {
  version; premise; theme; autoAdjust;          // 自动调整未来，默认开
  parts: [{ id, title, status, acts: [{          // 部
    id, title, plan, recap?, status, endingRef?, locked?,          // 幕：plan 是计划（未来），recap 是实际经过
    beats: [{ id, text, status, done?, links?, chapters[], locked?, tags? }]  // 节点
  }] }];
  endings: [{ id, title, kind, when, for?, hint?, finale? }];  // 终局分支（§4）
}
```

状态：部 / 幕 `done | active | planned | dropped`；节点 `planned | done | transformed | skipped`。节点的 `done` 是可选的完成条件表达式（例如 `flag('resolved_waiting_mother')`），由规则自动判定。

### 3.2 来源

- 创世流水线新增「大纲」一步：根据设定、人物、伏笔、威胁和命运节点生成第一部（3~6 幕，每幕 3~6 个节点）与 1 个好结局 + 1~2 个坏结局；表达式不合法时带着错误重写一次。
- 官方世界在世界包里手写 `outline.json`（或 `world.json` 的 `outline` 字段）。
- 已有世界没有大纲时，管理者可以一键「生成大纲」：已经发生的事写成已完成的幕，按当前状态规划未来。
- 改编世界的命运节点被吸收为带「原著」标签的节点（导演提示词里的命运节点块保留）。

### 3.3 大纲维护（每写完一章跑一次，标签「大纲维护」）

1. **回写进度**：带 `done` 条件的节点由规则每小时判定；其余由 AI 根据本章判断完成 / 变形 / 跳过，本章编号写进节点的 `chapters`。
2. **推进幕**：本幕讲完时写下 `recap`，下一幕成为进行中，史诗同时分卷。
3. **调整未来**（`autoAdjust` 开启时）：世界偏离计划时改写计划中的幕和节点。**不能动**已完成的内容、锁定的内容和结局条件。

每次调整都经过规则校验，记为一条 `keeper` 修订。

### 3.4 使用者

| 使用者 | 读到什么 |
|---|---|
| 叙事导演 | 当前幕计划、接下来 2~3 个节点、结局进度（只能往这个方向安排局面，没有 `kill`） |
| 史诗作者 | 当前幕计划、下一个节点（只埋伏笔） |
| 居民、日报 | 看不到 |

### 3.5 编辑：AI 辅助、手动编辑、AI 评审

```
AI 辅助（描述怎么改 → 草稿 + 改动说明）─┐
手动编辑（结构化编辑器）────────────────┴─► 提交
   ① 规则校验：结构与长度、id、已完成内容不可改、表达式可编译、引用存在、关键词审核、breakers
   ② AI 评审：与设定 / 正典 / 已发生的事是否矛盾、结局是否可达、节奏、分级、是否在要求导演宣判生死
      → { verdict: pass | revise, issues: [{severity, where, text, suggestion}], patch? }
   pass 或只有 minor：保存；有 major：显示问题与建议（可让 AI 采纳建议后再评审），管理员可以强制保存（记审计）
```

- 评审结果按「草稿哈希 + 基于的版本号」登记，30 分钟有效；保存只接受评审过的同一份草稿。
- 保存时版本号变了（大纲维护刚改过）返回 409。
- AI 辅助、评审记在这个世界名下（所有者的额度）。

### 3.6 防剧透

| 内容 | 所有者 / 管理员 | 其他人 |
|---|---|---|
| 故事前提、已完成的幕（标题、经过、节点、章节链接） | ✅ | ✅ |
| 当前幕 | ✅ 全部 | 只有标题 |
| 计划中的幕、结局、结局进度、修订记录、评审 | ✅ | ❌ |

- `GET /api/outline` 在服务端按身份裁剪；大纲和结局不进 `publicSpec`，SSE 只推「有变化」的信号；修订不进公共动态流。
- 有测试守住：非管理者的响应里不能出现计划、结局。

---

## 4. 结局

```jsonc
"endings": [
  { "id": "dawn", "kind": "good", "title": "长夜尽头", "when": "unresolvedThreats() == 0",
    "hint": "所有的祟都被化解", "finale": { "hours": 18, "text": "临川的最后一盏长明灯熄灭了。" } },
  { "id": "nobody_left", "kind": "bad", "title": "长夜无人", "when": "aliveIn('watch') == 0", "for": 3 }
]
```

- 每个游戏小时判定一次，按顺序先满足的先触发；`for` 要求连续满足 N 天（天数在存档里累计）。
- 新增表达式函数：`unresolvedThreats()`（还没有永久化解的威胁种类数）、`liveThreats()`、`containedThreats()`、`crowdDead()`、`namedDeaths()`、`aliveIn('阵营id', 'hosted'?)`、`chapters()`。
- **终幕**：触发后舞台演出一个时刻，导演和人员流动停止，世界再运行 `finale.hours`（默认 12）游戏小时让居民反应。
- **冻结**：终幕结束后 `endState.ended` 写入存档，主循环不再推进；居民互动、玩家事件返回 409「故事已完结」；世界仍可浏览。史诗写大结局（失败时每小时重试）。世界登记的设置里记下 `ended`，大厅显示「已完结」。
- **第二部**：管理者填一句方向，AI 生成第二部的大纲与新结局（可选：为世界补充新的威胁）→ 评审 → 应用：解除冻结、部 +1、史诗另起一部（第二部第一章带上第一部的梗概与尾声）。新结局在应用时不能已经满足。
- 时间线：可以从结局前的快照分出时间线，写「另一种结局」。

---

## 5. 分级修改

### 5.1 谁能改

- 管理员：任何世界、任何分级。
- 所有者：自己的世界，目标分级必须在被授予的范围内（`dark`、`tragic` 需要显式授予）。官方世界只有管理员。

### 5.2 怎么改：分级适配计划

分级不是一个开关：小红帽的支柱写着「没有人会被吃掉」，大灰狼被设定成「可以被感化」，世界里也没有任何威胁。改分级 = 生成一份**适配计划**，经过评审后作为**世界操作**应用：

| 内容 | 怎么生成 | 落成的世界操作 |
|---|---|---|
| 分级、叙事者 | 用户选择 / AI 建议 | `setMeta` |
| 支柱、背景 | AI 按新分级改写（保留世界的身份） | `setLore`（新） |
| 反派心智 | AI 给出 `alignment / drives / redemption` | `setPersonaTraits`（新） |
| 威胁、负担值、物品、构筑物、能力 | 升到致死分级且世界还没有威胁时，复用创世的威胁生成与规律编译 | `addItem / addStructure / addAbility / addBurden（新）/ addThreat（新）/ setIncidents（新）` |
| 死亡预算 | 致死分级默认 2 / 3 天 | `setParam deathNamed` |
| 大纲 | 应用后让大纲维护按新分级调整未来（一条 `keeper` 修订） | — |

- 计划先在规格副本上逐条试应用（规则校验），再经过 AI 评审（§3.5 的同一个闸门），通过后才应用。
- 应用：逐条 `applyWorldOp`（记入操作历史、按时间线重放、可审计），同时更新世界登记的分级。
- 降级（例如 dark → adventure）：支柱改写；已有威胁保留，运行时按分级把致死结果降为重伤（内核已有）；已死的人不会复活。

### 5.3 一致性

世界登记的 `settings.rating` 是加载时的基础分级，`setMeta` 操作在其后重放；分级修改总是两者一起写，所以重载前后一致。从修改前的快照分出的时间线使用新分级但没有新内容（威胁是可选的）。

---

## 6. 《夜巡》落地

| 项 | 内容 |
|---|---|
| 内核修复 | 化解永久生效：自动刷新、收容泄漏都跳过已化解的种类；化解按**种类**判定，同时清掉镇匣里收容的和寄宿在人身上的同种威胁（宿主的负担值回落、失去它给的能力） |
| 内容 | 其余 6 只祟各补一个「查清来历 → 习得了结执念的能力 → 设旗标」的化解途径（照 `seek_kin` 的写法） |
| 结局 | 好结局「长夜尽头」：`unresolvedThreats() == 0`；坏结局「长夜无人」：夜巡司没有活着的成员连续 3 天；坏结局「临川沦陷」：群众遇害 ≥ 1500 或同时作祟的祟 ≥ 5，连续 2 天 |
| 大纲 | 手写 `outline.json`，第一部五幕 |
| 史诗 | 《夜巡录》，冷峻克制的第三人称 |

---

## 7. API

| API | 权限 | 说明 |
|---|---|---|
| `GET /api/epic`、`/api/epic/:part/:n`、`/api/epic.md` | 所有人 | 目录、单章、整本导出 |
| `GET /api/outline` | 所有人（按身份裁剪） | |
| `POST /api/outline/assist {instruction, baseVersion}` | 管理者 | AI 任务 → 草稿 |
| `POST /api/outline/review {draft, baseVersion}` | 管理者 | AI 任务 → 评审 |
| `POST /api/outline/save {draft, baseVersion, reviewId, force?}` | 管理者（`force` 仅管理员） | |
| `POST /api/outline/generate` | 管理者 | 为没有大纲的世界生成 |
| `GET /api/outline/revisions`、`/api/outline/revisions/:v` | 管理者 | |
| `POST /api/story/sequel {direction, threats?}` → `POST /api/story/sequel/apply {planId}` | 管理者 | 第二部 |
| `POST /api/rating/plan {to, direction?}` → `POST /api/rating/apply {planId, force?}` | 管理者（受授权范围约束） | 分级修改 |
| `POST /api/epic/write` | 管理者 | 有新素材时立刻写一章（AI 任务） |
| `POST /api/outline/auto {on}` | 管理者 | 开关「自动调整未来」（不改内容，不需要评审） |
| `GET /api/rating/options` | 管理者 | 当前分级与可以改成的分级 |
| `GET /api/ai-jobs/:id` | 发起人 | 轮询 AI 任务 |

「管理者」= 这个世界的所有者或全站管理员（与终审人相同）。

## 8. 前端

- 故事面板 **📜 史诗**：部 / 卷 / 章目录、阅读视图、章末「对应大纲」；导出。
- 故事面板 **🗺️ 大纲**：其他人看到「已经历的篇章」；管理者看到完整的树、结局进度、[AI 修改] [手动编辑（JSON / 表单）] [提交评审] [保存]、评审意见、修订记录、[生成大纲]、[开启第二部]、[修改分级]。
- 大厅卡片：「已完结」「第 N 部」徽章。
- 世界设置对话框：分级下拉对所有者开放，选中后跳到分级适配流程。

## 9. 决定

| 问题 | 决定 |
|---|---|
| 《夜巡》结局严格度 | 所有祟都被化解才算（收容不算） |
| 坏结局 | 要 |
| 完结之后 | 允许开启第二部；也可以分时间线 |
| 章节长度与节奏 | 每章 1500~2500 字，每 5 游戏天一章，重大事件可以提前 |
| 评审结果 | 有 major 问题时不能保存；只有 minor 时可以保存；管理员可以强制保存 |
| 公开范围 | 已完成的幕 + 当前幕标题 |
| 自动调整未来 | 默认开启，修订记录可查，所有者可以关闭 |
| 其他世界 | 史诗对所有世界开启；大纲可以随时一键生成；没有结局的世界永不完结 |

## 10. 成本

每章 2 次 smart 调用（续写 + 大纲维护）。游戏里一天约等于现实 24 分钟，按每 5 天一章计，每个世界每个现实日约 20~30 次。AI 辅助、评审、分级适配按需调用。

## 11. 实施记录（2026-10-04）

| 部分 | 文件 |
|---|---|
| 类型 | `server/types/story.ts`（Outline / EndingDef / EpicChapter / EpicState / EndState…）、`server/types/spec.ts`（`epic` / `outline` / `endings`） |
| 校验 | `server/kernel/outline-spec.ts`：大纲与结局的规范化、结构校验、历史不可改（`historyErrors`）、史诗配置；接进 `validateSpec` |
| 表达式 | `server/kernel/effects.ts`、`rules.ts`：`unresolvedThreats / liveThreats / containedThreats / crowdDead / namedDeaths / aliveIn / chapters` |
| 化解 | `server/story/threats.ts`：按种类化解（`resolveType` / `purgeType`），刷新、泄漏、宿主脱出都跳过已化解的种类；从别处设上的 `resolved_*` 标记也会让在外的同种威胁消散 |
| 史诗 | `server/story/epic.ts` |
| 大纲 | `server/story/outline.ts`（规则维护、AI 维护 `afterChapter` / `adjust`、AI 修改、生成、评审、保存、视图） |
| 结局 | `server/story/endings.ts`；主循环里冻结（`sim.ts` 的 `advance`），终幕期间导演与人员流动停下 |
| 第二部 | `server/story/sequel.ts` |
| 评审闸门与后台任务 | `server/worldai/review-gate.ts`（`aiReview`、`ReviewDesk`、`AiJobs`） |
| 分级修改 | `server/worldai/rerate.ts`；新的世界操作 `setLore / addBurden / addThreat / setIncidents / setPersonaTraits`（`server/kernel/ops.ts`），`addItem` 保留 `use` |
| 存档 | `server/sim/state.ts`：`epic / outline / endState`（kv）、`epicNotes / epicChapters / outlineRevisions`（`LIST_FIELDS`，只追加） |
| 接口 | `server/http/story-api.ts`（挂在世界接口下）；大纲的评审 / 保存 / AI 修改请求体上限 96KB；完结后互动接口返回 409 |
| 创世 | `server/genesis/outline.ts` + 流水线 G4 的「大纲与结局」一步（失败不影响创世）；大纲文字参与发布审核 |
| 世界包 | `outline.json`（可选，`server/worlds/pack.ts`）；《夜巡》补了 6 个化解能力、3 个结局、手写大纲、史诗配置 |
| 设置 | 全站 `EPIC`（on / off）；世界设置 `epic`；世界登记的 `settings.ended`（大厅徽章） |
| 前端 | `public/js/ui/epic.js`（史诗目录与阅读、大纲时间线 / 完整树 / 编辑器 / 评审 / 修订、修改分级、开启下一部）、故事面板两个新标签页、大厅徽章、世界设置 |
| 测试 | `test/epic.test.ts`（12 项）；`tools/browser-check.ts` 新增史诗 / 大纲 / 编辑 → 评审 → 保存 / 修改分级的步骤 |

与上文的差异：

- 完结没有新增世界状态（`finished`），而是在世界登记的设置里记 `ended`，世界本身仍然是 public / unlisted，大厅按 `ended` 显示徽章。这样不影响现有的状态机（例如致死分级的官方世界是 unlisted）。
- 分级以世界登记为准：加载时操作历史里的 `setMeta` 重放完之后，再套上世界设置的分级（`Town.withWorldRating`）。AI 分级适配应用时同时写操作历史和世界登记，两者一致；管理员在世界设置里直接切换分级（不做内容适配）也不会被旧的 `setMeta` 覆盖。
- 评审登记与后台 AI 任务只在内存里（30 分钟有效）；服务重启后需要重新评审。
- 一个计划（分级适配、第二部）只能应用到生成它时的同一个世界版本（操作历史长度 + 大纲版本）上。

## 12. 上线后的修复（2026-10-04）

线上反馈：小红帽点了「生成大纲」，AI 处理完成后看不到大纲；改分级之后大纲栏也是空的。

| 问题 | 原因 | 修复 |
|---|---|---|
| 生成大纲后"什么都没有" | 等待期间 SSE 的 `story` 事件让面板整页重画，"处理中"的按钮被换成新的「生成大纲」按钮，看起来像是已经完成；结果回来时面板可能已经换了标签或关掉 | 后台任务记在 `ui.jobs`（也存进 sessionStorage），重画时显示进度条；完成后只在大纲页打开着时弹出编辑器，否则提示去查看；刷新页面后继续等结果 |
| 生成的只是草稿，容易丢 | 草稿只在浏览器内存里，必须评审 + 保存才生效，页面上不明显 | 草稿存在服务端（存档 `outlineDraft`，所有管理者共用一份），AI 生成 / 修改完成后**自动评审**；大纲页显示「有一份未保存的草稿」，编辑器标题是「大纲草稿 · 未保存」；编辑时自动暂存；保存后清空。评审登记仍只在内存里，服务重启后显示为需要重新评审 |
| 偶尔生成出空大纲 | 模型偶尔不按 `{"outline":{…}}` 返回，整理后是空大纲，仍然"合法" | `pickOutline` 兼容各种包法；AI 写出的空大纲算作问题，让模型重写；输出上限提高到 12000 |
| 改分级不产生大纲 | `Rerate.apply` 只在已有大纲时调用 `adjust` | 分级适配计划里附带大纲：没有大纲时按**改动之后的世界**（新支柱、新威胁）生成，已有时调整未来与结局；与世界内容一起评审，应用时一起保存（期间大纲被改动过时改为交给 AI 维护调整） |
| 结局一出来就满足 | 例如没有威胁的世界里 `unresolvedThreats() == 0` 当场成立 | 生成 / 修改时先自检，当场满足的结局让模型重写；提示词里写明 |
| 重置清掉分级修改的内容 | 重置删除整个存档，而世界登记里的分级保留 | 重置时保留分级修改写入的世界操作（`cause.kind = rerate`）与大纲（进度从头开始），史诗和居民的经历清空；重置按钮的提示写明 |

新增接口：`POST /api/outline/draft`（暂存草稿）、`POST /api/outline/draft/discard`；`/outline/generate`、`/outline/assist` 的结果存为草稿并自动评审；`/outline/review` 的结果写回草稿；`/rating/apply` 返回 `outline: saved | adjusting | none`。
