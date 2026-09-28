// 设置声明表（多世界设计 §14）：所有设置项唯一的出处。读取、校验、管理面板、docs/settings.md 都由它生成。
//   type    zod 定义（取值的类型与范围）
//   kind    面板上的控件与环境变量字符串的解析方式：int / number / bool / string / enum / list
//   default 默认值（可以是函数：(get) => 值，按其他设置推导）
//   apply   live = 保存后立即生效；restart = 需要重启进程
//   bootstrap 启动必需：只能用环境变量设置（决定了面板本身能不能被访问）
//   secret  密钥：面板只写不读；scope: 'world' 属于世界的设置（在世界设置页里改，不在全站面板里）；dev：只做开发与测试用，不在面板显示
import { z } from 'zod';

const int = (min, max) => ({ kind: 'int', type: z.number().int().min(min).max(max) });
const num = (min, max) => ({ kind: 'number', type: z.number().min(min).max(max) });
const bool = () => ({ kind: 'bool', type: z.boolean() });
const str = (max = 500) => ({ kind: 'string', type: z.string().max(max) });
const oneOf = (values) => ({ kind: 'enum', values, type: z.enum(values) });
const list = (item = z.string().min(1).max(64)) => ({ kind: 'list', type: z.array(item).max(64) });
const url = () => ({ kind: 'string', type: z.union([z.literal(''), z.string().url().max(500)]) });

export const GROUPS = {
  site: '站点', llm: '模型', userLlm: '自带模型', embed: '语义检索', limits: '频率与审核', accounts: '账号', worlds: '世界',
  genesis: '创世', decisions: '决策', evolution: '自主进化', world: '世界级（在世界设置里修改）', dev: '开发',
};

export const SETTINGS = {
  // ---------- 站点（前 6 项是启动必需，只能用环境变量；另一项是 SECRETS_KEY）----------
  PORT: { group: 'site', ...int(1, 65535), default: 3000, apply: 'restart', bootstrap: true, label: '端口' },
  HOST: { group: 'site', ...str(200), default: '', apply: 'restart', bootstrap: true, label: '监听地址', help: '放在反向代理后面时建议 127.0.0.1；留空监听所有地址' },
  DATA_DIR: { group: 'site', ...str(500), default: 'data', apply: 'restart', bootstrap: true, label: '数据目录', help: '存档、账号数据库、设置文件都在这里' },
  PUBLIC_MODE: { group: 'site', ...bool(), default: false, apply: 'restart', bootstrap: true, label: '公网模式', help: '开启后需要注册登录才能互动；关闭时所有请求视为本地管理员' },
  TRUST_PROXY: {
    group: 'site', ...int(0, 5), default: 0, apply: 'restart', bootstrap: true, label: '可信反向代理层数',
    help: '在 Caddy / Nginx 后面时设为 1，按 X-Forwarded-For 识别访客 IP', parse: (s) => (s === 'true' ? 1 : s === 'false' ? 0 : Number(s)),
  },
  ADMIN_TOKEN: { group: 'site', ...str(200), default: '', apply: 'restart', bootstrap: true, secret: true, label: '管理员令牌', help: '首次启动时用它认领超级管理员；之后作为应急入口，每次使用都写审计' },
  ALLOW_INTERACTION: { group: 'site', ...bool(), default: true, apply: 'live', label: '允许互动', help: '关闭后所有世界变成纯观赏模式' },
  MAX_CLIENTS: { group: 'site', ...int(1, 100000), default: 200, apply: 'live', label: '同时在线页面上限' },
  MAX_CLIENTS_PER_IP: { group: 'site', ...int(1, 1000), default: 6, apply: 'live', label: '每个 IP 同时打开的页面上限' },
  IDLE_PAUSE_SEC: { group: 'site', ...int(0, 86400), default: 90, apply: 'live', label: '无人观看多久后休眠（秒）', help: '0 = 永不休眠。休眠的世界不推进时间、不调用模型' },
  AVATAR_MAX: { group: 'site', ...int(0, 200), default: 8, apply: 'live', label: '每个世界同时现身的旅人上限' },

  // ---------- 模型 ----------
  LLM_PROVIDER: {
    group: 'llm', ...oneOf(['openai', 'anthropic', 'google', 'aisdk']), default: 'openai', apply: 'restart', label: '模型服务类型',
    help: 'openai：OpenAI 兼容接口；anthropic / google：官方接口；aisdk：模型名写成「服务商/模型」，可以混用多家（密钥从 ANTHROPIC_API_KEY 等环境变量读取）。后三种经 AI SDK 接入（可选依赖）',
    parse: (s) => (s === 'pi' ? 'aisdk' : s), // 旧名字：pi-ai 已换成 AI SDK
  },
  BASE_URL: { group: 'llm', ...url(), default: '', apply: 'live', label: '接口地址', help: 'OpenAI 兼容接口，例如 https://example.com/v1' },
  API_KEY: { group: 'llm', ...str(500), default: '', apply: 'live', secret: true, label: '密钥' },
  MODEL: { group: 'llm', ...str(200), default: '', apply: 'live', label: '默认模型', help: '模型名写错时会自动匹配最接近的可用模型' },
  MODEL_FAST: { group: 'llm', ...str(200), default: '', apply: 'live', label: '快模型', help: '高频小任务（内心独白、审核）；不填用默认模型' },
  MODEL_SMART: { group: 'llm', ...str(200), default: '', apply: 'live', label: '强模型', help: '日报、导演、架构师等重要任务；不填用默认模型' },
  LLM_CONCURRENCY: { group: 'llm', ...int(1, 64), default: 4, apply: 'live', label: '并发请求数', help: '所有世界共用；遇到限流会自动退避并降低并发' },
  LLM_TIMEOUT_MS: { group: 'llm', ...int(5000, 600000), default: 150000, apply: 'live', label: '单次请求超时（毫秒）' },
  LLM_DAILY_TOKENS: { group: 'llm', ...int(0, 1e12), default: (get) => (get('PUBLIC_MODE') ? 3_000_000 : 0), apply: 'live', label: '每日 token 预算', help: '全站共用，0 = 不限；公网模式默认 300 万' },
  LLM_JSON_MODE: { group: 'llm', ...bool(), default: true, apply: 'restart', label: 'JSON 模式', help: '网关不支持时会自动关闭' },
  LLM_JSON_SCHEMA: { group: 'llm', ...bool(), default: false, apply: 'restart', label: '结构化输出（json_schema）', help: '网关不支持时自动退回普通 JSON 模式' },
  PACE_WITH_LLM: { group: 'llm', ...bool(), default: true, apply: 'restart', label: '随 AI 负载放慢时间' },
  PACE_QUEUE: { group: 'llm', ...int(1, 1000), default: 6, apply: 'live', label: '开始放慢时间的排队长度', help: '按世界计算：本世界在队列里积压超过这个数时放慢' },
  PINNED_BUDGET_SHARE: { group: 'llm', ...num(0, 1), default: 0.3, apply: 'live', label: '常驻世界的预算保留比例' },
  PRIORITY_AGING_MIN: { group: 'llm', ...int(1, 1440), default: 30, apply: 'live', label: '低优先级任务防饿死阈值（分钟）' },

  // ---------- 自带模型（按世界配置模型服务，设计见 docs/design/world-llm.md）----------
  SECRETS_KEY: {
    group: 'userLlm', ...str(200), default: '', apply: 'restart', bootstrap: true, secret: true, label: '凭据加密主密钥',
    help: '32 字节（base64 或 hex）。不填时首次启动自动生成 <数据目录>/secret.key；丢失后所有模型服务凭据都要重填，生产环境建议用环境变量提供',
  },
  USER_LLM: { group: 'userLlm', ...bool(), default: true, apply: 'live', label: '允许世界使用自己的模型服务', help: '关闭后用户世界一律使用服务器的模型（凭据保留）；官方世界不受影响' },
  USER_LLM_PROVIDERS: {
    group: 'userLlm', ...list(z.enum(['openai', 'anthropic', 'google'])), default: ['openai', 'anthropic', 'google'], apply: 'live', label: '可以选的服务类型',
    help: 'openai：OpenAI 兼容接口；anthropic / google 需要安装 AI SDK（可选依赖）',
  },
  USER_LLM_PRIVATE_NET: { group: 'userLlm', ...bool(), default: (get) => !get('PUBLIC_MODE'), apply: 'live', label: '允许内网地址与 http', help: '默认只在非公网模式下允许（例如本机的 Ollama）；公网模式下开启有 SSRF 风险' },
  USER_LLM_MAX_CONCURRENCY: { group: 'userLlm', ...int(1, 32), default: 4, apply: 'live', label: '单个自带通道的并发上限' },
  USER_LLM_TOTAL_CONCURRENCY: { group: 'userLlm', ...int(0, 1000), default: 0, apply: 'live', label: '所有自带通道合计的并发上限', help: '0 = 不限' },
  USER_LLM_MAX_TIMEOUT_MS: { group: 'userLlm', ...int(5000, 600000), default: 300000, apply: 'live', label: '自带通道可设的最长超时（毫秒）' },
  USER_LLM_CREDENTIALS_MAX: { group: 'userLlm', ...int(0, 50), default: 5, apply: 'live', label: '每个账号最多几份模型服务凭据' },
  USER_LLM_HALT_NET_FAILS: { group: 'userLlm', ...int(1, 100), default: 8, apply: 'live', label: '连续多少次网络错误后暂停世界', help: '同时要求持续 3 分钟以上' },

  // ---------- 语义检索 ----------
  EMBED_MODEL: { group: 'embed', ...str(200), default: '', apply: 'restart', label: 'embedding 模型', help: '配置后记忆检索同时参考语义相似度' },
  EMBED_BASE_URL: { group: 'embed', ...url(), default: '', apply: 'restart', label: 'embedding 接口地址', help: '不填沿用模型接口地址' },
  EMBED_API_KEY: { group: 'embed', ...str(500), default: '', apply: 'restart', secret: true, label: 'embedding 密钥', help: '不填沿用模型密钥' },
  EMBED_TIMEOUT_MS: { group: 'embed', ...int(100, 60000), default: 4000, apply: 'restart', label: 'embedding 超时（毫秒）' },

  // ---------- 频率与审核 ----------
  RATE_CHAT_PER_HOUR: { group: 'limits', ...int(0, 10000), default: 45, apply: 'live', label: '每个账号每小时聊天句数', help: '另有每分钟 4 句的突发限制' },
  RATE_EVENT_PER_HOUR: { group: 'limits', ...int(0, 1000), default: 4, apply: 'live', label: '每个账号每小时发布事件数' },
  RATE_IP_FACTOR: { group: 'limits', ...num(1, 100), default: 3, apply: 'live', label: '同一 IP 的合计上限倍数', help: '同一 IP 下所有账号合计，不超过单账号额度的这个倍数' },
  EVENT_GLOBAL_COOLDOWN_SEC: { group: 'limits', ...int(0, 86400), default: 120, apply: 'live', label: '世界内两次事件的最短间隔（秒）' },
  WEATHER_COOLDOWN_SEC: { group: 'limits', ...int(0, 86400), default: 60, apply: 'live', label: '世界内两次改天气的最短间隔（秒）' },
  MODERATE_EVENTS: { group: 'limits', ...oneOf(['llm', 'keyword']), default: 'llm', apply: 'live', label: '事件审核方式' },
  MODERATE_CHAT: { group: 'limits', ...oneOf(['llm', 'keyword']), default: 'keyword', apply: 'live', label: '聊天审核方式', help: 'llm 会让每次聊天多一次调用' },
  MAX_QUEUE_FOR_USER: { group: 'limits', ...int(0, 10000), default: 6, apply: 'live', label: '排队超过多少时暂停玩家互动' },
  REPORT_UNLIST_THRESHOLD: { group: 'limits', ...int(1, 1000), default: 5, apply: 'live', label: '自动转为不公开的举报数' },

  // ---------- 账号 ----------
  REGISTER_OPEN: { group: 'accounts', ...bool(), default: true, apply: 'live', label: '开放注册' },
  REGISTER_PER_IP_HOUR: { group: 'accounts', ...int(0, 1000), default: 3, apply: 'live', label: '每个 IP 每小时可注册的账号数' },
  CAPTCHA_SECRET: { group: 'accounts', ...str(500), default: '', apply: 'live', secret: true, label: '人机验证密钥', help: '配置后注册需要通过人机验证（Cloudflare Turnstile）' },
  CAPTCHA_SITEKEY: { group: 'accounts', ...str(200), default: '', apply: 'live', label: '人机验证站点密钥', help: 'Turnstile 的 site key，页面上显示验证组件时用' },
  LOCAL_NICKNAME: { group: 'accounts', ...str(8), default: '旅人', apply: 'live', label: '本地模式的昵称' },

  // ---------- 世界 ----------
  MAX_ACTIVE_WORLDS: { group: 'worlds', ...int(1, 32), default: 4, apply: 'live', label: '同时运行的世界上限', help: '超过后会卸载无人观看、空闲最久的世界' },
  PINNED_WORLDS: { group: 'worlds', ...list(), default: ['yunxi'], apply: 'live', label: '常驻世界', help: '不会被卸载，但计入上限；逗号分隔' },
  DEFAULT_WORLD: { group: 'worlds', ...str(32), default: 'yunxi', apply: 'live', label: '默认世界', help: '旧路径 /api/* 映射到的世界' },
  WORLD_UNLOAD_SEC: { group: 'worlds', ...int(10, 864000), default: 600, apply: 'live', label: '休眠多久后存盘卸载（秒）' },
  WORLD_DISK_MB: { group: 'worlds', ...int(1, 1e6), default: 200, apply: 'live', label: '每个用户世界的默认磁盘上限（MB）' },
  MIGRATION: { group: 'worlds', ...bool(), default: true, apply: 'live', label: '人员流动', help: '世界会自己来新人、有人出门远行再回来；每个世界还可以在世界设置里单独关闭' },
  MIGRATION_DAYS: { group: 'worlds', ...num(1, 365), default: 4, apply: 'live', label: '人员流动的平均间隔（游戏日）', help: '两次变动至少间隔它的 3/4' },
  MIGRATION_CAP: { group: 'worlds', ...num(1, 3), default: 1.5, apply: 'live', label: '人数上限倍数', help: '在场人数最多为世界初始人数的这个倍数' },
  WORLDS_DISK_TOTAL_GB: { group: 'worlds', ...num(0, 1e6), default: 0, apply: 'live', label: '用户世界磁盘总量上限（GB）', help: '0 = 不限；超过后暂停接受新的创世' },

  // ---------- 创世 ----------
  GENESIS_MAX_WORLDS: { group: 'genesis', ...int(0, 1000), default: 2, apply: 'live', label: '默认可创建的世界数' },
  GENESIS_MAX_SOURCE_CHARS: { group: 'genesis', ...int(0, 5e6), default: 60000, apply: 'live', label: '默认原文字数上限' },
  GENESIS_TOKENS: { group: 'genesis', ...int(0, 1e10), default: 400000, apply: 'live', label: '默认创世 token 额度', help: '一次性额度，不按天重置' },
  GENESIS_DAILY_WORLD_TOKENS: { group: 'genesis', ...int(0, 1e10), default: 150000, apply: 'live', label: '默认每个世界每日 token 额度' },

  // ---------- 决策 ----------
  DECISION_WINDOW_MINOR_H: { group: 'decisions', ...num(0, 720), default: 6, apply: 'live', label: '一般决策的终审窗口（小时）', help: '超时后由 AI 裁决官决定' },
  DECISION_WINDOW_MAJOR_H: { group: 'decisions', ...num(0, 720), default: 24, apply: 'live', label: '重大决策的终审窗口（小时）' },

  // ---------- 自主进化 ----------
  EVOLVE: { group: 'evolution', ...oneOf(['off', 'suggest', 'auto']), default: 'off', apply: 'restart', label: '进化引擎', help: 'suggest：插件超时不交给 AI 裁决；auto：完全自主' },
  EVOLVE_BUDGET: { group: 'evolution', ...int(0, 1e10), default: 200000, apply: 'restart', label: '进化每日 token 上限（每个世界）', help: '0 = 不限' },
  EVOLVE_PUBLIC_DEPLOY: { group: 'evolution', ...oneOf(['off', 'data', 'all']), default: 'all', apply: 'restart', label: '公网模式下 AI 可以自动上线的插件' },
  EVOLVE_SANDBOX_NET: { group: 'evolution', ...oneOf(['', 'isolated']), default: '', apply: 'restart', label: '沙箱已在系统层面断网' },
  EVOLVE_MAX_ACTIVE: { group: 'evolution', ...int(0, 1000), default: 20, apply: 'restart', label: '同时运行的 AI 插件上限' },
  EVOLVE_CANARY_DATA_MIN: { group: 'evolution', ...int(1, 1e6), default: 360, apply: 'restart', label: '数据插件灰度时长（游戏分钟）' },
  EVOLVE_CANARY_CODE_MIN: { group: 'evolution', ...int(1, 1e6), default: 1440, apply: 'restart', label: '代码插件灰度时长（游戏分钟）' },
  EVOLVE_CANARY_CODE_REAL_H: { group: 'evolution', ...num(0, 1000), default: 2, apply: 'restart', label: '代码插件灰度的最短真实时长（小时）' },
  EVOLVE_RETIRE_DAYS: { group: 'evolution', ...int(1, 10000), default: 30, apply: 'restart', label: '多少游戏日没被用到就提议退役' },
  EVOLVE_REVIEW_MODEL: { group: 'evolution', ...str(200), default: '', apply: 'restart', label: '评审模型', help: '建议与实施用的模型不同' },
  EVOLVE_REVIEW_BASE_URL: { group: 'evolution', ...url(), default: '', apply: 'restart', label: '评审模型接口地址' },
  EVOLVE_REVIEW_API_KEY: { group: 'evolution', ...str(500), default: '', apply: 'restart', secret: true, label: '评审模型密钥' },
  EVOLVE_INTERVAL_MIN: { group: 'evolution', ...num(0.1, 10000), default: 20, apply: 'restart', label: '两个需求之间的间隔（分钟）' },
  EVOLVE_SHADOW_HOURS: { group: 'evolution', ...int(1, 240), default: 6, apply: 'restart', label: '影子试运行的游戏小时数' },
  EVOLVE_IDEAS: { group: 'evolution', ...bool(), default: true, apply: 'restart', label: '没有需求时让引擎自己想点子' },
  PLUGINS_DISABLE: { group: 'evolution', ...list(), default: [], apply: 'restart', label: '不加载的内置插件' },

  // ---------- 世界级（多世界设计 §14.8：属于某个世界，只在世界设置里改；环境变量只在迁移时写入官方世界）----------
  STORY_RATING: { group: 'world', scope: 'world', ...oneOf(['cozy', 'adventure', 'epic', 'dark', 'tragic']), default: 'cozy', apply: 'restart', label: '内容分级' },
  STORYTELLER: { group: 'world', scope: 'world', ...oneOf(['gentle', 'voyage', 'chaos', 'horror']), default: 'voyage', apply: 'restart', label: '叙事者' },
  MODS: { group: 'world', scope: 'world', ...list(), default: [], apply: 'restart', label: '加载的 Mod' },

  // ---------- 开发与测试 ----------
  LLM_RECORD: { group: 'dev', dev: true, ...str(500), default: '', apply: 'restart', label: '录制模型回复到文件' },
  CHROME: { group: 'dev', dev: true, ...str(500), default: '', apply: 'restart', label: '浏览器检查用的 Chrome 路径' },
  EVOLVE_DAEMON: { group: 'dev', dev: true, ...bool(), default: true, apply: 'restart', label: '随服务启动进化引擎' },
};

/** 把环境变量 / 设置文件里的字符串解析成声明的类型（不做范围校验） */
export function parseString(def, s) {
  if (def.parse) return def.parse(s);
  switch (def.kind) {
    case 'int': case 'number': return s.trim() === '' ? NaN : Number(s);
    case 'bool':
      if (/^(1|true|yes|on)$/i.test(s)) return true;
      if (/^(0|false|no|off)$/i.test(s)) return false;
      return s;
    case 'list': return s.split(',').map((x) => x.trim()).filter(Boolean);
    default: return s;
  }
}

/** 把值写回环境变量字符串（给仍然接受 env 对象的模块用） */
export function toEnvString(def, v) {
  if (v === undefined || v === null) return undefined;
  if (def.kind === 'bool') return v ? '1' : '0';
  if (def.kind === 'list') return v.join(',');
  return String(v);
}

/** 校验一个值：返回 { ok, value } 或 { ok: false, error } */
export function checkValue(def, v) {
  const r = def.type.safeParse(v);
  if (r.success) return { ok: true, value: r.data };
  const issue = r.error.issues[0];
  const detail = issue?.code === 'too_small' ? `不能小于 ${issue.minimum}` : issue?.code === 'too_big' ? `不能大于 ${issue.maximum}`
    : issue?.code === 'invalid_value' || def.kind === 'enum' ? `只能是 ${(def.values || []).map((x) => x || '（空）').join(' / ')}`
      : def.kind === 'int' ? '应为整数' : def.kind === 'number' ? '应为数字' : def.kind === 'bool' ? '应为开 / 关' : issue?.message || '不合法';
  return { ok: false, error: detail };
}
