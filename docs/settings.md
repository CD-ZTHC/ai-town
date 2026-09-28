# 设置项

> 本文由 `mise run settings:doc` 根据 [server/settings/schema.js](../server/settings/schema.js) 生成，请不要手工修改。

值的来源只有三层，优先级从高到低：**环境变量 > 管理面板保存的值（`data/settings.json`）> 默认值**。
标记为「启动必需」的项只能用环境变量设置；其余所有项都可以在管理面板（`/admin`）里修改，环境变量仍然可以覆盖任意一项（此时面板上显示为锁定）。

- **即时**：保存后立即生效；**重启**：需要重启进程（面板上可以一键重启）。
- 布尔值在环境变量里写 `1` / `0`（也接受 `true` / `false`）；列表写成逗号分隔。
- 环境变量写错（例如 `LLM_CONCURRENCY=abc`）时服务拒绝启动并指出是哪一项。

## 站点

| 键 | 说明 | 取值 | 默认 | 生效 |
| --- | --- | --- | --- | --- |
| `PORT` | 端口 **启动必需** | 整数 | `3000` | 重启 |
| `HOST` | 监听地址：放在反向代理后面时建议 127.0.0.1；留空监听所有地址 **启动必需** | 文本 | （空） | 重启 |
| `DATA_DIR` | 数据目录：存档、账号数据库、设置文件都在这里 **启动必需** | 文本 | `data` | 重启 |
| `PUBLIC_MODE` | 公网模式：开启后需要注册登录才能互动；关闭时所有请求视为本地管理员 **启动必需** | 开关 | 关 | 重启 |
| `TRUST_PROXY` | 可信反向代理层数：在 Caddy / Nginx 后面时设为 1，按 X-Forwarded-For 识别访客 IP **启动必需** | 整数 | `0` | 重启 |
| `ADMIN_TOKEN` | 管理员令牌：首次启动时用它认领超级管理员；之后作为应急入口，每次使用都写审计 **启动必需** **密钥** | 文本 | （空） | 重启 |
| `ALLOW_INTERACTION` | 允许互动：关闭后所有世界变成纯观赏模式 | 开关 | 开 | 即时 |
| `MAX_CLIENTS` | 同时在线页面上限 | 整数 | `200` | 即时 |
| `MAX_CLIENTS_PER_IP` | 每个 IP 同时打开的页面上限 | 整数 | `6` | 即时 |
| `IDLE_PAUSE_SEC` | 无人观看多久后休眠（秒）：0 = 永不休眠。休眠的世界不推进时间、不调用模型 | 整数 | `90` | 即时 |
| `AVATAR_MAX` | 每个世界同时现身的旅人上限 | 整数 | `8` | 即时 |

## 模型

| 键 | 说明 | 取值 | 默认 | 生效 |
| --- | --- | --- | --- | --- |
| `LLM_PROVIDER` | 模型服务类型：openai：OpenAI 兼容接口；pi：经 pi-ai 接入 40 多家服务（需要安装可选依赖） | `openai` / `pi` | `openai` | 重启 |
| `BASE_URL` | 接口地址：OpenAI 兼容接口，例如 https://example.com/v1 | 文本 | （空） | 即时 |
| `API_KEY` | 密钥 **密钥** | 文本 | （空） | 即时 |
| `MODEL` | 默认模型：模型名写错时会自动匹配最接近的可用模型 | 文本 | （空） | 即时 |
| `MODEL_FAST` | 快模型：高频小任务（内心独白、审核）；不填用默认模型 | 文本 | （空） | 即时 |
| `MODEL_SMART` | 强模型：日报、导演、架构师等重要任务；不填用默认模型 | 文本 | （空） | 即时 |
| `LLM_CONCURRENCY` | 并发请求数：所有世界共用；遇到限流会自动退避并降低并发 | 整数 | `4` | 即时 |
| `LLM_TIMEOUT_MS` | 单次请求超时（毫秒） | 整数 | `150000` | 即时 |
| `LLM_DAILY_TOKENS` | 每日 token 预算：全站共用，0 = 不限；公网模式默认 300 万 | 整数 | `（按其他设置推导）` | 即时 |
| `LLM_JSON_MODE` | JSON 模式：网关不支持时会自动关闭 | 开关 | 开 | 重启 |
| `LLM_JSON_SCHEMA` | 结构化输出（json_schema）：网关不支持时自动退回普通 JSON 模式 | 开关 | 关 | 重启 |
| `PACE_WITH_LLM` | 随 AI 负载放慢时间 | 开关 | 开 | 重启 |
| `PACE_QUEUE` | 开始放慢时间的排队长度：按世界计算：本世界在队列里积压超过这个数时放慢 | 整数 | `6` | 即时 |
| `PINNED_BUDGET_SHARE` | 常驻世界的预算保留比例 | 数字 | `0.3` | 即时 |
| `PRIORITY_AGING_MIN` | 低优先级任务防饿死阈值（分钟） | 整数 | `30` | 即时 |

## 语义检索

| 键 | 说明 | 取值 | 默认 | 生效 |
| --- | --- | --- | --- | --- |
| `EMBED_MODEL` | embedding 模型：配置后记忆检索同时参考语义相似度 | 文本 | （空） | 重启 |
| `EMBED_BASE_URL` | embedding 接口地址：不填沿用模型接口地址 | 文本 | （空） | 重启 |
| `EMBED_API_KEY` | embedding 密钥：不填沿用模型密钥 **密钥** | 文本 | （空） | 重启 |
| `EMBED_TIMEOUT_MS` | embedding 超时（毫秒） | 整数 | `4000` | 重启 |

## 频率与审核

| 键 | 说明 | 取值 | 默认 | 生效 |
| --- | --- | --- | --- | --- |
| `RATE_CHAT_PER_HOUR` | 每个账号每小时聊天句数：另有每分钟 4 句的突发限制 | 整数 | `45` | 即时 |
| `RATE_EVENT_PER_HOUR` | 每个账号每小时发布事件数 | 整数 | `4` | 即时 |
| `RATE_IP_FACTOR` | 同一 IP 的合计上限倍数：同一 IP 下所有账号合计，不超过单账号额度的这个倍数 | 数字 | `3` | 即时 |
| `EVENT_GLOBAL_COOLDOWN_SEC` | 世界内两次事件的最短间隔（秒） | 整数 | `120` | 即时 |
| `WEATHER_COOLDOWN_SEC` | 世界内两次改天气的最短间隔（秒） | 整数 | `60` | 即时 |
| `MODERATE_EVENTS` | 事件审核方式 | `llm` / `keyword` | `llm` | 即时 |
| `MODERATE_CHAT` | 聊天审核方式：llm 会让每次聊天多一次调用 | `llm` / `keyword` | `keyword` | 即时 |
| `MAX_QUEUE_FOR_USER` | 排队超过多少时暂停玩家互动 | 整数 | `6` | 即时 |
| `REPORT_UNLIST_THRESHOLD` | 自动转为不公开的举报数 | 整数 | `5` | 即时 |

## 账号

| 键 | 说明 | 取值 | 默认 | 生效 |
| --- | --- | --- | --- | --- |
| `REGISTER_OPEN` | 开放注册 | 开关 | 开 | 即时 |
| `REGISTER_PER_IP_HOUR` | 每个 IP 每小时可注册的账号数 | 整数 | `3` | 即时 |
| `CAPTCHA_SECRET` | 人机验证密钥：配置后注册需要通过人机验证（Cloudflare Turnstile） **密钥** | 文本 | （空） | 即时 |
| `CAPTCHA_SITEKEY` | 人机验证站点密钥：Turnstile 的 site key，页面上显示验证组件时用 | 文本 | （空） | 即时 |
| `LOCAL_NICKNAME` | 本地模式的昵称 | 文本 | `旅人` | 即时 |

## 世界

| 键 | 说明 | 取值 | 默认 | 生效 |
| --- | --- | --- | --- | --- |
| `MAX_ACTIVE_WORLDS` | 同时运行的世界上限：超过后会卸载无人观看、空闲最久的世界 | 整数 | `4` | 即时 |
| `PINNED_WORLDS` | 常驻世界：不会被卸载，但计入上限；逗号分隔 | 逗号分隔的列表 | `yunxi` | 即时 |
| `DEFAULT_WORLD` | 默认世界：旧路径 /api/* 映射到的世界 | 文本 | `yunxi` | 即时 |
| `WORLD_UNLOAD_SEC` | 休眠多久后存盘卸载（秒） | 整数 | `600` | 即时 |
| `WORLD_DISK_MB` | 每个用户世界的默认磁盘上限（MB） | 整数 | `200` | 即时 |
| `MIGRATION` | 人员流动：世界会自己来新人、有人出门远行再回来；每个世界还可以在世界设置里单独关闭 | 开关 | 开 | 即时 |
| `MIGRATION_DAYS` | 人员流动的平均间隔（游戏日）：两次变动至少间隔它的 3/4 | 数字 | `4` | 即时 |
| `MIGRATION_CAP` | 人数上限倍数：在场人数最多为世界初始人数的这个倍数 | 数字 | `1.5` | 即时 |
| `WORLDS_DISK_TOTAL_GB` | 用户世界磁盘总量上限（GB）：0 = 不限；超过后暂停接受新的创世 | 数字 | `0` | 即时 |

## 创世

| 键 | 说明 | 取值 | 默认 | 生效 |
| --- | --- | --- | --- | --- |
| `GENESIS_MAX_WORLDS` | 默认可创建的世界数 | 整数 | `2` | 即时 |
| `GENESIS_MAX_SOURCE_CHARS` | 默认原文字数上限 | 整数 | `60000` | 即时 |
| `GENESIS_TOKENS` | 默认创世 token 额度：一次性额度，不按天重置 | 整数 | `400000` | 即时 |
| `GENESIS_DAILY_WORLD_TOKENS` | 默认每个世界每日 token 额度 | 整数 | `150000` | 即时 |

## 决策

| 键 | 说明 | 取值 | 默认 | 生效 |
| --- | --- | --- | --- | --- |
| `DECISION_WINDOW_MINOR_H` | 一般决策的终审窗口（小时）：超时后由 AI 裁决官决定 | 数字 | `6` | 即时 |
| `DECISION_WINDOW_MAJOR_H` | 重大决策的终审窗口（小时） | 数字 | `24` | 即时 |

## 自主进化

| 键 | 说明 | 取值 | 默认 | 生效 |
| --- | --- | --- | --- | --- |
| `EVOLVE` | 进化引擎：suggest：插件超时不交给 AI 裁决；auto：完全自主 | `off` / `suggest` / `auto` | `off` | 重启 |
| `EVOLVE_BUDGET` | 进化每日 token 上限（每个世界）：0 = 不限 | 整数 | `200000` | 重启 |
| `EVOLVE_PUBLIC_DEPLOY` | 公网模式下 AI 可以自动上线的插件 | `off` / `data` / `all` | `all` | 重启 |
| `EVOLVE_SANDBOX_NET` | 沙箱已在系统层面断网 | `（空）` / `isolated` | （空） | 重启 |
| `EVOLVE_MAX_ACTIVE` | 同时运行的 AI 插件上限 | 整数 | `20` | 重启 |
| `EVOLVE_CANARY_DATA_MIN` | 数据插件灰度时长（游戏分钟） | 整数 | `360` | 重启 |
| `EVOLVE_CANARY_CODE_MIN` | 代码插件灰度时长（游戏分钟） | 整数 | `1440` | 重启 |
| `EVOLVE_CANARY_CODE_REAL_H` | 代码插件灰度的最短真实时长（小时） | 数字 | `2` | 重启 |
| `EVOLVE_RETIRE_DAYS` | 多少游戏日没被用到就提议退役 | 整数 | `30` | 重启 |
| `EVOLVE_REVIEW_MODEL` | 评审模型：建议与实施用的模型不同 | 文本 | （空） | 重启 |
| `EVOLVE_REVIEW_BASE_URL` | 评审模型接口地址 | 文本 | （空） | 重启 |
| `EVOLVE_REVIEW_API_KEY` | 评审模型密钥 **密钥** | 文本 | （空） | 重启 |
| `EVOLVE_INTERVAL_MIN` | 两个需求之间的间隔（分钟） | 数字 | `20` | 重启 |
| `EVOLVE_SHADOW_HOURS` | 影子试运行的游戏小时数 | 整数 | `6` | 重启 |
| `EVOLVE_IDEAS` | 没有需求时让引擎自己想点子 | 开关 | 开 | 重启 |
| `PLUGINS_DISABLE` | 不加载的内置插件 | 逗号分隔的列表 | （空） | 重启 |

## 世界级（在世界设置里修改）

| 键 | 说明 | 取值 | 默认 | 生效 |
| --- | --- | --- | --- | --- |
| `STORY_RATING` | 内容分级 **世界级** | `cozy` / `adventure` / `epic` / `dark` / `tragic` | `cozy` | 重启 |
| `STORYTELLER` | 叙事者 **世界级** | `gentle` / `voyage` / `chaos` / `horror` | `voyage` | 重启 |
| `MODS` | 加载的 Mod **世界级** | 逗号分隔的列表 | （空） | 重启 |

## 开发

| 键 | 说明 | 取值 | 默认 | 生效 |
| --- | --- | --- | --- | --- |
| `LLM_RECORD` | 录制模型回复到文件 **仅开发** | 文本 | （空） | 重启 |
| `CHROME` | 浏览器检查用的 Chrome 路径 **仅开发** | 文本 | （空） | 重启 |
| `EVOLVE_DAEMON` | 随服务启动进化引擎 **仅开发** | 开关 | 开 | 重启 |
