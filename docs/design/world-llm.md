# 按世界配置模型服务（自带密钥） —— 设计方案

> 状态：设计已定稿（2026-09-28），未实施。决策见 §2。
> 相关：[multi-world.md](multi-world.md) §5 账号与授予、§7 统一 AI 调度、§14 设置中心；`docs/settings.md`。

## 0. 一句话概括

每个世界可以**使用服务器的模型**（现在的行为，占用站点额度），也可以**使用自己的模型服务**：接口地址、密钥、服务类型、三档模型，以及其他模型相关设置，不占用站点额度。世界选了自己的模型之后，**世界里的所有模型调用都用它**，包括注册用户和居民的对话；只有内容审核仍然使用服务器的模型。自己的密钥出现致命错误时，**世界暂停**，同时在凭据和世界上标出状态，等主人修好。

密钥属于账号，加密存放，谁都读不回来；世界只引用它。官方世界由管理员配置，管理面板可以改官方世界的**全部世界级设置**，不只是模型。

同时用成熟的 Vercel AI SDK（`ai` + `@ai-sdk/*`）替换 pi-ai，作为 OpenAI 兼容以外的服务商的接入层。

没有做任何配置的世界，以及单机模式，行为都和现在完全一样。

---

## 1. 现状

### 1.1 模型调用链

```
调用点（居民、导演、旅人对话、创世、进化、插件……）
  └─ llm.chat / chatJSON(messages, { label, tier, … })
       └─ enqueue：从 AsyncLocalStorage 取 { worldId, userId }（scheduler/context.js），按 label 定级别 P0~P4
            └─ Scheduler（全站唯一的队列，并发上限 LLM_CONCURRENCY）
                 └─ budgetPolicy.allow：按世界的日额度、全站预算决定能否出队（scheduler/budget.js）
                      └─ rawChat → currentProvider().complete(…)
                           └─ provider 由 LLM_PROVIDER + BASE_URL + API_KEY 决定（全站唯一）
            └─ 结束后写账本 usage(day, world_id, user_id, class, tokens)
```

**调用归属已经有了**：`WorldHost.wire`、HTTP 中间件（`http/app.js:115`）、创世任务、进化 IPC 都已经用 `withContext({ worldId, userId })` 包好。所以调用点不用改签名，就能知道「这是哪个世界的调用」。本方案要做的，是让 `rawChat` 按 `worldId` 选 provider，让调度器按「钥匙」分通道。

### 1.2 现在全站唯一、本方案要拆开的状态（`server/llm.js`）

| 状态 | 现在 | 问题 |
| --- | --- | --- |
| `cached` provider | 全站一个 | 要按世界解析 |
| `jsonMode` / `schemaMode` | 网关不支持时**全站**自动关闭 | 一个用户的网关不支持 JSON 模式，会把服务器自己的 JSON 模式也关掉 |
| `fixes` / `checked`（模型名自动纠正） | 全站 | 用户的模型列表会污染服务器的纠正表 |
| `penalty` / `cooldownUntil` / `backoff`（限流退避） | 全站 | 用户的密钥被限流，会让所有世界一起降速 |
| `stats.enabled` | 全站 | 服务器没配模型、但某个世界自带了模型时，那个世界也会被当成「未配置」 |
| `stats.dayTokens` 与 `LLM_DAILY_TOKENS` | 所有调用都算 | 自带密钥的调用不应占用站点预算 |

`stats.enabled`、`budgetLeft()`、`isBusy()` 在十几处被读取：`sim.js`、`sim/cognition.js`、`story/scene.js`、`worldai/canon.js`、`worldai/council.js`、`worlds/review.js`、`guard.js`、`http/world-api.js`、`http/genesis-api.js`。见 §5.5。

### 1.3 pi-ai 的问题

- 依赖面窄：只有一个维护者，版本号 0.x，接口变动频繁（`llm-pi.js` 里已经要处理 `providers/all`、`api/openai-completions.lazy` 这类内部路径）。
- **无法注入 `fetch`**：它的请求绕过我们的代码，自带模型时做不了连接时的 SSRF 拦截（§7.2）。
- 内置服务商的密钥从服务器环境变量解析（`ANTHROPIC_API_KEY` 等）。用户自带模型时，稍不注意就会白用服务器的钥匙。

### 1.4 官方世界的设置现在改不了

- `PATCH /api/worlds/:id/settings` 已经允许管理员修改任何世界（`authorize(who, 'world.manage', w)`）。但管理面板的「世界」页只有配额和下架，「我的世界」页也只列出自己的世界，所以**官方世界没有任何界面可以改设置**。
- 另外，每次启动时 `registry.ensureOfficial` 会用世界包里的标题和简介覆盖数据库，管理员改了也会被还原。

### 1.5 现在所有与 AI 相关的设置，以及本方案的归属

| 设置 | 含义 | 世界可自配？ | 说明 |
| --- | --- | --- | --- |
| `LLM_PROVIDER` | 服务类型 | ✅ | 选项改为 `openai` / `anthropic` / `google` / `aisdk`，见 §6 |
| `BASE_URL` | 接口地址 | ✅ | 放在凭据里；有地址校验，见 §7.2 |
| `API_KEY` | 密钥 | ✅ | 放在凭据里，加密存放 |
| `MODEL` / `MODEL_FAST` / `MODEL_SMART` | 三档模型 | ✅ | |
| `LLM_CONCURRENCY` | 并发 | ✅（有上限） | 自带通道的并发，不超过管理员设的上限 |
| `LLM_TIMEOUT_MS` | 超时 | ✅（有范围） | 5 秒到管理员设的上限之间 |
| `LLM_DAILY_TOKENS` | 全站每日预算 | ➖ 换成世界自己的「每日上限」 | 用来保护创世者自己的钱包，0 = 不限 |
| `LLM_JSON_MODE` / `LLM_JSON_SCHEMA` | JSON 模式 / 结构化输出 | ✅ | 自动关闭只影响这个通道 |
| `EMBED_MODEL` / `EMBED_BASE_URL` / `EMBED_API_KEY` | 语义检索 | ✅ | 可以引用另一份凭据 |
| `EMBED_TIMEOUT_MS` | embedding 超时 | ✅（有范围） | |
| `EVOLVE_REVIEW_MODEL` / `_BASE_URL` / `_API_KEY` | 进化评审模型 | ✅ | 只在世界开启进化时有意义；可以引用另一份凭据 |
| `EVOLVE_BUDGET` | 进化每日上限 | ➖ 自带时由世界自己的上限约束 | |
| `PACE_WITH_LLM` / `PACE_QUEUE` | 随负载放慢时间 | ❌ | 本来就按世界的积压计算，自带时自然按自己的通道算 |
| `PINNED_BUDGET_SHARE` / `PRIORITY_AGING_MIN` | 站点调度策略 | ❌ | 只管服务器通道 |
| `MODERATE_EVENTS` / `MODERATE_CHAT` | 审核方式 | ❌ | 平台底线，永远用服务器模型 |
| `GENESIS_TOKENS` / `GENESIS_DAILY_WORLD_TOKENS` | 创世与世界的站点额度 | ❌ | 只约束服务器通道；自带时不扣，见 §8 |
| `RATE_CHAT_PER_HOUR` 等频率限制 | 防刷 | ❌ | 与模型无关，照常生效 |
| `LLM_RECORD` | 录制回复（开发用） | ❌ | |

---

## 2. 已确认的决策（2026-09-28）

| # | 决策 | 落在哪里 |
| --- | --- | --- |
| 1 | 密钥放在**账号级**：凭据属于人，世界引用凭据 | §3.1 |
| 2 | 自带密钥出现致命错误时**暂停世界**，并在凭据和世界上标记状态；**不会**悄悄改用服务器模型 | §5.4 |
| 3 | 世界配置了模型，**世界内所有交互都用这个模型**：居民、导演、编年、注册用户与居民的对话、心声、世界里的创世、重新生成、进化、插件、语义检索 | §5.2、§5.6 |
| 4 | **审核使用服务器模型**：内容审核、昵称审核、发布审核、抽样审核 | §5.2 |
| 5 | 用 **Vercel AI SDK** 替换 pi-ai | §6 |
| 6 | 管理员可以配置**官方世界**，范围是全部世界级设置，不只是模型 | §9 |

---

## 3. 数据模型

### 3.1 凭据（`accounts.db` 新表）

```sql
CREATE TABLE llm_credentials (
  id TEXT PRIMARY KEY,              -- c_xxxxxxxx
  owner TEXT NOT NULL,              -- 用户 id；或 'site'（站点凭据，只给官方世界用，管理员管理）
  name TEXT NOT NULL,               -- 「我的 DeepSeek」，≤ 20 字
  provider TEXT NOT NULL,           -- openai | anthropic | google（§6.2）
  base_url TEXT NOT NULL DEFAULT '',
  key_enc TEXT NOT NULL,            -- AES-256-GCM：iv.tag.ciphertext（base64url）
  key_last4 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unchecked', -- unchecked | ok | failing
  fail_code TEXT, last_error TEXT, checked_at INTEGER,
  models TEXT NOT NULL DEFAULT '[]', -- 最近一次测试连接拿到的模型列表（给下拉框用，最多 200 个）
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX llm_credentials_owner ON llm_credentials(owner);
```

- 每个账号最多 `USER_LLM_CREDENTIALS_MAX` 份（默认 5），站点凭据不限。
- 凭据只能改名、换地址、换密钥（换密钥就是整体重写 `key_enc`），或者删除。删除正在被世界使用的凭据时，先列出受影响的世界请用户确认；确认后这些世界进入暂停（原因「凭据已删除」）。
- **引用规则**（每次解析时都校验，不只在保存时）：用户世界只能引用 `owner === world.ownerId` 的凭据；官方世界只能引用 `owner === 'site'` 的凭据。世界被转交、账号被禁用时，引用失效，世界暂停并提示。

### 3.2 世界的 AI 配置（`worlds.settings.ai`，不含任何密钥）

```jsonc
{
  "source": "server",          // server | own
  "credential": "c_ab12cd34",  // source=own 时必填
  "models": { "default": "deepseek-chat", "fast": "", "smart": "deepseek-reasoner" },
  "concurrency": 2,            // 1 ~ USER_LLM_MAX_CONCURRENCY
  "timeoutMs": 150000,
  "jsonMode": true,
  "jsonSchema": false,
  "dailyTokens": 0,            // 自己的每日上限，0 = 不限
  "embed":  { "credential": "", "model": "" },   // credential 为空 = 用主凭据；model 为空 = 不开语义检索
  "review": { "credential": "", "model": "" },   // 进化评审；为空 = 用主凭据和强模型
  "halt": null                 // 暂停状态，见 §5.4：{ code, message, credential, at }
}
```

放在已有的 `worlds.settings` JSON 列里，走已有的 `registry.update`，不需要新列。`settings.ai` 不进世界包，也不进时间线快照（`registry` 本来就不进）。

### 3.3 账本加一个维度

`usage` 表加 `billing TEXT NOT NULL DEFAULT 'server'`（`server` 或 `own`），并加入主键。SQLite 不能修改主键，所以迁移 2 用「建新表 → 复制 → 改名」。

- `Ledger` 的 `byWorld` 按 `billing` 分成两份；`budgetPolicy.pool()`、`level()` 和全站的 `dayTokens` 只看 `server`。
- 「我的世界」页面的用量图用两种颜色区分：站点额度、自己的钥匙。

### 3.4 主密钥

新增启动必需设置 `SECRETS_KEY`（bootstrap、secret，32 字节 base64）。没有配置时，首次启动自动生成 `<DATA_DIR>/secret.key`（权限 0600），并在启动日志里提醒：「备份这个文件，丢失后所有凭据都要重新填写」。

- 加密用 `node:crypto` 的 AES-256-GCM，附加数据（AAD）= `id + owner`，防止把一行的密文挪到另一行去用。
- 更换主密钥：`node tools/rotate-secrets.js`，在一个事务里重写所有 `key_enc`。
- 生产环境建议用环境变量提供 `SECRETS_KEY`，不落盘；否则数据目录被整体拷走时，密钥文件会跟着一起走。这一点写进部署文档。

---

## 4. 原则

1. **不配置就不变。** 默认 `source: 'server'`，现有世界、测试、单机部署都不用改。
2. **钥匙属于人，世界只引用。** 世界的导出、时间线分叉、世界包里永远不会出现密钥。
3. **写进去就读不出来。** 接口、面板、审计、日志、错误信息里只出现末 4 位，管理员也读不到。
4. **通道隔离。** 自带钥匙的调用走自己的队列和并发，限流、JSON 模式降级、模型名纠正都只影响自己。
5. **一个世界，一套模型。** 世界选了自己的模型，世界里的一切都用它；唯一的例外是审核。
6. **出错就停，不偷偷花站点的钱。** 致命错误让世界暂停，而不是悄悄改用服务器模型。
7. **服务器不替用户访问内网。** 所有自带通道的请求都经过 SSRF 校验（§7.2）。

---

## 5. 运行时

### 5.1 配置档（profile）：把 llm.js 的全局状态收进一个对象

```js
// server/llm/profile.js（新）
class Profile {
  key          // 'server' 或 'cred:c_ab12cd34'：通道的身份（按钥匙，不按世界）
  billing      // 'server' | 'own'
  provider     // createProvider(...) 的结果（§6）
  models       // 三档模型，以及 fixes / checked（模型名纠正）
  jsonMode, schemaMode
  penalty, cooldownUntil, backoff            // 限流退避
  sched        // 这个通道自己的 Scheduler 实例（类本身不用改）
  stats        // 这个通道的 calls / ok / errors / inflight / lastError …
  limit()      // 并发上限
  timeoutMs
}
```

- **服务器档**由现有设置生成，行为和今天逐行一致。基本上就是把模块级变量搬进这个对象。
- **自带档**按「凭据 id + 凭据 `updated_at` + 世界 AI 配置的哈希」缓存。凭据或配置改了，下一次调用就换新的，和现在「面板改了地址，下一次调用就换用」的做法一致。
- 通道按**钥匙**区分：同一个人的两个世界用同一把钥匙时，共享并发和限流冷却（上游本来就按钥匙限流）。模型按世界解析：同一把钥匙的不同世界可以用不同的模型。

### 5.2 解析：世界 → 配置档

```js
llm.setProfileResolver(({ worldId, userId, label }) => Profile | { halted } | { unconfigured })  // 服务入口注入
```

规则按顺序：

1. label 在「只用服务器」表里（`内容审核`、`昵称审核`、`发布审核`、`抽样审核`）→ 服务器档。这张表放在 `scheduler/classes.js` 旁边，同样是唯一出处。
2. 没有 worldId、`source !== 'own'`，或者站点关闭了自带模型（`USER_LLM=off`）→ 服务器档。
3. 世界处于暂停（`settings.ai.halt`）→ 直接拒绝（`code: 'HALTED'`），不排队。
4. 凭据不存在，或者违反 §3.1 的引用规则 → 让世界暂停（§5.4），并拒绝这次调用。
5. 其他情况 → 自带档。

创世时世界处于 `drafting`，但登记表里已经有这一行；创世任务在提交时把选择写进 `settings.ai`，同一套解析直接适用。

旅人对话、心声这类由注册用户发起的调用，都在 HTTP 中间件设置的世界上下文里运行，所以自动用世界的模型（决策 3）。发起者的 `userId` 只用于记账和频率限制，不影响选择哪个模型。

### 5.3 调度：多通道

- `llm.js` 维护 `Map<profileKey, Profile>`，每个配置档有自己的 `Scheduler`。
- `enqueue` 先解析配置档，再 `profile.sched.push(job)`；`pump()` 遍历所有配置档，各自按自己的 `limit()` 出队。
- 服务器通道原有的规则（P0 保留位、P3/P4 只用空闲容量、公平轮转）原样保留。自带通道同样适用这些规则，只是容量属于它自己。
- 可选的全局上限 `USER_LLM_TOTAL_CONCURRENCY`（默认 0 = 不限）：所有自带通道合计同时在途的请求数，防止大量自带世界把服务器的 socket 和 CPU 占满。
- 通道空闲 10 分钟、没有排队任务时回收。

`budgetPolicy.allow(job)` 拿到 `job.billing`：

- `server`：和现在完全一样。
- `own`：只检查 `settings.ai.dailyTokens` 和管理员的「暂停 AI」。达到自己上限的 80% / 100% / 120% 时，照搬现有的降级档位：先停导演，再改规则驱动，最后 P0 也停。**这是创世者自己设的钱包保护，不是故障，所以不暂停世界。**

### 5.4 故障：暂停世界并标记状态（决策 2）

**致命错误**会让世界暂停；**临时错误**照现在的方式处理：

| 错误 | 判定 | 影响范围 | 处理 |
| --- | --- | --- | --- |
| 鉴权失败 | 401 / 403，`invalid key`、`unauthorized`、`no access` | 用这份凭据的**所有**世界 | 暂停 |
| 余额不足 | 402，`insufficient`、`balance`、`quota exceeded`（与 429 限流区分开） | 同上 | 暂停 |
| 模型不存在 | 404，`model not found`，并且模型名自动纠正也找不到替代 | 只影响**这个**世界（模型配置属于世界） | 暂停 |
| 地址被 SSRF 校验拒绝 | §7.2 | 用这份凭据的所有世界 | 暂停 |
| 凭据被删除、引用失效 | §3.1 | 这个世界 | 暂停 |
| 持续连不上 | 连续 8 次网络错误或 5xx，并且持续 ≥ 3 分钟 | 用这份凭据的所有世界 | 暂停 |
| 限流 429、单次超时、偶发的 5xx | | | 不暂停：只让这个通道退避、降并发、重试（现有逻辑） |
| 网关不支持 JSON 模式 / json_schema | | | 不暂停：只关闭这个通道的对应开关 |

**暂停时：**

1. 凭据上写 `status='failing'`、`fail_code`、`last_error`。存入之前先脱敏：密钥原文，以及 `sk-`、`Bearer ` 之后的字符串，都替换成 `***`。
2. 每个受影响的世界写入 `settings.ai.halt = { code, message, credential, at }`，并写审计 `world.ai-halt`。
3. 这个通道里属于这些世界的排队任务全部拒绝（`code: 'HALTED'`），在途的请求让它自然结束。
4. 运行中的世界调用 `WorldHost.halt(reason)`：
   - `Town` 不推进时间，也不发起调用。它和「无人观看时休眠」一样停在原地，但有观众也不会唤醒。
   - 广播 `halt` 事件：普通访客看到「这个世界暂停了：AI 服务暂时不可用」；主人和管理员看到具体原因，以及去修复的链接。
   - 世界里的互动接口返回 503，提示世界已暂停。
5. 大厅里的世界卡片显示「暂停中」角标，仍然可以进入观看。**不修改 `registry.status`**：暂停是运行态的，和发布状态机（public / paused / unlisted …）是两回事，预览中的世界同样可以被暂停。
6. 世界被卸载后再加载时，发现 `halt` 就直接进入暂停状态，不会发起任何调用。

**恢复：**

- 主人修改凭据（换密钥、换地址）或世界的模型配置之后，系统自动测试连接；测试通过，就清除所有相关世界的 `halt` 并恢复运行。
- 主人也可以手动点「重试」：测试一次，通过就恢复。
- 只有「持续连不上」这一种情况，系统会每 15 分钟自动探测一次，连通后自动恢复。鉴权和余额问题不会自己好转，所以不自动重试，免得反复打上游。
- 恢复时写审计 `world.ai-resume`，广播 `resume`。

### 5.5 `enabled` 等查询按世界判断

`llm.stats.enabled` 保留为「服务器档是否可用」，给管理面板和启动日志用。新增按当前上下文解析的版本：

```js
llm.enabled()          // 这个世界现在能不能调用模型（暂停中 → false）
llm.budgetLeft()       // 这个配置档的剩余（自带且不限 → Infinity）
llm.isBusy()           // 看这个世界所在的通道
llm.queueSize(worldId) // 世界所在通道的积压
```

§1.2 列出的读取点改为调用 `llm.enabled()` 等；它们本来就运行在世界的上下文里，不需要传参。`guard.js` 和 `worlds/review.js` 是例外：审核只用服务器模型，所以它们继续读服务器档。`http/world-api.js` 里「AI 尚未配置」的 503 改为按世界判断，并且区分「暂停中」。

### 5.6 各子系统

| 子系统 | 怎么用 |
| --- | --- |
| 居民、导演、日报、编年、群体心智、议会、世界架构师、设定考据、AI 裁决官 | 自动（按上下文解析） |
| 与旅人交谈、心声（P0） | 自动；`MAX_QUEUE_FOR_USER` 按世界所在通道的积压判断 |
| 创世、重新生成（P3） | 创世表单多一个「用哪套模型」，写进 `settings.ai`；自带时**不扣** `genesisTokens`，但原文字数、世界数等授予限制照常。创世阶段遇到致命错误时，任务标记失败，原因写明「模型服务出错」，修好凭据后可以一键重跑 |
| 进化引擎（P4） | 已经经 IPC 回到主进程并带着 worldId，自动适用。评审 Agent 读 `settings.ai.review`。`evolution/llm.js` 在模块加载时就固定下来的 `REVIEW` 常量，改为按世界解析。自带时不受 `EVOLVE_BUDGET` 约束，改由 `dailyTokens` 约束 |
| AI 插件的 `llm` 权限 | 自动；插件自己的 `llmTokensPerDay` 仍然生效 |
| 语义检索 | `Town` 创建 `createEmbedder` 时传入世界配置档的连接信息。embedding 请求同样经过 `safeFetch`；遇到致命错误同样暂停世界 |
| 内容 / 昵称 / 发布 / 抽样审核 | 永远用服务器档 |

---

## 6. 模型接入层：用 Vercel AI SDK 替换 pi-ai（决策 5）

### 6.1 选型

| 候选 | 结论 |
| --- | --- |
| **Vercel AI SDK**（`ai` 7.x + `@ai-sdk/*`） | **采用**。Apache-2.0；要求 Node ≥ 22，与本项目一致；每周都在发版，是 JS 生态里使用最广的多服务商接入层。**每个 provider 实例都能传 `apiKey`、`baseURL`、`fetch`**：密钥按请求隔离，SSRF 校验可以注入到所有服务商。`generateText` 支持 `maxRetries: 0`（重试仍由 llm.js 负责）、`abortSignal`、`maxOutputTokens`，结构化输出用 `output: Output.object(...)`，返回 `usage.inputTokens` / `outputTokens` |
| LangChain.js | 不采用：抽象层多、依赖重，本项目只需要「发一次补全」 |
| 各家官方 SDK（`openai`、`@anthropic-ai/sdk` …） | 不采用：每家一套接口，要自己写适配，而且依赖更多 |
| LiteLLM | Python 代理，需要单独部署；可以作为外部网关，通过 OpenAI 兼容类型接入，不进本项目 |

在临时目录实际安装核对过（2026-09-28）：`ai@7.0.118`、`@ai-sdk/openai-compatible@3.0.57`、`@ai-sdk/anthropic@4.0.65`、`@ai-sdk/google@4.0.82`，合计约 32 MB，只依赖 `@ai-sdk/provider`、`provider-utils` 和 `gateway`。

### 6.2 服务类型

| `provider` | 实现 | 适用 |
| --- | --- | --- |
| `openai` | **保留现有的零依赖实现**（`llm-providers.js` 的 `openaiCompatible`），加一个 `fetch` 参数 | 国内外绝大多数网关：DeepSeek、GLM、通义、Kimi、OpenRouter、OpenAI、Ollama、LiteLLM 等 |
| `anthropic` | `@ai-sdk/anthropic`（`createAnthropic({ apiKey, baseURL, fetch })`） | Claude |
| `google` | `@ai-sdk/google` | Gemini |
| `aisdk` | 仅服务器档：`"服务商/模型"` 写法，不同档位可以混用不同服务商，密钥从服务器环境变量读取 | 取代现在的 `LLM_PROVIDER=pi` |

默认路径仍然是零依赖的 `openai`。AI SDK 放在 `optionalDependencies` 里（默认会安装），只在第一次用到 `anthropic`、`google` 或 `aisdk` 时动态加载；没安装时给出明确的安装提示，这和现在 pi-ai 的做法一样。以后要加服务商，只需在 `llm-providers.js` 里注册一个工厂函数。

适配器 `server/llm-aisdk.js` 替换 `llm-pi.js`，实现同一个 provider 接口：

- `complete()`：`generateText({ model, messages, temperature, maxOutputTokens, abortSignal, maxRetries: 0, providerOptions })`。JSON 模式在支持的服务商上用 `Output.object`，不支持的靠提示词约束，并由现有的 `extractJSON` / `repairJSON` 兜底。
- 错误：把 `APICallError` 的 `statusCode` 和上游的原始 `message` 一起带出来，供 §5.4 判定错误类别。
- `listModels()`：`openai` 类型调 `/models`；`anthropic` 和 `google` 调各自的模型列表接口，用于测试连接和模型名纠正。

### 6.3 防止借用服务器的环境变量密钥

AI SDK 在 `apiKey` 缺省时，会读取 `ANTHROPIC_API_KEY`、`GOOGLE_GENERATIVE_AI_API_KEY` 等环境变量（已在源码里确认是 `loadApiKey`）。因此对自带档：

- 构造 provider 时**必须**显式传入凭据里的 `apiKey`；凭据的密钥为空时拒绝保存，也拒绝构造 provider。
- 永远传 provider 实例，**不传字符串模型 id**。字符串会走 AI SDK 的默认全局 provider（Vercel AI Gateway，读 `AI_GATEWAY_API_KEY`）。
- 注入的 `safeFetch` 再检查一遍：请求头里的密钥必须等于凭据的密钥，否则拒绝发出。这是最后一道防线。
- 测试：在服务器环境里放一个假的 `ANTHROPIC_API_KEY`，断言自带档的请求带的是凭据里的钥匙；删掉凭据密钥后，断言根本不会发出请求。

### 6.4 迁移

- `LLM_PROVIDER=pi` 仍然接受一个版本：启动时自动当作 `aisdk`，并打印一条弃用警告。`"服务商/模型"` 的写法本来就一致，已有配置不用改。
- 删除 `server/llm-pi.js`、`test/llm-pi.test.js`、`optionalDependencies` 里的 pi-ai；Dockerfile 的 `WITH_PI` 删除（AI SDK 默认安装）；CI 矩阵的「装上 pi-ai」改为「装上 AI SDK」；同步更新 `core.lock`。
- 新测试 `test/llm-aisdk.test.js`：用本地假服务器覆盖 OpenAI 兼容和 Anthropic 两种协议，验证 usage、错误类别、`maxRetries: 0`、JSON 模式，以及 §6.3 的密钥隔离。

---

## 7. 安全

### 7.1 密钥

- 只写不读；接口、日志、错误信息里只出现末 4 位。
- 只在构造 provider 的那一刻解密。明文只存在于 provider 的闭包里，不挂在任何会被序列化的对象上（`stats`、`view()`、SSE 推送都带不到它）。
- 进化子进程拿不到任何用户密钥：它的模型调用本来就经 IPC 回到主进程。
- 凭据对象序列化时只输出白名单字段，`key_enc` 永远不会离开 `accounts` 模块。
- 测试「全站接口密钥扫描」：建一份带已知密钥的凭据，请求所有 GET 接口和 SSE 的初始载荷，断言响应里不出现密钥原文。

### 7.2 SSRF：用户填的地址不能让服务器访问内网

- 协议只允许 `https:`；`http:` 只在 `USER_LLM_PRIVATE_NET=1` 时允许。
- 解析出的每个 IP 都要检查，拒绝以下地址：回环、私有网段（10/8、172.16/12、192.168/16、fc00::/7）、链路本地（169.254/16、fe80::/10，包括云厂商的元数据地址）、CGNAT（100.64/10）、组播、未指定地址，以及 IPv4 映射成 IPv6 的形式。
- **在建立连接时检查**，防止 DNS 重绑定。`safeFetch` 用 `node:https` 加自定义 `lookup`，在 lookup 回调里校验地址；不跟随重定向；响应体上限 8 MB。因为 AI SDK 的每个 provider 都能注入 `fetch`，**所有服务类型的自带请求都经过它**，这正是替换 pi-ai 的主要原因之一。
- 服务器档继续用全局 `fetch`，不受影响。
- `USER_LLM_PRIVATE_NET` 默认等于「未开启 `PUBLIC_MODE`」：单机或局域网部署可以直接填 `http://localhost:11434/v1`（Ollama）。站点凭据（官方世界用的）不受这条限制，因为那是管理员自己的配置。

### 7.3 其他

- 使用自己的模型**不会**改变分级授权、死亡预算、审核规则或发布审核：这些看的是世界设置和授予，与模型无关。
- 用户的模型可能不守规矩：关键词审核、发布审核、抽样审核、举报下架都照常运行，而且用的是服务器模型。
- 测试连接接口单独限流（每人每分钟 3 次），防止被用来探测网络或刷上游。

---

## 8. 额度与计费

| | 服务器通道 | 自带通道 |
| --- | --- | --- |
| 全站 `LLM_DAILY_TOKENS` | 计入 | 不计入 |
| 世界日额度 `dailyWorldTokens` | 计入 | 不计入；改由 `settings.ai.dailyTokens` 约束 |
| 创世 `genesisTokens` | 计入 | 不计入 |
| 进化 `EVOLVE_BUDGET` | 计入 | 不计入；由 `dailyTokens` 约束 |
| 世界里发生的审核调用 | 计入这个世界的服务器通道 | 同左（审核永远走服务器） |
| 并发 | `LLM_CONCURRENCY` | 自己的 `concurrency`，加上可选的全局上限 |
| 账本 | `billing='server'` | `billing='own'` |

使用自带模型仍然需要 genesis 授予（内容责任不变）；但站点额度为 0 的创世者，也可以用自己的钥匙创世并运行世界。

---

## 9. 管理员配置官方世界（决策 6）

### 9.1 范围：全部世界级设置

管理面板「世界」页的每一行（官方世界和用户世界都有）增加「设置」按钮，打开和「我的世界」相同的设置对话框，并多出管理员专属的字段：

| 设置 | owner | 管理员 | 备注 |
| --- | --- | --- | --- |
| 标题、简介 | ✅ | ✅ | 官方世界改了之后不再被世界包覆盖（§9.2） |
| 叙事者 `storyteller` | ✅ | ✅ | 需要重新加载世界 |
| 人员流动 `migration` | ✅ | ✅ | 即时生效 |
| 死亡预算 `deathNamed` | ✅（授予上限内） | ✅（不限） | |
| 自主进化开关 | ✅ | ✅ | |
| 内容分级 `rating` | | ✅ | |
| Mod `mods` | | ✅ | |
| 可见性 `visibility` / 发布状态 | 部分 | ✅ | 官方世界可以在 public / unlisted / paused 之间切换（dark 分级的官方世界首次登记是 unlisted，现在有了公开它的入口） |
| AI 配置 `settings.ai` | ✅（自己的凭据） | ✅（官方世界用站点凭据） | 暂停的恢复、重试也在这里 |
| 配额（磁盘、每日 token） | | ✅ | 已有，挪进同一个对话框 |

接口不需要新增：`PATCH /api/worlds/:id/settings` 已经允许管理员修改；`PUT /api/worlds/:id/ai` 同样适用。所有修改照常写审计。

### 9.2 世界包不再覆盖管理员的修改

`registry.ensureOfficial` 改为：只有当某个字段**没有被管理员改过**时，才用世界包里的值更新它。管理员通过接口修改标题或简介时，在 `settings.overrides` 里记下 `{ title: true, summary: true }`；对话框里提供「恢复为世界包的值」，清除这个标记。

### 9.3 站点凭据

管理面板「模型」页增加「站点凭据」区块：增删改、测试连接，列出正在引用它的官方世界。`owner = 'site'`，任何管理员都可以管理（超级管理员与普通管理员的区别沿用 `authz.js` 现有的权限表）。服务器档本身仍然由「设置」页的 `BASE_URL` / `API_KEY` 配置，不受影响。

---

## 10. 接口与界面

### 10.1 接口

```
# 凭据（需要登录且有 genesis 授予；只能操作自己的）
GET    /api/me/llm-credentials                  列表：id、name、provider、base_url、key_last4、status、fail_code、last_error、被哪些世界引用
POST   /api/me/llm-credentials                  { name, provider, baseUrl, apiKey }
PATCH  /api/me/llm-credentials/:id              { name?, baseUrl?, apiKey? }（不传 apiKey = 不改）；保存后自动测试，通过则恢复相关世界
DELETE /api/me/llm-credentials/:id              ?confirm=1 时才删除被引用的凭据
POST   /api/me/llm-credentials/:id/test         列出模型，再发一次 max_tokens=8 的补全；返回模型列表、耗时、错误类别

# 站点凭据（管理员）
GET/POST/PATCH/DELETE /api/admin/llm-credentials[/:id]，POST …/:id/test      同上，owner='site'

# 世界
GET    /api/worlds/:id/ai                       当前配置、暂停状态、通道状态（inflight、queued、lastError）、今日用量（own / server 分开）
PUT    /api/worlds/:id/ai                       整体替换 settings.ai（halt 字段只读）；owner 或管理员；保存后若世界在暂停中，自动测试并尝试恢复
POST   /api/worlds/:id/ai/retry                 手动重试：测试通过则恢复
```

- 世界的 AI 配置**不需要重新加载世界**：配置档在下一次调用时换新。只有 embedding 模型改了，才需要让运行中的 `Town` 换一个 embedder。
- 所有写操作都写审计：`llm.credential.*`、`world.ai`、`world.ai-halt`、`world.ai-resume`，`detail` 里只有 `key_last4`。

### 10.2 前端

- **我的世界（`mine.html`）**：
  - 新增「模型服务」区块，用来管理凭据，每份凭据显示状态灯（正常 / 未测试 / 出错 + 原因）。
  - 每个世界卡片多一个「AI」按钮，打开设置对话框：
    - 单选：使用站点模型（显示剩余额度），或使用我自己的模型服务。
    - 选了自己的：凭据下拉框；三档模型（下拉选项来自测试连接拿到的模型列表，也可以手填）；并发；每日上限。
    - 「高级」折叠区：超时、JSON 模式、语义检索、进化评审。
    - 「测试」按钮。
  - 暂停中的世界，卡片上显示红色「已暂停：密钥无效」一类的标记，并给出「去修复」入口。
- **创世（`genesis.html`）**：最后一步也有同样的选择，默认使用站点模型；站点额度不够时提示「可以用自己的模型服务」。
- **世界页**：暂停时显示遮罩和说明，主人和管理员能看到原因和修复链接；恢复后遮罩自动消失。
- **大厅**：暂停中的世界显示「暂停中」角标。
- **管理面板**：
  - 「世界」页：每一行的「设置」对话框（§9.1）。
  - 「模型」页：服务器档的状态；「站点凭据」区块；「通道」表，列出每个自带通道的所有者、世界、并发、在途、错误率和暂停状态，不显示凭据的任何内容（地址除外）。
  - 「设置」页：新分组「自带模型」（§11）。

---

## 11. 新增设置项

| 设置 | 类型 | 默认 | 生效 | 说明 |
| --- | --- | --- | --- | --- |
| `SECRETS_KEY` | string，bootstrap，secret | 自动生成 `secret.key` | restart | 凭据加密的主密钥 |
| `USER_LLM` | bool | true | live | 是否允许用户世界使用自己的模型服务；关闭后用户世界一律使用服务器模型（凭据保留，已暂停的世界自动恢复） |
| `USER_LLM_PROVIDERS` | list | `['openai','anthropic','google']` | live | 用户可以选的服务类型（`aisdk` 只给服务器档用） |
| `USER_LLM_PRIVATE_NET` | bool | 未开启 `PUBLIC_MODE` 时为 true | live | 是否允许内网地址和 http |
| `USER_LLM_MAX_CONCURRENCY` | int 1~32 | 4 | live | 单个自带通道的并发上限 |
| `USER_LLM_TOTAL_CONCURRENCY` | int 0~1000 | 0 | live | 所有自带通道合计的在途上限，0 = 不限 |
| `USER_LLM_MAX_TIMEOUT_MS` | int | 300000 | live | 自带通道能设的最长超时 |
| `USER_LLM_CREDENTIALS_MAX` | int 0~50 | 5 | live | 每个账号最多几份凭据 |
| `USER_LLM_HALT_NET_FAILS` | int 1~100 | 8 | live | 连续多少次网络错误算「持续连不上」（另有 ≥ 3 分钟的条件） |

`LLM_PROVIDER` 的可选值改为 `openai` / `anthropic` / `google` / `aisdk`（`pi` 自动映射成 `aisdk`，保留一个版本）。

全部登记在 `server/settings/schema.js` 的新分组 `userLlm: '自带模型'` 里，`docs/settings.md` 由声明表生成。

---

## 12. 实施路线

| 步 | 内容 | 主要文件 | 验收 |
| --- | --- | --- | --- |
| B0 | 用 AI SDK 替换 pi-ai（只涉及服务器档） | `server/llm-aisdk.js`（新）、`llm-providers.js`、删 `llm-pi.js`、`package.json`、Dockerfile、CI、`core.lock` | 新的适配器测试；`LLM_PROVIDER=pi` 的旧配置照常工作并打印弃用警告；零依赖的 `openai` 路径不变 |
| B1 | 把 `llm.js` 的全局状态收进 `Profile`；服务器档行为逐行不变 | `server/llm.js` → `server/llm/`（`index.js` 保留原有导出） | **现有全部测试一行不改就通过** |
| B2 | 主密钥、加解密、凭据表与迁移（含 `usage.billing`）、`safeFetch` | `server/secrets.js`、`accounts/db.js`、`accounts/llm-credentials.js`、`server/net/safe-fetch.js`（均为新文件或新增内容） | 加解密往返；把密文挪到别的行会被 AAD 拒绝；SSRF 地址表的单元测试；迁移前后账本数据一致 |
| B3 | 多通道调度、解析器、「只用服务器」表、按上下文的 `enabled()` 等，替换 §1.2 的读取点 | `server/llm/*`、`scheduler/classes.js`、§1.2 列出的文件 | 通道隔离：自带通道 429 不影响服务器通道出队；自带网关不支持 JSON 模式不影响服务器；审核 label 一定走服务器；旅人对话走世界的模型 |
| B4 | 暂停与恢复：错误分类、`halt`、`WorldHost.halt/resume`、自动探测 | `server/llm/*`、`worlds/host.js`、`worlds/manager.js`、`sim.js` | 假上游依次返回 401 / 402 / 模型不存在 / 断网：世界暂停、凭据标记、排队任务被拒、不再打上游；修好后自动恢复；429 和超时不暂停 |
| B5 | 账本按 billing 记账、预算策略分两套 | `scheduler/budget.js`、`server/index.js` | 自带世界跑满也不动站点预算；自带上限的 80% / 100% / 120% 降级 |
| B6 | 接口、审计、测试连接；创世、重新生成、进化评审、embedding 接入自带档 | `http/*`、`genesis/*`、`evolution/llm.js`、`sim.js`、`embeddings.js` | 全站接口密钥扫描；不能引用别人的凭据；自带创世不扣 genesisTokens；§6.3 的环境变量密钥隔离 |
| B7 | 官方世界的管理员设置、`ensureOfficial` 不覆盖、站点凭据 | `worlds/registry.js`、`http/admin-api.js`、`public/js/admin/*` | 改官方世界标题后重启不被还原；dark 官方世界可以从后台公开 |
| B8 | 前端：我的世界、创世、世界页暂停遮罩、大厅角标、管理面板 | `public/js/site/*`、`public/js/ui/*`、`public/js/admin/*` | 手动走一遍：建凭据 → 测试 → 绑定世界 → 故意填错密钥，看世界暂停和提示 → 改回，看自动恢复 |
| B9 | 文档：重新生成 `docs/settings.md`；README 的依赖说明与部署说明（`SECRETS_KEY` 备份）；本文件补实施记录 | | |

B0 和 B1 都不改变功能，各自单独提交，方便回滚。之后每一步都可以单独上线：`USER_LLM` 关闭时，B3~B6 的新代码路径不会生效。
