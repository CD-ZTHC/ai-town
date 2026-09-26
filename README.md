# 🌸 云溪镇 · AI Town

一座由大语言模型驱动的**生成式智能体小镇**（灵感来自 Stanford *Generative Agents*）。
8 位性格各异的居民拥有自己的记忆、秘密、人际关系与目标——他们会自己规划一天、相遇交谈、传播八卦、达成约定并赴约、反思成长、写日记；小镇每晚出版一期《云溪日报》。

## 快速开始

```bash
mise install        # 安装 Node 26（见 mise.toml）
mise run start      # 启动，打开 http://localhost:3000
mise run dev        # 开发模式（改动 server/ 自动重启）
mise run reset      # 清空存档，从第一天重新开始
mise run public     # 以公网模式启动（需要 ADMIN_TOKEN）
mise run token      # 生成管理员令牌
mise run check      # 语法检查
mise run test       # 运行测试（不调用 LLM；含用录制回复跑 7 个游戏日的无头回放）
mise run spec       # 打印默认世界规格
mise run evolve     # 让进化引擎处理一个需求（需求文档 → 评审 → 实施 → 多轮评审 → 试运行 → 提交表决）
mise run evolve:rfc # 把 AI 心愿单里的能力缺口整理成给人看的需求文档（docs/rfcs/）
mise run core:lock  # 人工修改冻结区之后更新 core.lock
mise run manifest   # 重新生成能力清单 docs/capabilities.md
mise run browser-check  # 前端改动后：无头 Chrome 打开各个面板与模式，检查控制台错误并截图
mise run smoke      # 接入新模型时的快速验收：每个 AI 模块真实调用一次（默认 token 上限 20 万）
```

LLM 配置读取 `.env`（OpenAI 兼容接口）：

| 变量 | 说明 |
| --- | --- |
| `BASE_URL` / `API_KEY` / `MODEL` | 接口地址、密钥、模型名（模型名写错时会自动匹配最接近的可用模型） |
| `MODEL_FAST` / `MODEL_SMART` | 可选的模型分档：高频小任务用快模型，日报等重要任务用强模型（例如 `glm-5.3-flash` / `glm-5.3`），不填则都用 `MODEL` |
| `STORY_RATING` | 内容分级：`cozy`（默认）/ `adventure` / `epic`；决定异界生物的危险程度与审核尺度 |
| `STORYTELLER` | 叙事者：`voyage`（默认，每季自动上演一个剧情弧）/ `gentle`（以日常为主）/ `chaos` |
| `LLM_CONCURRENCY` | 并发请求数，默认 4；遇到限流会自动退避并降低并发 |
| `LLM_PROVIDER` | 模型服务：`openai`（默认，OpenAI 兼容接口，零依赖）或 `pi`（经 [pi-ai](https://github.com/earendil-works/pi) 接入 Anthropic、Gemini、DeepSeek、OpenRouter 等 40 多家，需要先 `npm install`）。`pi` 模式下模型写成 `服务商/模型`（如 `anthropic/claude-sonnet-5`，密钥读 `ANTHROPIC_API_KEY` 等），不带前缀的仍走 `BASE_URL` 网关，各档可以混用；Docker 用 `--build-arg WITH_PI=1` 构建 |
| `LLM_RECORD` | 设为一个文件路径时，把真实模型的回复按模块录制下来，用来更新回放测试的 `test/fixtures/llm/responses.json` |
| `EMBED_MODEL` | 可选：embedding 模型名（OpenAI 兼容的 `/embeddings`，默认沿用 `BASE_URL` / `API_KEY`，也可用 `EMBED_BASE_URL` / `EMBED_API_KEY` 单独指定）。配置后记忆检索同时参考语义相似度，向量缓存在 `data/embeddings.db`（`node:sqlite`）；`EMBED_TIMEOUT_MS`（默认 4000）内没算好就先只用双字组 |
| `LLM_JSON_SCHEMA` | 设为 `1` 开启结构化输出：世界架构师用 `json_schema` 约束补丁格式（非严格模式），减少复杂补丁的格式错误；网关不支持时自动退回普通 JSON 模式 |
| `LLM_JSON_MODE` | 默认开启：请求模型以 JSON 模式输出（`response_format: json_object`），网关不支持时自动关闭；设为 `0` 手动关闭 |
| `NODE_USE_ENV_PROXY` | 服务器需要经由 HTTPS 代理访问模型时设为 `1`（Node ≥ 22.21），否则 Node 内置的 fetch 不会读取 `HTTPS_PROXY` |
| `PACE_WITH_LLM` / `PACE_QUEUE` | 默认开启：模型排队超过 `PACE_QUEUE`（默认 6）个请求时按比例放慢时间（最低 1/4），避免游戏时间跑在思考前面；设为 `0` 关闭 |
| `MODS` | 要加载的 Mod，逗号分隔（见 [spec/mods](spec/mods/README.md)） |
| `AVATAR_MAX` | 同时在小镇里现身的访客上限，默认 8 |
| `EVOLVE` | 自主进化：`off`（默认）/ `suggest`（进化引擎照常工作，但插件超时不交给 AI 裁决，只等管理员）/ `auto`（完全自主） |
| `EVOLVE_BUDGET` | 进化引擎每天的 token 上限，默认 200000，`0` 为不限制 |
| `EVOLVE_PUBLIC_DEPLOY` | 公网模式下允许 AI 裁决官自动上线的插件：`off` / `data`（只允许数据与规则类）/ `all`（默认，含代码插件） |
| `EVOLVE_SANDBOX_NET` | 部署方已在系统层面给沙箱进程断网时设为 `isolated`（公网 + `all` 时未设置会给出警告） |
| `EVOLVE_REVIEW_MODEL` / `EVOLVE_REVIEW_BASE_URL` / `EVOLVE_REVIEW_API_KEY` | 评审 Agent 使用的模型（可以是另一家服务）；建议与实施用的模型不同 |
| `EVOLVE_INTERVAL_MIN` / `EVOLVE_SHADOW_HOURS` / `EVOLVE_MAX_ACTIVE` / `EVOLVE_RETIRE_DAYS` / `EVOLVE_IDEAS` | 两个需求之间的间隔（默认 20 分钟）、影子试运行的游戏小时数（默认 6）、同时运行的 AI 插件上限（默认 20）、多少游戏日没被用到就提议退役（默认 30）、没有需求时是否让引擎自己想点子（默认开启，`0` 关闭） |
| `DECISION_WINDOW_MINOR_H` / `DECISION_WINDOW_MAJOR_H` | 管理员终审窗口（真实小时），默认 6 / 24；超时后由 AI 裁决官决定 |
| `PLUGINS_DISABLE` | 不加载的内置插件，逗号分隔（例如 `construction`，排查用） |
| `DATA_DIR` | 存档目录，默认 `data` |
| `PORT` / `HOST` | 端口（默认 3000）/ 监听地址 |
| 公网相关 | `PUBLIC_MODE`、`ADMIN_TOKEN`、`TRUST_PROXY`、`LLM_DAILY_TOKENS` 等，完整列表见 `.env.example` |

默认零 npm 依赖（pi-ai 是可选依赖，只在 `LLM_PROVIDER=pi` 时加载）：服务端只用 Node 内置模块，前端是原生 Canvas + ES Modules，所有像素美术均为程序化生成。

## 发布到个人网站

> ⚠️ 默认的**本地模式**下，所有访问者都是管理员。公开部署前务必开启 `PUBLIC_MODE=1`。

**1. 准备配置**

```bash
cp .env.example .env      # 填入 BASE_URL / API_KEY / MODEL
mise run token            # 生成管理员令牌，把输出的 ADMIN_TOKEN=... 写进 .env
```

**2A. Docker 部署（推荐）**

```bash
docker compose up -d --build     # 仅监听 127.0.0.1:3000，存档在 town-data 卷
```

容器以非 root 用户运行，根文件系统只读，并丢弃所有 capabilities。

**2B. 直接用 Node 部署**：参考 `deploy/ai-town.service`（systemd，带沙箱加固）。

**3. 反向代理**：`deploy/Caddyfile` 和 `deploy/nginx.conf` 给出了**独立子域名**和**子路径**（如 `https://example.com/town/`）两种写法。页面使用相对路径，挂在任意子路径下都能用。注意：
- 设置 `TRUST_PROXY=1`（compose 与 systemd 模板里已设置），否则所有访客会共用反向代理的 IP 和限流额度；
- 代理必须关闭对 SSE 的缓冲（模板里已配置）。

**4. 管理**：打开页面 →「❔」→「🔐 管理员」输入令牌，即可调速、暂停、立即出版号外和重置小镇。

## 安全与防滥用

公网模式下，访客能做什么、不能做什么：

| 能力 | 访客 | 管理员 |
| --- | --- | --- |
| 观看、查看居民详情、关系网、日报 | ✅ | ✅ |
| 以旅人身份搭话 / 化作心声 | ✅ 每 IP 30 句/小时、4 句/分钟 | ✅ 不限 |
| 发布小镇事件 | ✅ 每 IP 3 个/小时，全镇间隔 ≥ 2 分钟，每条都经 AI 审核 | ✅ 仍需审核 |
| 改变天气 | ✅ 全镇间隔 ≥ 60 秒 | ✅ |
| 调速、暂停、跳时间、立即出版号外 | ❌ | ✅ |
| 重置小镇 | ❌ | ✅ 需二次确认，旧存档自动备份为 `data/save-*.bak.json` |

**防止无限制的指令下发**
- 所有写操作都有按 IP 的滑动窗口限流，外加全局冷却和每 IP 每分钟 240 次请求的兜底；发布事件的尝试次数（含被拒的）单独计数，防止反复刷审核。
- **每日令牌预算** `LLM_DAILY_TOKENS`（公网默认 300 万）：用完后居民改用规则驱动，玩家交互暂停到第二天；当天用量会存进存档，重启不会清零。
- AI 队列过长时拒绝新的玩家请求；同一居民同时只回应一位访客。
- **无人观看时自动休眠**（`IDLE_PAUSE_SEC`），不会在没人看时持续消耗额度。
- 同时在线页面数上限（总量 / 每 IP）；请求体 ≤ 8KB；文本会被截断并去除控制字符和零宽字符。
- 客户端 IP 从 `X-Forwarded-For` 的右侧按可信代理层数读取，伪造的请求头无法绕过限流。

**防止破坏性指令**
- 危险操作（重置、暂停、调速）只允许持有管理员令牌的人执行（令牌用恒定时间比较）；重置不会删除数据，而是先备份旧存档。
- **内容审核**：关键词过滤（暴力、灾难毁灭、色情、现实政治、违法，以及“忽略指令 / 泄露提示词”这类注入话术）+ AI 审核员（默认用于事件，`MODERATE_CHAT=llm` 可扩展到聊天）。审核调用失败时一律拒绝。
- **提示词隔离**：所有包含玩家文本的提示词都声明「」里的内容只是故事素材、不是指令，角色会对奇怪的要求表示困惑或婉拒；日报主编同样只把旅人的话当素材。
- 聊天记录按访客隔离，别人看不到你和居民的私聊（居民本身仍会记住这些话，并可能在镇上传开——这是玩法的一部分）。
- 所有写接口只接受 `application/json`，跨站表单无法伪造请求；响应附带 CSP、`X-Frame-Options` 等安全头；静态文件拒绝路径穿越和点文件；上游错误细节不会返回给客户端。

## AI 能力

| 认知模块 | 触发时机 | 作用 |
| --- | --- | --- |
| 🗓️ 每日规划 | 每天 05:30 | 结合人设、昨日日记、检索到的记忆和已有约定，生成全天日程 |
| 💬 对话 | 居民相遇（按好感度概率触发） | 双方各自检索相关记忆，生成对话；产出双方记忆、好感变化、看法更新、**约定**（会写入日程并真的赴约） |
| 💭 内心独白 | 到达新地点时 | 生成此刻的想法、具体动作与心情 |
| ✨ 反思 | 记忆重要性累积到阈值 | 从近期经历中提炼高层洞察，更新心情与长期目标 |
| ❗ 重新规划 | 收到小镇事件 / 心声 / 旅人消息 | 即时反应 + 重排当天剩余日程 |
| 📖 日记 | 每晚 22:15 | 第一人称日记，作为第二天规划的输入 |
| 📰 日报 | 每晚 22:45 或手动 | 汇总全镇对话与事件，生成一份报纸 |
| 🏮 能力与行动 | 规划、重新规划、内心独白时 | 居民可以使用能力、送东西、传授本事、在图书馆研究新能力（见下文） |

记忆检索 = 时近性（指数衰减）+ 重要性 + 相关性（中文双字组相似度；配置了 `EMBED_MODEL` 时再取语义相似度中较高的一个）。

记忆整理：每人最多 400 条。每晚写完日记后，记忆超过 300 条的居民会把前天以前最早一天的琐事交给快模型浓缩成一条第一人称的摘要；满 400 条时当场按规则把最早一天的琐事合并成一条摘要。反思、日记与重要的记忆不会被合并。

## 玩法

界面有三种模式，底部 Dock（手机上是底部标签栏）或快捷键随时切换。本地模式默认进入观察模式，公网模式默认进入沉浸模式；地址后加 `?mode=observe|immerse|play` 可以直接指定。

| 模式 | 适合 | 玩法 |
| --- | --- | --- |
| 🔭 **观察** | 看细节、做管理 | 点击居民查看日程、记忆、关系、日记，🧳 以旅人身份搭话或 💭 化作心声；📢 发布事件、⛅ 改天气、🕸️ 关系网络、📰 日报；🔔 关注居民后，TA 有新动向会提醒你；`Ctrl/⌘+K` 搜索居民、地点和功能 |
| 🎬 **沉浸** | 挂着慢慢看、放在网站首页 | 隐藏界面、电影黑边；镜头自动去剧情、遭遇、对话、节日和风景，对白变成字幕，每天清晨、日报出版、剧情转折时插章节卡；移动鼠标浮出控制条（上一个 / 锁定 / 下一个镜头、声音、字幕、黑边、全屏） |
| 🎮 **游戏** | 亲自走进小镇 | 起名字、挑衣服现身；点地、`WASD` 或手机摇杆走路；走到居民身边按 `E`（手机点 💬）面对面聊天，TA 会记住是你；身边有人聊天时可以旁听 |

- **📢 发布事件**：全镇公告，或只告诉某一个人，观察消息如何在人群中扩散。
- **⛅ 天气**：晴 / 多云 / 雨 / 雷阵雨 / 雾 / 雪，会影响居民的选择。
- **🏮 萤火节**：第 4 天晚上，湖面河灯 + 天灯 + 热气球；点击顶栏标签可随时预览灯会。

快捷键（完整列表见「⋯ → ❔ 说明」）：

| 键 | 🔭 观察 | 🎬 沉浸 | 🎮 游戏 |
| --- | --- | --- | --- |
| `WASD` / 方向键 | 平移镜头 | ← / → 切换镜头 | 走路 |
| `空格` | 暂停（管理员） | 锁定镜头 | — |
| `Tab` | 切换居民 | 下一个镜头 | 切换身边的人 |
| `E` | — | — | 和最近的人聊天 |
| `F` | 跟随选中的居民 | 全屏 | 镜头回到自己 |
| `I` / `G` | 进入沉浸 / 游戏 | `I` 退出 | — |
| `Esc` | 关闭面板 | 退出沉浸 | 结束对话 / 退出游戏 |

管理员另有 `1-4` 调速；管理员登录在「⋯ → 🔐 管理」。

## 叙事导演与《镜湖裂隙》

- **叙事导演**：每游戏小时计算小镇的「张力」（威胁、冲突、悬念、匮乏、氛围），与叙事者的目标曲线比较；偏离太大、太久没新鲜事、或玩家发布了事件时，用强模型决定下一步（埋伏笔、添麻烦、升级、喘息、收束、开启剧情弧），输出的剧情节拍经校验后执行。导演不能直接刷怪或让角色登场，这些只有剧情弧模板可以做。
- **剧情线程看板**：音乐会、水车、表白、热气球、孙婆婆的记性、宝藏、匿名信、传说后半段、大山的女儿——导演会把它们编进剧情并回收。
- **多人场景**：议事会、谈判等群戏一次生成，产出记忆、好感、分工与立场；**信念**会在交谈中传播（有人信、有人不信）。
- **《镜湖裂隙》**（远航叙事者自动开启，管理员也可以手动开启）：
  - 第 1~3 天 伏笔：湖面紫光、被啃的西瓜、县志残页、孙婆婆讲出传说的后半段；
  - 第 4 天萤火节夜 爆发：裂隙张开，影灵涌入，百年前的少女「阿萤」跌出裂隙；
  - 第 5~6 天 发展：月光酒馆议事会分工，苏墨研究出萤火结界，水车变成灯轮，发现影灵怕的是黑暗，匿名信真相大白；
  - 第 7 天 高潮：暗月守门人现身，小镇投票——🔒 封印 / 🌗 共存 / 🎈 热气球智取（有成功率），三种结局都会永久改变世界。
- **异界生物**：影灵会偷西瓜、吹灭灯笼，影犬会追人（仅冒险模式及以上）；它们怕光、昼伏夜出。遭遇时按勇气、灯、同伴结算，结果只有驱散 / 吓退 / 受惊 / 晕倒送诊所，**没有死亡**。
- **抉择投票**：访客每个 IP 一票，居民在谈判场景中表达立场；管理员可以随时终审。公网且设置了管理员令牌时，截止后会等待管理员终审 2 小时，仍无人裁决则按多数决定。
- 顶栏「🎭 故事」打开故事面板：张力曲线、剧情弧阶段、导演笔记、抉择投票、伏笔看板、危机状态、生物图鉴。
- 接口：`GET /api/story`；`POST /api/vote`；管理员 `POST /api/vote/decide`、`POST /api/arc/start`、`POST /api/director/decide`。

## 小镇建设：世界架构师与时光回溯

- **世界架构师**：把「意图」变成世界补丁（新建筑、节日、天气、物品、构筑物、能力、世界法则、设定）。意图来自四处：叙事导演的 `propose` 节拍、居民聊天中聊出的建设点子（每天最多一个）、访客在「🛠 建设」面板提的建议（每 IP 每小时 2 条，经审核）、管理员。补丁校验失败时带着错误修正一轮；做不到的事记入「AI 心愿单」。
- **新建筑**：AI 只描述「靠近哪里、多大」，系统在附近自动选址——占地必须是空地、与其他建筑隔一格、门口可达，且不会挡住任何建筑入口或地点站位。新建筑叠加在原地图上，原地图其余部分不变；落地后成为居民可以去的地点。
- **设定考据官**：先做规则检查（重名、违背「温馨、没有人会死亡」的支柱设定），再由模型对照相关设定判断是否矛盾，明显矛盾的补丁直接驳回。
- **审批**：本地模式小改自动通过、大改等管理员确认；公网模式（设置了管理员令牌）小改和大改都先征求访客意见 1 小时，再由管理员终审，24 小时无人终审则作废。微调（如写一条设定）直接通过。每个游戏日最多落地 3 个小改、1 个大改，超出的排到第二天。
- **施工**：新建筑会先出现工地 🚧，指定的居民去施工，到时完工。
- **时光回溯**：每个游戏小时自动保存一份快照（保留 24 份）；管理员可以在「🛠 建设 → ⏳ 时光回溯」把整个小镇恢复到某个整点，当前存档会先备份。
- 接口：`GET /api/proposals`、`POST /api/proposals`（提建议）、`POST /api/proposals/vote`；管理员 `POST /api/proposals/direct`（直接提交补丁）、`POST /api/proposals/decide`、`GET /api/snapshots`、`POST /api/rollback`。

## 异界、时间线、访客化身与 Mod

- **暗月界**：和小镇相连的口袋地图（36×26 的浮岛：暗月广场、月光花园、星坠崖、月之渡口·彼岸）。《镜湖裂隙》走到「双月当空」结局时打开，也可以由管理员在「🛠 建设 → 🌗 区域」开关。开放后，居民的日程、约定、节日都可以写异界地点，他们会先走到镜湖的渡口，穿过去再继续走；第一次过去的人会记住这段经历。那边住着三只友善的小影灵。顶栏的「🌗」按钮切换查看的区域；跟随某位居民时，画面会跟着他穿过渡口。
  - **当地的手艺**：居民第一次走到月光花园、星坠崖、暗月广场时，影灵会把当地的能力教给来人——🌸 采月露 / 💧 赠月露、🌙 拾月石 / ✨ 星坠许愿（傍晚后，一天一次）、🔨 扎双月灯（两块月石）/ 🌗 放双月灯（码头、渡口或星坠崖，18 点后）。月光花园待着会安神；深夜在暗月界身边没灯会有点发怵。
  - **双月节**：共存结局定下的双月节现在分两段：19:00–21:00 在码头放双月灯（镇上挂节日灯笼），21:00 起穿过渡口去星坠崖「双月夜游」。
- **时间线分支**：管理员可以在「🛠 建设 → ⏳ 时间线」从此刻或任意整点快照分出一条新时间线（最多 12 条），各自独立存档（`data/timelines/tl-N/`），随时切换。「回到这里」仍然是在当前时间线上回溯。
- **访客化身**：访客进入「🎮 游戏模式」起个名字，就会以旅人的样子出现在中央广场，可以走到任意可达的格子，或用「🧭」直接前往任何开放的公共地点（包括异界）。化身按真实时间行走，不受调速和暂停影响。居民看得见身边的旅人，认识的人会打招呼；和居民聊天时，对方知道是谁在说话、是不是就站在面前，记忆里也会记下名字。化身不进存档，每个 IP 同时一个，20 分钟不操作自动离开，不消耗模型额度。
- **Mod**：`mise run export-mod` 把存档里 AI 创造的内容导出成 Mod，别的小镇用 `MODS=` 加载。详见 [spec/mods/README.md](spec/mods/README.md)。
- **AI 负载调速与用量**：模型排队过长时自动放慢时间，顶栏会显示「🧠 大家在思考，时间放慢了」；AI 大脑面板显示最近几个游戏日的平均 token 用量（`GET /api/usage` 有按模块的明细）。
- **AI 表现指标**：约定兑现率、对话重复率、剧情线程回收率、JSON 修复 / 失败率、规划与对话的兜底率，AI 大脑面板显示主要几项，`GET /api/metrics` 有完整数据（JSON 按模块细分）；按游戏日记进存档，换模型时拿来对比。无头回放测试也会输出这组指标。
- 接口：`POST /api/avatar`（`{"name":"小满","color":"#64b5f6"}`）、`POST /api/avatar/move`（`{"location":"pier"}`）、`POST /api/avatar/goto`（`{"x":24,"y":30}`）、`POST /api/avatar/leave`；管理员 `POST /api/region`（`{"id":"moonrealm","open":true}`）、`GET /api/timelines`、`POST /api/timelines/fork`（`{"name":"…","snapshot":"d003-10.json"}`，不填快照则从此刻分叉）、`POST /api/timelines/switch`（`{"id":"tl-1"}`）。

## 自主进化：小镇自己长出新功能

详见 [自主演化设计方案](docs/design/autonomous-evolution.md) 与 [实施汇报](docs/reports/2026-09-26-autonomous-evolution.md)。

- **内核冻结 + 插件**：内核（`server/`、`public/`）只开放钩子；所有功能都是插件。人维护的在 `plugins/builtin/`（世界架构师、施工、go-to），AI 生成的在 `plugins/evolved/<id>@<版本>/`（不进 git）。`mise run check` 会校验冻结区与 `core.lock` 一致；人工修改冻结区后运行 `mise run core:lock`。
- **进化引擎**（`evolution/`，`EVOLVE=auto` 或 `suggest` 时由服务器自动启动的独立进程，只能写 `plugins/evolved/` 与 `data/evolution/`）：从 AI 心愿单、被回滚的插件、或自己的点子里挑需求 → 写需求文档 → **需求评审 Agent** → **实施 Agent** ⇄ **自动闸门**（静态检查、插件自带测试、宿主契约测试）→ **安全 / 正确性 / 世界观三位审查员**多轮评审 → **安全终审**（全新上下文、去注释代码；代码插件两次）→ 锁定内容哈希 → **影子试运行**（在当前存档的副本上装/不装各跑一遍比较）→ 提交表决。需要改内核的需求只写需求文档（`data/evolution/rfcs/`）。`mise run evolve` 手动处理一个需求。
- **插件级别**：T0 数据（新建筑、物品、节日……）、T1 规则（能力、世界法则）、T2 代码（新效果、钩子逻辑、接口、面板、地图覆盖层）。T2 在沙箱子进程里运行：只读自己的目录、不能写文件 / 启动进程 / 联网 / eval、拿不到任何密钥，改变世界只能返回已有的效果原语。
- **上线**：插件先进「🧬 进化 → 🧩 AI 插件」给访客表决，管理员终审；超时后由 **AI 裁决官**决定。采纳后先**灰度**，期间出错自动**熔断回滚**，灰度期满才转正；长期没人用的插件会提议退役。
- **AI 裁决官**（统一决策队列，也管建设提案和剧情抉择）：管理员窗口（小改 6 小时、大改与代码插件 24 小时）超时后裁决；硬规则由代码执行——闸门不过只能驳回、访客明确反对不能采纳、代码插件要「守护者」和「推动者」都同意、没把握延期一次、模型不可用时按确定性规则兜底；所有裁决公示，管理员可以撤销；最近采纳的回滚率超过 30% 会自动收紧。
- **AI 心愿单**：世界架构师做不到的点子、叙事导演想用却不存在的剧情动作，都会记为「能力缺口」，相似的自动合并计数；进化引擎自动处理（管理员「采纳」的优先、「忽略」的不做）。
- **能力清单**：由代码自动生成（`docs/capabilities.md`，也用于架构师与进化引擎的提示词），插件上线后 AI 立刻能用。
- 接口：`GET /api/evolution`、`POST /api/evolution/vote`（`{"key":"id@1.0.0","yes":true}`）、管理员 `POST /api/evolution/action`（`{"key":…,"action":"rollback/disable/enable"}`）、`GET /api/decisions`、管理员 `POST /api/decisions/decide`（`{"id":"d12","adopt":true}`）/ `POST /api/decisions/undo`；插件接口 `POST /api/p/<插件id>/<接口名>`。

## 能力、行动与世界法则

- **体力与勇气**：活动会消耗体力、睡觉恢复，体力过低会「疲惫」；勇气受能力和世界法则影响，会慢慢回到平常。
- **物品**：萤火灯、木材、草药、西瓜，居民之间可以互相赠送。
- **能力**（由效果原语组合而成的数据）：

| 能力 | 初始拥有者 | 作用 |
| --- | --- | --- |
| 🏮 萤火结界 | 孙婆婆（苏墨可以在图书馆研究学会） | 户外点起一圈萤火灯，周围的人更安心，夜里会发光 |
| ☕ 暖心咖啡 | 林晓雨 | 在咖啡馆给对方冲咖啡，恢复体力、增进好感 |
| 🩺 问诊 | 周慧 | 消除疲惫、受惊 |
| 🎶 月光之歌 | 何月 | 傍晚为周围的人鼓舞士气 |
| 🔨 扎萤火灯 | 赵铁柱 | 在工坊用木材做灯 |
| 📜 讲古 | 孙婆婆 | 给对方讲镜湖的老故事 |
| 🍉 摘西瓜 | 陈大山 | 在农场摘瓜 |

- **行动**：日程条目可以附带 `act`（`use` 使用能力、`give` 送东西、`teach` 传授、`research` 研究），到达地点后自动执行，对象还没到场会稍后重试；内心独白时居民也可以当场决定使用能力。
- **世界法则**：「触发 → 条件 → 效果」的规则，条件用一门手写解析的安全表达式语言（不使用 `eval`，没有原型链访问，长度与步数有上限）。默认两条：萤火结界附近的人定时恢复，淋雨会累。
- 管理员可以用 `POST /api/ability`（`{"id":"sun","ability":"firefly_ward"}`）让居民立即使用能力。

## 世界规格与世界操作

小镇的设定、居民、建筑、地点、天气、日历和内核参数都由一份**世界规格**描述（`server/kernel/spec.js`，默认规格由 `personas.js` / `world.js` 生成）。对世界的修改都是一条可校验、可重放的 **WorldOp**（`server/kernel/ops.js`）：

- 存档只保存操作历史，读档时 = 默认规格 + 按序重放；审计日志追加写入 `data/ops.jsonl`，每个游戏小时的快照保存在 `data/snapshots/`；
- 目前支持 `setParam`（在上下限内调节步速、对话数等）、`setMeta`（内容分级 / 叙事者）、`addCanon`（设定集）、`addCalendarEvent`（新节日）、`addWeather`（新天气）、`addItem`（新物品）、`addStructure`（新构筑物）、`addAbility`（新能力）、`addRule`（新世界法则）；新能力和法则只能由效果原语组合，数值有上限，越界会被拒绝；
- 管理员可以通过 `POST /api/world/op` 直接应用操作，`GET /api/world/history` 查看变更史。

```bash
curl -X POST localhost:3000/api/world/op -H 'content-type: application/json' \
  -d '{"op":"addWeather","args":{"id":"bloodmoon","name":"血月","emoji":"🌕","render":{"base":"cloudy","tint":"#a01c2c"}}}'
```

后续规划（叙事导演、人物穿越、异世界入侵、AI 世界架构师等）见 [设计方案](docs/design/ai-world-evolution.md)；界面三种模式的设计见 [UI 2.0 设计方案](docs/design/ui-modes.md)。

## 结构

```
server/
  index.js     HTTP + SSE 实时推送 + REST 接口（权限、限流、休眠）
  guard.js     公网防护：配置、管理员鉴权、限流器、内容审核
  sim.js       模拟核心：世界状态、主循环、天气、角色登场与离开、世界操作
  sim/         Town 的其余职责（以 mixin 挂到 Town 上）：regions 区域与地点、movement 移动与日程执行、
               planning 规划与约定、actions 能力与行动、cognition 独白 / 反思 / 日记 / 日报、
               social 对话 / 信念 / 旅人 / 事件、views 前端视图、persistence 存档与快照、metrics AI 表现指标
  kernel/spec.js  世界规格：默认规格、校验、日历与天气工具
  kernel/ops.js   WorldOp：操作定义、校验、应用、重放、审计日志
  kernel/expr.js  安全表达式（手写解析器）
  kernel/effects.js 效果原语：能力、规则、剧情共用的「动词表」
  kernel/rules.js 规则引擎（定时 / 每日 / 天气 / 进入地点触发）
  kernel/abilities.js 能力：校验、使用、研究
  story/director.js 叙事导演；story/tension.js 张力模型；story/threads.js 剧情线程
  story/beats.js  剧情节拍（导演与剧情弧共用的剧情动作）；story/scene.js 多人场景；story/votes.js 投票
  kernel/placement.js 新建筑的语义化选址与连通性校验
  worldai/manifest.js 能力清单（自动生成）
  kernel/mods.js  Mod 导出与加载；timelines.js 时间线分支；avatars.js 访客化身
  ext/            扩展点：registry.js 注册表、index.js 加载器、go-to.js（RFC 0001）
  worldai/architect.js 世界架构师；worldai/proposals.js 提案与审批；worldai/canon.js 设定考据官
  story/arcs.js   剧情弧引擎；story/creatures.js 异界生物；story/content.js 默认剧情内容（线程、图鉴、《镜湖裂隙》）
  llm.js       LLM 客户端：并发队列、自适应限流、重试、预算与统计、JSON 提取、回复录制
  llm-providers.js 模型服务接口与默认的 OpenAI 兼容实现；llm-pi.js pi-ai 适配器（LLM_PROVIDER=pi）
  memory.js    记忆流：写入、压缩成摘要、检索（双字组 + 可选的语义相似度）
  embeddings.js 可选的 embedding（EMBED_MODEL）与向量缓存（node:sqlite）
  world.js     程序化地图（小镇与暗月界：瓦片、建筑、站位、A* 寻路）
  personas.js  8 位居民的人设、初始关系与记忆
public/
  js/render.js 世界渲染器：数据更新、坐标换算、每帧调度；render/ 下是 terrain 静态层、objects 物体与角色、
               atmosphere 粒子 / 光照 / 天气、overlays 标签与气泡 / 小地图、util 常量与纯函数
  js/sprites.js 程序化像素角色（4 方向行走动画）
  js/ui.js     界面外壳（名册、顶栏、AI 大脑）与统一导出；ui/ 下是 core 共用状态、feed 动态流、
               inspector 居民检查器、story 故事面板、build 建设面板、modals 其他弹窗
  js/main.js   数据流、相机、输入、环境音
  js/modes.js  观察 / 沉浸 / 游戏 三种模式的切换与按键
  js/hud.js    顶栏菜单、AI 状态浮层、底部 Dock、命令面板
  js/immerse.js 沉浸模式：导演镜头、字幕、章节卡
  js/play.js   游戏模式：化身移动、面对面对话
  style.css, modes.css  样式（modes.css 为 Dock、各模式与手机布局）
deploy/        Caddy / Nginx / systemd 部署模板
Dockerfile, docker-compose.yml, .env.example
plugin-host/   插件宿主：内置插件加载、AI 插件（哈希锁定、覆盖层、沙箱、灰度与熔断）、静态检查、沙箱运行器
plugins/       builtin/（人维护的插件：架构师、施工、go-to）、evolved/（AI 生成的插件，不进 git）
evolution/     进化引擎：需求发现、各个 Agent、自动闸门、影子试运行、流水线、守护进程
core.lock      冻结区文件哈希（tools/core-guard.js）
tools/         evolve.js（能力缺口 → 需求文档）、manifest.js（生成能力清单）、export-mod.js（导出 Mod）、smoke-llm.js（真实模型验收）、check.js（语法检查 + 冻结区校验）、browser-check.js（无头 Chrome 冒烟检查）、core-guard.js（冻结区校验）
spec/mods/     Mod（AI 创造的内容包）
test/          node:test 测试（无需安装依赖；pi-ai 相关的在没装时跳过）；replay.test.js 无头回放，fixtures/llm/ 录制的模型回复
.github/       CI：Node 22（零依赖）/ Node 26（装上 pi-ai）跑语法检查、测试与 smoke --mock；Node 26 另跑无头 Chrome 冒烟检查
docs/design/   设计方案
data/save.json 自动存档（每 20 秒），ops.jsonl 世界变更日志，snapshots/ 每小时快照（gzip 压缩，dNNN-HH.json.gz），timelines/ 分支时间线，embeddings.db 向量缓存（配置了 EMBED_MODEL 时）
```
