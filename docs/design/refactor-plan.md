# 架构重构方案：TypeScript 迁移与 2 核 2G 线上环境适配 —— 设计方案

> 状态：实施中（2026-09-28 开始）。已完成 P0 诊断（[记录](../reports/2026-09-28-p0-diagnosis.md)）、P1 的代码部分（systemd 单元、迁移脚本、部署改造；线上迁移待执行）、P2、P2b、P3、P4（B1~B9，服务端与测试全部改为 TypeScript）、P5（SQLite 增量存档）、P7（确定性）、P8（结构化输出）、P6 第一、二步（临时字段移到 town.rt；持久状态收进 town.state、由 sim/state.ts 一张表定义）与第三步的示范（指标模块），P9 第一项（沙箱按需运行与全站上限）与第三项的评估（[评估文档](sandbox-evaluation.md)：建议共享沙箱进程 + QuickJS-wasm）。
> 未做：P6 第三步的其余 10 个子系统（movement、planning、social、dark、combat……，按方案每个子系统一个 PR，做法见 sim/metrics.ts）；P9 的效果 DSL 扩展（需要线上能力缺口统计决定优先级，本地数据里没有缺口记录）与 QuickJS 方案的实施。P5 的线上导入在首次启动新版本时自动进行（save.json 改名备份，可用 mise run export-save 导出回滚）。
> 前提：线上服务器 **2 核 2G**，已出现内存（分页）耗尽导致整机卡死。
> 相关：[multi-world.md](multi-world.md) §7 统一 AI 调度；[autonomous-evolution.md](autonomous-evolution.md) §8 内核冻结；[world-llm.md](world-llm.md)。

## 0. 一句话概括

**不换语言，先止血，再上类型，最后调架构。** 先用运维手段让线上不再卡死（内存上限、OOM 兜底、关掉生产机上的重负载），再修掉代码里的内存风险（SSE 背压、无上限缓存）；然后在不引入构建步骤的前提下把服务端迁到原生 TypeScript（Node 类型剥离），在类型的保护下做状态分离、SQLite 增量持久化、确定性、结构化输出等架构调整。前端资源改为「内容哈希 URL + 长缓存」，已打开的页面能发现新版本并刷新，解决更新后用户仍在用旧版本的问题。每一步都是独立的 PR，测试（含 7 天无头回放）始终保持通过。

---

## 1. 现状

### 1.1 规模

| 目录 | 文件数 | 行数 |
| --- | --- | --- |
| `server/`（根） | 14 | 3465 |
| `server/sim/` | 12 | 2157 |
| `server/kernel/` | 13 | 2517 |
| `server/story/` | 10 | 2319 |
| `server/http/` | 10 | 1731 |
| `server/worldai/` | 5 | 970 |
| `server/genesis/` | 6 | 873 |
| `server/worldgen/` | 6 | 858 |
| `server/worlds/` | 7 | 820 |
| `server/accounts/` | 8 | 776 |
| `server/settings/` | 2 | 452 |
| `server/scheduler/` | 4 | 382 |
| `plugin-host/` | 6+3 | ~1150 |
| `evolution/` | 10 | 1149 |
| `public/js/` | — | ~6600 |
| `test/` | 36 | 6886 |

合计约 3.4 万行 JS，无类型检查。112 个提交集中在 2026-09-24 ~ 09-28，大部分由 AI 编写。

### 1.2 架构要点

- 单个 Node 服务进程承载所有世界；每个世界一个 `Town`，用 50ms 的 `setInterval` 推进（`server/sim.js` `start()`），所有世界共享一个事件循环。
- `Town` 是一个上帝对象：11 个职责模块以 mixin 的形式挂到同一个 prototype（`sim.js` 文件末尾），状态是几十个散落在 `this` 上的字段。
- 世界规格是事件溯源的（默认规格 + `specOps` 重放），但运行时状态是**整份 JSON**：每 20 秒同步 `JSON.stringify` + `writeFileSync`（`sim/persistence.js` `save()`），当前云溪镇 `save.json` 约 640KB 并随记忆增长；每游戏小时额外 gzip 一份快照。
- `save()` 手工列出约 50 个需要保存的字段，并用解构排除十几个临时字段（`path`、`bubble`、`convoId`……）——每加一个功能都可能漏存或多存。
- 实时推送是 SSE：`tick` 每 0.1 秒推一份完整快照（`sim.js` `advance()` → `WorldHost.broadcast`）。
- 子进程：守护进程 `main.js` → 服务 `index.js` → 进化引擎（有世界开启进化时）→ 每个 T2 插件一个沙箱进程；另有进化影子试运行（`evolution/shadow.js`）、创世无头试跑（`genesis/jobs.js`）。
- 随机数：`server/` 下有 32 处直接调用 `Math.random`，只有部分系统接受注入的 `opts.random`。

### 1.3 线上内存问题（代码层面的原因，待线上数据确认）

| # | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| M1 | 线上用 `nohup mise run start` 启动，systemd 模板里的 `MemoryMax=512M`、compose 里的 `mem_limit` 都**没有生效** | `tools/deploy.sh` | 进程组没有任何上限；内存耗尽时内核反复回收页缓存 → 整机卡死，而不是干净地杀掉进程 |
| M2 | 服务进程、进化引擎、影子试运行、创世试跑都**没有设置堆上限** | `server/main.js`、`server/index.js:335`、`evolution/shadow.js`、`genesis/jobs.js` | 每个进程基础占用 40–80MB，影子试运行还要载入一份存档副本并跑一遍世界 |
| M3 | SSE 没有背压：`client.write` 直接 `ctrl.enqueue`，不看 `desiredSize` | `server/http/app.js:162` | `@hono/node-server` 会等底层 socket `drain`，于是**积压全部留在 ReadableStream 的内部队列里**。一个卡住但没断开的观众（手机后台、弱网），每秒积压 30–50KB，每小时 100–200MB |
| M4 | 每位观众各自 `enc.encode(s)`，同一份数据复制 N 次 | `server/http/app.js` | 观众越多，临时内存越多 |
| M5 | 部署时在生产机上 `npm ci`、`tools/check.js`、复制 `node_modules`，同时旧服务仍在运行 | `tools/deploy.sh` | 部署瞬间的内存峰值 |
| M6 | embedding 向量的进程内缓存是没有上限的 `Map` | `server/embeddings.js:38` | 随记忆和查询文本持续增长 |
| M7 | 每 20 秒全量序列化存档（每个活跃世界各一次）+ 每小时 gzip | `sim/persistence.js` | 周期性的内存峰值与 GC 压力，随存档增大而变重 |
| M8 | 重置 / 回溯 / 切换时间线会新建 Town；旧 Town 的计时器、embedding 数据库、沙箱进程是否全部释放**尚未核实** | `worlds/host.js` `reload()` | 疑似泄漏点，需用堆快照确认 |
| M9 | 线上部署目录是 `/root/ai-town`，而 systemd 模板开了 `ProtectHome=true` | `tools/deploy.sh`、`deploy/ai-town.service` | 直接改用模板会因为读不到 `/root` 启动失败——切换到 systemd 时必须一起迁移目录 |

### 1.4 前端资源的缓存与版本（线上更新后用户仍在用旧版本）

现状：

- `public/` 下约 50 个文件（9 个 HTML、3 个 CSS、其余是原生 ES Modules），没有构建步骤，URL 里**没有任何版本信息**：HTML 用 `src="js/main.js"`、`href="style.css"`，模块之间用 `import './ui.js'`。
- `serveStatic`（`server/http/app.js:197`）对所有静态文件返回 `Cache-Control: no-cache` + 弱 ETag `W/"<size>-<mtime>"`。`git archive` 解压出的文件 mtime 都是提交时间，所以每次部署后 ETag 都会变——按 HTTP 语义，浏览器每次都会重新验证，**理论上**不会用到旧文件。
- 页面是长连接应用：打开后靠 SSE 持续更新，服务重启时 `EventSource` 自动重连并重新拿 `init`（`public/js/main.js:124、164`），**页面本身从不刷新**。
- 线上前面有 Caddy（`encode zstd gzip`），是否还经过 CDN（例如 Cloudflare，站点已用 Turnstile）**尚未确认**。

用户仍在用旧版本的可能原因（待 P0 确认占比）：

| # | 原因 | 说明 |
| --- | --- | --- |
| C1 | **已打开的页面从不刷新** | 部署后 SSE 自动重连，旧 JS 继续跑在新服务上：新增的字段不显示，改过的接口报错，看起来就是「还是旧版本」。这很可能是主因 |
| C2 | 往返缓存（bfcache） | 手机切回标签页、浏览器「后退」时直接恢复内存里的旧页面，不发任何请求 |
| C3 | 内嵌浏览器不遵守 `no-cache` | 微信 / QQ 内置浏览器（X5 内核）等对 JS、CSS 有激进的本地缓存，常见现象就是「更新后要清缓存才生效」 |
| C4 | 中间层改写缓存头 | CDN 的「浏览器缓存 TTL」之类设置会覆盖源站的 `Cache-Control`；需要看线上实际响应头 |
| C5 | 部署窗口内版本混杂 | 服务重启的几秒内加载页面：HTML 与部分模块来自不同版本，或部分模块加载失败导致白屏；之后即使服务恢复，页面也不会自愈 |

另外，`no-cache` 让每次打开页面都要为约 50 个文件逐个发条件请求（模块图是逐层发现的，要多轮往返），弱网下首屏慢——这是性能问题，与「旧版本」无关，但同一套方案可以一起解决。

---

## 2. 目标与非目标

### 2.1 目标

1. 2 核 2G 上稳定运行：内存有硬上限，出问题时杀进程而不是卡死整机，守护进程自动拉起。
2. 服务端代码有静态类型保护，且**不引入构建步骤**。
3. 持久化状态有唯一的 schema，存档不再依赖手工列字段。
4. 存档改为增量写入，去掉周期性的全量序列化峰值。
5. 模拟可复现：同样的种子 + 同样的录制回复 → 同样的结果。
6. 降低 JSON 修复 / 失败率。
7. 部署后，新打开的页面一定拿到新版本的 JS / CSS，已打开的页面能发现新版本并在合适的时机刷新；不引入前端构建步骤。

### 2.2 非目标（及理由）

| 不做 | 理由 |
| --- | --- |
| 后端换 Clojure / JVM | 瓶颈在 LLM I/O 而不是 CPU；进化引擎依赖模型写插件，模型写 JS 远好于 Clojure；AI SDK 生态在 JS；JVM 基础占用 200–400MB，与 2G 机器冲突；重写 3.4 万行会让功能停摆数周。Clojure 的长处（不可变状态值、代码即数据）通过 §10 状态分离、§13 效果 DSL 在 Node 里实现 |
| 引入构建步骤（tsc 编译到 dist、打包器） | 保持「只需 Node 运行时」的部署形态 |
| 生产环境用 `tsx` / `ts-node` | 运行时转译额外占内存；Node 原生类型剥离零开销 |
| 每个世界一个 `worker_threads` | 每个 worker 有独立的堆，2G 机器上得不偿失；单进程 + 增量持久化已足够 |
| 前端引入框架或构建 | 约 6600 行原生 ES Modules，规模可控；资源版本由服务端在启动时生成（§7），不需要打包器 |
| Service Worker 缓存前端资源 | 它本身就是最难更新的一层（旧 SW 会继续拦截请求）；带哈希的 URL + `immutable` 已经能拿到同样的缓存收益 |
| AI 插件改用 TS | 插件在沙箱里直接运行，改 TS 会牵动沙箱、闸门、静态检查；只提供类型声明给生成器参考 |

---

## 3. 决策

| # | 决策 | 结论 |
| --- | --- | --- |
| D1 | TypeScript 的形式 | 原生 `.ts` + Node 类型剥离（erasable syntax only），`tsc --noEmit` 只做检查 |
| D2 | Node 最低版本 | `>=22.18`（类型剥离默认开启的最低版本）；生产与开发用 Node 26 |
| D3 | 前端 | 保持 JS；需要时用 JSDoc + `// @ts-check` 引用服务端导出的类型 |
| D4 | AI 插件 | 保持 JS；提供 `plugin-host/types/plugin.d.ts` 作为契约 |
| D5 | 顺序 | 诊断 → 运维止血 → 内存修复 → 前端资源版本 → TS 基础 → TS 迁移 → SQLite → 状态分离 → 确定性 → 结构化输出 → 插件精简 |
| D6 | 生产机上的进化引擎 | 关闭（`EVOLVE`），进化在开发机或独立机器上跑，只把审核通过的插件部署上去 |
| D7 | 每个 PR 的门槛 | `mise run check`、`mise run test`（含回放）、`smoke --mock`；动前端时加 `browser-check`；动冻结区后 `mise run core:lock` |
| D8 | 前端资源版本 | 服务端启动时对 `public/` 做内容哈希，HTML 里的入口加 `?v=<哈希>`，模块间的 import 由服务端注入的 import map 映射到带哈希的 URL；带正确哈希的请求返回 `immutable`，HTML 保持 `no-cache`；已打开的页面通过 SSE / 响应头比对构建号来提示刷新 |

---

## 4. 阶段 P0：线上诊断（半天）

在动手前拿到真实数据，确认 §1.3 里哪几条是主因，以及 §1.4 里用户拿到旧版本的原因。

```bash
ps -eo pid,rss,args --sort=-rss | grep -E 'node|mise' | head -20   # 各进程占用
free -m; swapon --show; cat /proc/pressure/memory                  # 内存、交换分区、内存压力
dmesg -T | grep -iE 'oom|killed process' | tail                     # 是否发生过 OOM
ss -tn state established '( sport = :3000 )' | wc -l                # SSE 连接数

# 前端资源：从公网看实际响应头（经过 Caddy / CDN 之后）
curl -sI https://<站点>/js/main.js | grep -iE 'cache-control|etag|age|cf-cache-status|server|via'
curl -sI https://<站点>/js/main.js -H 'If-None-Match: <上一步的 ETag>' | head -1   # 应为 304
```

需要记录：

- 各进程 RSS（区分服务、守护、进化引擎、沙箱、试运行）；
- 卡死前后是否在跑影子试运行 / 创世；
- SSE 连接数，以及是否存在长时间不读的连接；
- 线上的 `MAX_ACTIVE_WORLDS`、`EVOLVE`、`LLM_CONCURRENCY`、`EMBED_MODEL` 取值；
- 静态资源的公网响应头：`Cache-Control` 是否被改写、有没有 `Age` / `cf-cache-status: HIT`（说明中间层在缓存）、条件请求能否拿到 304；
- 反馈「还是旧版本」的用户用的是什么浏览器（是否在微信 / QQ 内打开）、是刷新后仍旧还是一直开着没刷新——对应 §1.4 的 C1–C4。

**产出**：一份诊断记录（`docs/reports/`），确认 M1–M8 的实际占比，以及 C1–C5 中哪几条成立。

---

## 5. 阶段 P1：运维止血（1 天，不改业务代码）

### 5.1 改用 systemd 运行（修复 M1、M9）

- 部署目录从 `/root/ai-town` 迁到 `/opt/ai-town`，用专用用户 `aitown` 运行（`ProtectHome=true` 保持开启）。
- Node 改用系统安装的 Node 26（或 mise 安装到 `/opt`），`ExecStart` 不再经过 `mise`，少一个包装进程。
- 内存限制作用于整个 cgroup（包括所有子进程）：

```ini
[Service]
Environment=NODE_OPTIONS=--max-old-space-size=512
MemoryHigh=1200M     # 超过后内核开始积极回收、限速，但不杀
MemoryMax=1400M      # 硬上限，超过即 OOM kill，守护进程或 systemd 拉起
MemorySwapMax=512M
Restart=on-failure
```

- `tools/deploy.sh` 改为：上传新版本到 `/opt/ai-town.new` → `systemctl stop`（SIGTERM 会存档）→ 切换目录 → `systemctl start` → 健康检查 → 失败回滚。备份逻辑保持不变。

### 5.2 OOM 兜底

- 增加 1–2G 交换文件，`vm.swappiness=10`（只作缓冲，不作常规内存）。
- 安装 `earlyoom`（或启用 `systemd-oomd`）：可用内存低于 5% 时杀掉占用最大的进程，避免整机卡死；把 `sshd`、`nginx` 加入保护名单。

### 5.3 子进程堆上限（修复 M2）

| 进程 | 上限 |
| --- | --- |
| 服务 `index.js` | 512MB（`NODE_OPTIONS`，由守护进程 fork 时继承） |
| 守护进程 `main.js` | 64MB |
| 进化引擎 | 192MB |
| 进化影子试运行 | 192MB |
| 创世无头试跑 | 192MB |
| 插件沙箱 | 64MB（已有） |

进化引擎与两种试运行不继承 `NODE_OPTIONS`（它们的 `env` 被清空），需要在各自的启动参数里显式加 `--max-old-space-size`——这一步需要改代码，放到 P2 一起做；P1 先通过关闭进化规避。

### 5.4 调低设置（管理面板即可）

| 设置 | 建议值 | 说明 |
| --- | --- | --- |
| `MAX_ACTIVE_WORLDS` | 2 | 默认 4 |
| `IDLE_PAUSE_SEC` | 60–90 | 无人观看尽快休眠 |
| `EVOLVE` | 关 | 见 D6 |
| 创世 | 全站同时最多 1 个试跑 | 需要代码支持时放到 P2 |

### 5.5 部署不在生产机上装依赖（修复 M5）

- CI 里 `npm ci --omit=dev` 后把 `node_modules` 与代码一起打包成 tar（或构建 Docker 镜像推送到仓库），生产机只下载、解压、切换。
- `tools/check.js` 在 CI 里跑，生产机上不再跑。

### 5.6 内存预算（2G 机器）

| 组成 | 预算 |
| --- | --- |
| 系统、sshd、nginx / Caddy、页缓存下限 | ~400MB |
| 服务进程（堆 512MB + 非堆） | ~700MB |
| 守护进程 | ~50MB |
| 插件沙箱（按需启动，见 §13） | ~150MB |
| 创世试跑（最多 1 个） | ~200MB |
| **合计** | **~1500MB**，cgroup 上限 1400MB 之内由 `MemoryHigh` 限速 |

**验收**：线上连续 72 小时不卡死；`/proc/pressure/memory` 的 `some avg60` 长期低于 5；出现 OOM 时只有单个进程被杀并自动恢复。

---

## 6. 阶段 P2：内存相关代码修复（1 个 PR，先于 TS 迁移）

### 6.1 SSE 背压（修复 M3、M4）

改造 `server/http/app.js` 的 SSE 客户端与 `WorldHost.broadcast`：

- **每次广播只编码一次**：`broadcast` 生成一个 `Uint8Array`，所有客户端共用。
- **`tick` 只保留最新一帧**：每个客户端维护 `latestTick`；`ReadableStream` 用 `pull()` 驱动——底层可写时才取出最新一帧发送，没发出去的旧帧直接丢弃。
- **其他事件**（`log`、`agent`、`newspaper`……）进入有上限的队列；排队字节数超过阈值（默认 256KB）时关闭这个连接，前端 `retry: 3000` 会自动重连并重新拿 `init`。
- **降低推送频率**：`tick` 从 10Hz 降到 4Hz（可设置）。前端目前直接用 `app.snap = JSON.parse(...)` 替换快照（`public/js/main.js:157`），降频前需要确认渲染层对角色坐标是否已有平滑；没有的话在渲染层加一个按时间的线性插值。

### 6.2 内存观测

- `/healthz` 与管理面板「概览」增加：服务进程 `process.memoryUsage()`（rss / heapUsed / external / arrayBuffers）、SSE 连接数与总积压字节、活跃世界数、沙箱与试运行进程数（及其 RSS，经 `/proc/<pid>/status` 读取）。
- 服务进程启动参数加 `--heapsnapshot-near-heap-limit=1`，接近上限时在 `data/diag/` 留下一份堆快照。
- 内存超过设定阈值（例如 `rss > 900MB`）时写审计并在管理面板顶部提示。

### 6.3 无上限缓存（修复 M6）

- `embeddings.js` 的进程内 `Map` 改为 LRU（默认 2000 条，约 8MB @ 1024 维）；持久层仍是 SQLite。
- 顺带检查其他以 `Map` / 对象做缓存的地方（`llm.js` 的通道、`guard.js` 的限流器已有 `sweep`）。

### 6.4 子进程上限与并发（M2 的代码部分）

- 进化引擎、影子试运行、创世试跑的 `spawn` 参数加 `--max-old-space-size`，数值来自设置（新增 `CHILD_HEAP_MB`，默认 192）。
- 创世试跑与影子试运行共用一个全站信号量，同时最多 1 个。

### 6.5 Town 替换时的资源释放（M8）

- `Town.stop()` 统一释放：主循环计时器、所有 `setInterval`（如 `sim/social.js:167`）、embedding 数据库句柄、沙箱进程、事件监听。
- 增加测试：连续 `reload()` 20 次后，活动句柄数（`process.getActiveResourcesInfo()`）与沙箱进程数不增长。

**验收**：模拟一个不读数据的 SSE 客户端连接 1 小时，服务进程 RSS 增长 < 20MB；重复重置世界不泄漏句柄。

---

## 7. 阶段 P2b：前端资源版本管理（1 个 PR，约 1 天，可与 P2 并行）

解决 §1.4 的 C1–C5。前端保持原生 ES Modules、不引入打包器（D8）：**版本信息由服务端在启动时生成、在返回 HTML 时注入**，`public/` 下的源文件不需要手工改版本号。

### 7.1 资源清单

新建 `server/http/assets.js`：

- 启动时遍历 `public/`，对每个文件算 SHA-256，取前 10 位十六进制作为版本：`manifest: Map<相对路径, 哈希>`（约 50 个文件，耗时可忽略）。
- **构建号** `BUILD`：部署时写入的 `REVISION`（`tools/deploy.sh` 已经在写，git 短哈希）；本地没有 `REVISION` 时用清单整体的哈希。
- 开发模式（`npm run dev`）下每次请求先比对文件 mtime，变了就重新计算该文件的哈希，改前端不用重启服务。
- 新增设置 `ASSET_VERSIONING`（默认开）：关闭后不注入 import map、不改写 URL，全部静态资源退回 `no-cache`，作为出问题时的开关。

### 7.2 让 URL 带上版本

| 引用方式 | 处理 |
| --- | --- |
| HTML 里的入口：`<script type="module" src="js/main.js">`、`<link href="style.css">`、`../site.css` 等 | 返回 HTML 时改写为 `js/main.js?v=<哈希>`。只改写能在清单里找到的相对路径，外链（Google Fonts）、`data:` 不动 |
| 模块之间的 `import './ui.js'` | HTML 的 `<head>` 里注入一段 import map：`{"imports": {"./js/ui.js": "./js/ui.js?v=<哈希>", …}}`，覆盖 `public/js/` 下全部模块（约 40 条、2KB）。浏览器按解析后的 URL 匹配，所以相对 import、动态 `import()` 都生效，JS 源码一行不用改 |
| 插件界面 iframe 里的 `../../js/plugin-bridge.js`（`server/http/app.js:193`） | 生成 HTML 时直接拼上 `?v=` |

细节：

- import map 的键相对于 HTML 所在目录生成：`index.html`、`lobby.html` 等用 `./js/…`，`admin/index.html` 用 `../js/…`。世界页 `/w/<id>/` 返回的是同一份 `index.html`，相对路径解析到 `/w/<id>/js/…`，服务端本来就映射回 `public/js/`，与键一致；挂在反代子路径（`/town/`）下同理。
- CSP 是 `script-src 'self'`，内联的 import map 会被拦截。import map 的内容只有两种（按目录深度），启动时算好它的 `sha256-…`，返回 HTML 时追加到 `script-src`。人机验证那段中间件（`app.js:82`）替换的是 `script-src 'self'` 这个前缀，追加哈希后仍然匹配。
- 改写后的 HTML 在内存里缓存（几十 KB），ETag 用改写后内容的哈希（强 ETag）。
- 兼容性：import map 需要 Chrome 89 / Safari 16.4 / Firefox 108。不支持的浏览器会忽略它，模块按原 URL 加载，走下面「不带 `v`」的分支——结果仍然正确，只是没有长缓存。

**不采用的做法**：服务端改写 JS 里的 import 语句（`'./ui.js'` → `'./ui.js?v=…'`）。它不依赖 import map，但要用正则解析 JS；并且每个模块的版本必须包含所有依赖的版本（改一个叶子模块，所有上游模块的 URL 都要变），实现和排查都更复杂。只有在 P0 发现大量用户的浏览器不支持 import map 时才改用这个方案。

### 7.3 缓存头

| 请求 | `Cache-Control` | 说明 |
| --- | --- | --- |
| HTML 页面 | `no-cache` + 强 ETag | 每次打开都会重新验证，拿到的 import map 永远指向当前版本 |
| 带 `?v=` 且等于当前哈希 | `public, max-age=31536000, immutable` | 内容与 URL 一一对应，永不重新验证；二次打开页面时静态资源的请求从约 50 个降到 1 个（HTML） |
| 带 `?v=` 但与当前哈希不同 | `no-cache` | 通常是旧页面在请求旧版本：返回当前内容，但不能以 `immutable` 缓存在旧 URL 下 |
| 不带 `v` | `no-cache` + ETag | 与现在相同，只是 ETag 改为内容哈希，不再依赖 mtime |
| 插件界面、接口、SSE | 不变 | 仍为 `no-store` / `no-cache` |

- `If-None-Match` 按逗号分隔的列表解析，比较时忽略 `W/` 前缀和反代压缩追加的后缀（如 `-zstd`），避免经过 Caddy `encode` 后永远拿不到 304。
- 若 P0 确认前面有 CDN：只允许缓存带 `v=` 的请求并遵守源站缓存头，HTML 不缓存，关闭「浏览器缓存 TTL」之类会覆盖源站头的设置（C4）。

### 7.4 已打开的页面发现新版本（C1、C2）

**服务端告知构建号**

- HTML 里注入 `<meta name="build" content="<BUILD>">`，页面由此知道自己的版本。
- SSE 的 `init` 事件增加 `build` 字段；所有接口响应增加 `X-Build` 响应头；`/healthz` 返回 `build`。

**前端处理**（新增 `public/js/version.js`，小镇、大厅、创世、管理面板共用）

- 发现构建号不一致时，先显示不遮挡操作的提示条：「小镇已更新，刷新后使用新版本」+「立即刷新」按钮。
- 满足以下条件时自动刷新：页面切到后台（`visibilitychange` → `hidden`），或者持续 60 秒没有打开的弹窗、输入框里没有未提交的内容。自动刷新前随机延迟 0–30 秒，避免部署后所有观众同一秒重新加载。
- 有未提交内容（对话输入、创世草稿、管理面板表单）时只提示、不自动刷新。
- 防止刷新循环：`sessionStorage` 记录「已为构建号 X 刷新过」；刷新后仍然不一致（HTML 本身被中间层缓存，即 C3 / C4），再用 `location.replace` 带一个 `_r=<BUILD>` 查询参数刷新一次，仍不行就只保留提示，不再重试。
- 往返缓存：监听 `pageshow`，`event.persisted` 为真（从 bfcache 恢复）时请求一次 `/healthz` 比对构建号。
- 旧页面调用接口时，从 `X-Build` 响应头就能发现版本变化，不必等 SSE 重连。

### 7.5 部署窗口（C5）

- 新增一个很小的经典脚本 `public/js/boot.js`（同样带 `?v=`，放在模块入口之前）：监听 `<script type="module">` 的加载错误；入口模块或其依赖加载失败时显示「服务正在更新，几秒后自动重试」，按 2 / 5 / 10 秒退避刷新，最多 3 次。
- HTML 与模块由同一个进程、同一个目录提供，新页面不会拿到混杂的版本；混杂只会出现在「旧页面加载新模块」的情况，而 import map 已经把旧页面的请求固定到旧哈希、服务端对不匹配的哈希返回 `no-cache`——配合 7.4 的提示刷新即可收敛。约定前端新增的动态 `import()` 也只用相对路径，从而受 import map 覆盖。

### 7.6 检查与测试

- `tools/check.js`：`public/` 下所有 HTML 引用、JS 的 import 路径都能在清单里找到（防止 import map 漏项）；HTML 中除注入内容外不出现内联脚本。
- 单元测试：清单哈希；HTML 改写（根目录页面、`admin/`、`/w/<id>/`）；CSP 哈希与注入的 import map 一致；`v` 匹配 / 不匹配 / 缺失三种缓存头；`If-None-Match` 列表与后缀。
- `browser-check`：首次加载后刷新，JS / CSS 全部命中缓存、没有网络请求；修改一个模块并重启服务后，新打开的页面拿到新内容，已打开的页面出现更新提示。
- `public/` 在冻结区内：改完执行 `mise run core:lock`。

**验收**：部署后新打开的页面全部是新版本（桌面浏览器、iOS Safari、微信内置浏览器各实测一次）；已打开的页面在 2 分钟内出现提示，无输入时自动刷新；二次打开页面时静态资源只请求 HTML。

---

## 8. 阶段 P3 / P4：TypeScript

### 8.1 P3：类型基础（1 个 PR，不改行为）

**配置**

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "target": "es2024",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "noEmit": true,
    "allowJs": true,               // 迁移期间 JS 与 TS 共存
    "checkJs": false,              // JS 文件暂不检查
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,    // 禁止 enum / namespace / 参数属性等 Node 无法剥离的语法
    "verbatimModuleSyntax": true,  // 强制 import type
    "strict": true,
    "noUncheckedIndexedAccess": false,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["server", "plugin-host", "evolution", "plugins/builtin", "tools", "test"]
}
```

- 开发依赖：`typescript`、`@types/node`（`devDependencies`，生产不安装）。
- `package.json`：`engines.node` 改为 `>=22.18`；新增脚本 `typecheck: tsc --noEmit`。
- CI：Node 22 的矩阵改为 `22.18`（或 `22.x` 最新）；增加 typecheck 步骤。
- `tools/check.js`：语法检查的文件遍历同时识别 `.ts`；`.ts` 文件的语法由 typecheck 覆盖。
- `tools/core-guard.js`：冻结区哈希天然包含所有文件，无需改逻辑；`checkEvolvedImports` 只检查插件里的 `.js`，保持不变。

**核心类型**（新建 `server/types/`，全部是 `.ts` 声明，不含运行时代码）

| 文件 | 内容 |
| --- | --- |
| `agent.ts` | `Agent`（持久字段）、`AgentRuntime`（`path`、`bubble`、`convoId` 等临时字段）、`Memory`、`Relation`、`Belief`、`Body` |
| `spec.ts` | 世界规格 `WorldSpec`（天气、日历、地点、能力、法则、威胁……），与 `kernel/spec.js` 的校验对齐 |
| `ops.ts` | `WorldOp` 联合类型（按 `op` 字段区分），`OpRecord` |
| `save.ts` | 存档结构 `SaveV2`（照 `persistence.js` 当前字段整理，作为 P6 的起点） |
| `scheduler.ts` | `Job`、`LlmClass`（`'P0' \| … \| 'P4'`）、调用上下文 |
| `events.ts` | Town 发出的事件名与负载（`tick`、`log`、`agent`……），用于类型化的 `EventEmitter` 与 SSE |
| `plugin.d.ts`（在 `plugin-host/types/`） | 插件契约：`plugin.json` 结构、T2 `server.js` 可用的 API 与效果原语 |

**验收**：`npm run typecheck` 通过；所有测试通过；运行行为不变。

### 8.2 P4：逐模块迁移（多个 PR）

**规则**

- 一个 PR 迁移一批目录：`git mv x.js x.ts` + 补类型 + 把所有引用方的 `'./x.js'` 改为 `'./x.ts'`。先 `git mv` 单独提交，便于 review 与 `git log --follow`。
- 只允许可擦除语法：`interface`、`type`、类型注解、`import type`、`as`、`satisfies`；不用 `enum`（改用 `as const` 对象 + 联合类型）、`namespace`、构造函数参数属性、装饰器。
- 不借迁移改逻辑。发现的 bug 另开 PR。
- 新迁移的文件必须通过 `strict`；实在无法立即补全的类型用 `// TODO(types)` 标注的显式 `any`，不用 `@ts-ignore`。

**需要同步修改的硬编码路径**

| 位置 | 引用 |
| --- | --- |
| `server/main.js:14` | `ENTRY = …/index.js` |
| `server/index.js:335` | 进化引擎入口 `evolution/daemon.js` |
| `server/genesis/jobs.js:14` | `SHADOW = …/shadow.js` |
| `evolution/shadow.js` | `evolution/shadow-runner.js` |
| `plugin-host/sandbox/client.js:7` | `RUNNER = …/runner.js` |
| `package.json` / `mise.toml` | `start`、`dev`、`spec`、`evolve` 等任务 |
| `Dockerfile` | `CMD ["node", "server/main.js"]` |
| `deploy/ai-town.service`、`tools/deploy.sh` | 启动命令、线上 `.env` 校验里的 `import('./server/settings/index.js')` |
| `.github/workflows/ci.yml` | 各步骤的入口 |

**沙箱**：`plugin-host/sandbox/runner.js` 运行在 `--permission` 下，只读自身与插件目录。迁移为 `.ts` 后需确认类型剥离在权限模型下正常（它只需要读取自身文件）；若有问题，runner 保留为 `.js`，只给它加 JSDoc。

**mixin 的类型**：`Town` 通过声明合并获得各模块的方法，保持现有的 mixin 机制不变：

```ts
// server/sim.ts
export interface Town extends Regions, Movement, Planning, Actions, Cognition, Social, Views, Persistence, Metrics, Dark, Combat {}
export class Town extends EventEmitter { /* … */ }

// server/sim/movement.ts
import type { Town } from '../sim.ts';
export class Movement {
  updateAgent(this: Town, a: Agent, dt: number): void { /* … */ }
}
```

只用 `import type` 引用 `Town`，擦除后不会产生循环依赖。

**批次**（按依赖从叶到根，风险从低到高）

| 批次 | 内容 | 行数 |
| --- | --- | --- |
| B1 | `server/scheduler/`、`server/settings/`、`server/net/`、`server/secrets.js`、`server/memory.js` | ~1.3k |
| B2 | `server/kernel/`（`expr`、`spec`、`ops`、`effects`、`rules`、`abilities`、`placement`……） | ~2.5k |
| B3 | `server/llm*.js`、`server/world-llm.js`、`server/embeddings.js` | ~1.3k |
| B4 | `server/worldgen/`、`server/world.js` | ~1.2k |
| B5 | `server/sim.js` + `server/sim/`（mixin 声明合并） | ~2.8k |
| B6 | `server/story/`、`server/worldai/`、`server/avatars.js`、`server/timelines.js` | ~3.8k |
| B7 | `server/accounts/`、`server/worlds/`、`server/genesis/`、`server/http/`、`server/guard.js`、`server/index.js`、`server/main.js` | ~5k |
| B8 | `plugin-host/`、`plugins/builtin/`、`evolution/`、`tools/` | ~3k |
| B9（可选） | `test/` 改为 `.ts` | ~6.9k |

每个批次结束：typecheck、全部测试、`smoke --mock`；B5、B6 额外对比回放测试输出的 AI 表现指标，与迁移前一致。全部完成后 `tsconfig` 去掉 `allowJs`（`public/` 不在 `include` 中）。

**进化引擎的影响**：生成插件的提示词引用的是 `server/worldai/manifest.js` 的导出（能力清单），不引用内核文件路径；迁移后只需更新 `evolution/prompts` 的 import 路径。`evolution/agents.js:66` 对生成代码里 `.js` 后缀的修补只作用于插件文件，保持不变。

---

## 9. 阶段 P5：SQLite 增量持久化（1–2 个 PR）

在 2G 机器上，这一步的优先级高于状态分离：它直接去掉 M7 的周期性峰值。

### 9.1 设计

每个世界（每条时间线）一个 `world.db`（`node:sqlite`，WAL 模式，`synchronous=NORMAL`）：

| 表 | 内容 | 写入方式 |
| --- | --- | --- |
| `memories` | `agent_id, seq, t, type, importance, text, meta_json` | 写入记忆时追加；压缩成摘要时在一个事务里删旧插新 |
| `logs` | 动态流 | 追加；只保留最近 N 条（定期删除） |
| `convo_log` | 对话记录 | 追加 |
| `newspapers` | 日报 | 追加 |
| `snapshots` | `name, created_at, data(gzip blob)` | 每游戏小时一条，保留 24 条 |
| `kv` | 其余核心状态（小体积 JSON，按键分组：`agents_core`、`story`、`dark`、`proposals`……） | 标记为脏的键每 20 秒写一次，只写变化的键 |

- 内存里仍保留居民的全部记忆（8 人 × 400 条很小），检索逻辑不变；变化的只是写盘方式——从「全量序列化」变成「追加 + 脏键写入」。
- `specOps` 继续写 `ops.jsonl`（已是追加日志），同时存一份到 `kv` 以便单文件恢复。

### 9.2 迁移与兼容

- 启动时发现 `save.json` 而没有 `world.db`：备份 `save.json` → 导入 → 之后只写数据库。保留一个版本的「导出为 save.json」工具，用于回滚与排查。
- **时光回溯**：从 `snapshots` 表恢复；**时间线分叉**：`VACUUM INTO` 复制数据库；**影子试运行**：同样用 `VACUUM INTO` 生成副本交给子进程。
- 世界磁盘上限（`worlds/disk.js`）改为统计数据库文件大小。

**验收**：存档写入期间的内存峰值（`heapUsed` 的锯齿）下降；回溯、分叉、影子试运行、重置、旧存档导入都有测试。

---

## 10. 阶段 P6：状态分离（按子系统多个 PR）

### 10.1 目标结构

```ts
class Town {
  state: TownState;   // 纯数据，可序列化，由 zod schema 定义（唯一出处）
  rt: TownRuntime;    // 路径、计时器、SSE、缓存、子系统实例——永不序列化
}
```

- `TownState` 的 zod schema 同时产出 TS 类型（`z.infer`）与存档校验；`persistence` 按 schema 写 `kv`，不再手工列字段。
- 居民拆成 `state.agents[id]`（持久）与 `rt.agents[id]`（`path`、`dest`、`bubble`、`convoId`、`thinking`……）。
- 子系统（剧情、威胁、迁徙、战斗、提案、决策……）逐步改为 `(state, ctx) → effects` 的函数；`ctx` 提供随机数、时间、LLM、事件发射。

### 10.2 步骤

1. 引入 `state` / `rt`，先把**临时字段**移到 `rt`（风险最低，且立即消除 `save()` 里的排除列表）。
2. 按子系统迁移持久字段：每个 PR 一个子系统（dark、story、migration、proposals……），`save` 版本号递增，写迁移函数与测试。
3. 最后把 mixin 改为独立模块，`Town` 只保留编排（主循环顺序、事件）。

### 10.3 收益

- 快照 / 回溯 / 分叉 / 影子试运行 = 复制 `state`（`structuredClone`），不需要特殊代码。
- 子系统可以单独测试：给一个 `state`，断言新的 `state` 与产生的效果。

---

## 11. 阶段 P7：确定性（1 个 PR）

- 新增 `server/kernel/rng.ts`：可设置种子的随机数（xoshiro128** 或 mulberry32）；`Town` 创建时用世界 id + 时间线 + 存档中的种子初始化，种子写入存档。
- 32 处 `Math.random` 全部改为 `town.rng()` 或从 `ctx` 传入；`Date.now()` 在模拟逻辑中改为 `ctx.now()`（HTTP 层、限流、账号不受影响）。
- `tools/check.js` 增加规则：`server/sim*`、`server/story/`、`server/kernel/`、`server/worldai/` 下出现 `Math.random` / `Date.now` 时失败（白名单注释放行）。
- 回放测试改为断言：同一个种子跑两次，最终状态的哈希相同。

**收益**：影子试运行「装 / 不装插件各跑一遍」的对比真正可信；bug 可以按种子复现。

---

## 12. 阶段 P8：结构化输出（1 个 PR）

- `llm.chatJSON` 接受 zod schema；用 zod 4 的 `z.toJSONSchema()` 生成 JSON Schema：
  - OpenAI 兼容接口：`response_format: { type: 'json_schema', … }`；
  - AI SDK：`generateObject`；
  - 通道不支持时退回现有的「提取 + 修复」（按通道记住，已有机制）。
- 各认知模块（规划、对话、独白、反思、导演、架构师……）的输出逐个补 schema，与现有的手工校验对齐。
- 用 `mise run smoke` 对比切换前后的 JSON 修复 / 失败率与 token 用量（指标已有，见 `/api/metrics`）。

---

## 13. 阶段 P9：插件与沙箱精简（按需）

- **沙箱按需启动、空闲回收**：插件沙箱在第一次调用时启动，空闲 N 分钟（默认 10）关闭；同时存在的沙箱进程数设全站上限（默认 3），超出时按最久未用回收。2G 机器上这比常驻更重要。
- **扩展效果 DSL，缩小 T2 的范围**：进化引擎里能力缺口最多的类型，优先补成效果原语或表达式语言的能力，让更多插件以 T0 / T1 数据形式表达——数据可以静态校验、差异对比，安全评审成本低。
- **（评估）更轻的隔离**：QuickJS-wasm 或 isolated-vm，单个实例几 MB，替代每插件一个 Node 进程。需要单独的方案文档评估安全边界与迁移成本。

---

## 14. PR 清单与顺序

| # | 阶段 | PR | 依赖 | 风险 |
| --- | --- | --- | --- | --- |
| 1 | P0 | 线上诊断记录 | — | 无 |
| 2 | P1 | systemd 单元、目录迁移、`deploy.sh` 改造、earlyoom / 交换分区说明、CI 打包 | 1 | 中（部署流程变更，需要演练回滚） |
| 3 | P2 | SSE 背压、共享编码、推送降频（+ 前端插值） | — | 中 |
| 4 | P2 | 内存观测、堆快照、embedding LRU、子进程堆上限与试运行信号量、Town 释放 | — | 低 |
| 5 | P2b | 资源清单、HTML 改写与 import map、缓存头、构建号与更新提示、`boot.js` | — | 低（只影响静态资源与前端提示；出问题可退回全部 `no-cache`） |
| 6 | P3 | tsconfig、核心类型、typecheck 接入 CI、Node 版本 | — | 低 |
| 7–14 | P4 | 迁移批次 B1–B8 | 6 | 低 → 中 |
| 15–16 | P5 | SQLite 持久化、旧存档导入、回溯 / 分叉 / 试运行改造 | 14 | 中（数据迁移） |
| 17+ | P6 | state / rt 分离，按子系统 | 16 | 中 |
| — | P7 | 确定性 | 14 | 低 |
| — | P8 | 结构化输出 | 14 | 中（需真实模型验证） |
| — | P9 | 沙箱按需启动、效果 DSL | 14 | 中 |

PR 3、4、5 可以与 P3 并行；PR 5 直接面向用户、改动小，建议紧跟 P0 优先上线；P7、P8、P9 在 P4 完成后可以按需穿插。

---

## 15. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| systemd 迁移后线上起不来 | 先在同配置的测试机演练；`deploy.sh` 保留健康检查失败自动切回；旧的 nohup 启动方式保留一个版本 |
| 大规模重命名与进行中的功能分支冲突 | 每个批次尽量小；迁移期间约定冻结对应目录的功能开发，或迁移 PR 合并后立即通知 rebase |
| 类型剥离不支持的语法混入 | `erasableSyntaxOnly` 在 typecheck 阶段拦截 |
| 存档格式变更导致旧存档不可读 | 每次格式变更递增版本号 + 迁移函数 + 迁移前自动备份（沿用现有做法）+ 导入测试 |
| SSE 降频后画面卡顿 | 前端插值；推送频率做成设置项，可随时调回 |
| 进化引擎生成的插件与新契约不符 | 插件保持 JS；契约 `.d.ts` 与宿主契约测试同步更新 |
| import map 漏项或 CSP 哈希不匹配导致页面白屏 | `tools/check.js` 校验所有 import 都在清单内；单元测试断言 CSP 哈希与注入内容一致；`browser-check` 覆盖每个 HTML 页面；设置项可一键关闭注入，退回全部 `no-cache` |
| 自动刷新打断用户操作 | 有弹窗或未提交输入时只提示不刷新；后台标签页才立即刷新；随机延迟错开部署后的重连高峰 |
| 冻结区哈希频繁变化 | 每个 PR 末尾统一 `mise run core:lock` |

---

## 16. 待确认

1. P0 诊断的结果（决定 P2 中 SSE 背压与子进程上限谁先做）。
2. 线上是否可以把部署目录从 `/root/ai-town` 迁到 `/opt/ai-town`。
3. 生产机关闭进化后，进化放在哪里运行（开发机 / 另一台机器）。
4. 前端对 `tick` 的角色坐标是否已有平滑（决定降频是否需要改前端）。
5. `test/` 是否也迁移到 TS（B9，可选）。
6. 线上是否经过 CDN（决定 §7.3 是否需要配置 CDN 缓存规则），以及反馈旧版本的用户主要用什么浏览器（决定 import map 方案是否够用，见 §7.2）。
