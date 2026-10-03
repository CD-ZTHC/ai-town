# 重构方案 P0：线上诊断记录

> 日期：2026-09-28 17:44（服务器 15:54 重启后约 1 小时 50 分钟；ai-town 进程运行了 37 分钟）
> 方式：`ssh town` 上只读的命令（`ps`、`free`、`/proc`、`ss`、Caddyfile），外加从公网请求静态资源看响应头。**没有改动线上任何东西。**
> 对应：[refactor-plan.md](../design/refactor-plan.md) §4。

## 一、结论

| 方案里的假设 | 实测 | 判断 |
| --- | --- | --- |
| M1 没有 cgroup 内存上限 | 仍是 `nohup mise run start`，没有 systemd | **成立**。earlyoom 已装（`-m 7,4`），可以兜底，但 ai-town 本身仍没有上限 |
| M2 子进程没有堆上限 | 服务进程已通过 `.env` 的 `NODE_OPTIONS=--max-old-space-size=384` 设了上限；进化已关（`EVOLVE=off`），没有引擎和试运行进程 | 服务进程已缓解；子进程上限由 P2 的代码修复（`CHILD_HEAP_MB`） |
| M3 SSE 没有背压 | 当时只有 1 个 SSE 连接 | 当时不是主因，但本地复现证实会持续涨内存（见 P2 的 PR） |
| M7 存档全量序列化 | **云溪镇 `save.json` 已有 3.0MB**（方案里估计 640KB），夜巡 925KB、小红帽 459KB | **比预想严重**：每 20 秒对 3MB 做一次 `JSON.stringify` + 同步写盘；P5（SQLite 增量写入）的优先级应该提高 |
| 包装进程的开销 | `mise run start` 40MB + 守护进程 `main.js` 64MB + 服务进程 172MB | **包装进程占了 ai-town 总内存的 38%**；改用 systemd 直接启动 `node` 能省下 mise 的 40MB |
| C4 中间层改写缓存头 | **成立**：前面有 Cloudflare，JS / CSS 的 `Cache-Control: no-cache` 被改成了 `max-age=14400` | **这很可能是「更新后仍是旧版本」的主因之一**：部署后 HTML 是新的，但浏览器最多 4 小时内继续用旧的 JS / CSS |

## 二、内存

整机（2 核，总内存 1690MB，zram 845MB + 交换文件 2GB，`swappiness` 见上次的调整记录）：

```
               total        used        free      shared  buff/cache   available
Mem:            1690         687          80          17         922         809
Swap:           2893         359        2534
/proc/pressure/memory: some avg10=1.26 avg60=0.22 avg300=0.04
```

内存压力很低（`some avg60 = 0.22`，验收线是长期低于 5）。内核日志里没有 OOM 记录。

ai-town 相关进程（RSS）：

| 进程 | RSS |
| --- | --- |
| 服务进程 `server/index.js` | 172MB（峰值 176MB；匿名内存 115MB） |
| 守护进程 `server/main.js` | 64MB |
| `mise run start` | 40MB |
| **合计** | **约 276MB** |

同机其他主要进程：next-server 63MB、dockerd 47MB、new-api 41MB、caddy 33MB、rabbitmq 28MB、3 个飞书机器人 JVM 合计 72MB（已限制为 `-Xmx96m`）。

线上设置：`NODE_OPTIONS=--max-old-space-size=384`、`EVOLVE=off`、`IDLE_PAUSE_SEC=90`；`MAX_ACTIVE_WORLDS`、`LLM_CONCURRENCY`、`EMBED_MODEL` 用默认值（未启用 embedding）。

### 存档体积

| 世界 | `save.json` |
| --- | --- |
| 云溪镇 | **3.0MB** |
| 夜巡 | 925KB |
| 小红帽 | 459KB |
| 狼外婆 | 228KB |

数据目录合计 66MB。按本地一份 640KB 的云溪镇存档拆分：居民占 54%（其中记忆占居民的 80%），动态流 20%，对话记录 19%。线上的居民更多（人员流动）、记忆更满，所以更大。每 20 秒对它做一次全量序列化，是目前最确定的周期性内存与 CPU 峰值来源。

## 三、前端缓存（C1~C5）

从公网请求（经过 Cloudflare → Caddy → ai-town）：

| 请求 | `Cache-Control` | `cf-cache-status` |
| --- | --- | --- |
| `/`、`/w/yunxi/`（HTML） | `no-cache`（原样） | `DYNAMIC`（不缓存） |
| `/js/main.js`、`/style.css` | **`max-age=14400`**（源站是 `no-cache`） | `MISS` / `EXPIRED`（边缘在缓存） |
| `/js/main.js?v=abc` | `max-age=14400` | `MISS`（查询参数计入缓存键） |
| 接口、`/healthz` | 原样 | `DYNAMIC` |

条件请求能拿到 304（弱 ETag 也行，Caddy 的压缩没有破坏）。

- **C4 成立**：Cloudflare 的「浏览器缓存 TTL」设成了 4 小时，覆盖了源站的 `no-cache`。部署后新打开的页面拿到新 HTML，却可能用着 4 小时内缓存的旧模块 → 新旧混杂、报错或看起来还是旧版本。
- P2b（带内容哈希的 URL + import map）能直接解决：新 HTML 引用的是新 URL，浏览器和 Cloudflare 边缘都拿不到旧内容；带正确哈希的资源源站返回 `max-age=31536000, immutable`，比 4 小时长，Cloudflare 不会再改短。
- **建议同时在 Cloudflare 把「Browser Cache TTL」改为「Respect Existing Headers」**，这样 `no-cache` 的请求（没有版本号、或版本号不对的）也按源站的意思走。
- C1（页面不刷新）、C2（bfcache）、C3（微信内置浏览器）、C5（部署窗口）无法从服务器侧观测，需要结合用户反馈；P2b 的更新提示与 `boot.js` 对它们都有覆盖。

## 四、顺带发现的问题（不在方案内，需要确认后再处理）

1. **服务端拿到的访客 IP 很可能是 Cloudflare 节点的 IP**（根据配置推断，未直接验证）。Caddy 没有配置 `trusted_proxies`，会用直接连过来的地址（Cloudflare 节点）改写 `X-Forwarded-For`；ai-town 的 `TRUST_PROXY=1` 取的就是它。后果：同一个 Cloudflare 节点后面的所有访客共用「每 IP 同时打开 6 个页面」和各项频率限制，访客多时会互相挤掉（429「同时打开的页面太多了」）。
   建议：Caddy 的 `servers` 里加 `trusted_proxies static <Cloudflare 的 IP 段>`，并把 `TRUST_PROXY` 改为 2；或者让 ai-town 支持读取 `CF-Connecting-IP`（只在 `TRUST_PROXY` 开启时）。
2. **Caddy 的管理接口监听在 `0.0.0.0:2019`**，服务器本机没有防火墙（`ufw inactive`、`iptables INPUT ACCEPT`）。如果阿里云安全组没有挡住 2019 端口，任何人都可以通过它改写 Caddy 的配置。**建议尽快确认安全组，或把 `admin` 改为 `localhost:2019`。**（本机的 DNS 走了代理的 fake-ip，从这里测不出公网能否连通。）

## 五、对后续阶段的影响

- **P1**：换成 systemd 直接启动 `node`，去掉 mise 包装进程（省约 40MB）；守护进程加 `--max-old-space-size=64`。ai-town 在这台共用机器上的 cgroup 上限不能按方案里「独占 2G」的 1400MB 算：服务进程堆 384MB + 守护 64MB + 按需的沙箱 / 试运行，建议 `MemoryHigh=600M`、`MemoryMax=768M`（见 `deploy/ai-town.service`）。
- **P2**：SSE 背压当时不是主因，但属于「访客一多就会出事」的类型，已修；子进程堆上限与试运行锁已加上。
- **P2b**：C4 已确认，优先上线。
- **P5**：3MB 的存档说明全量序列化的代价已经不小，建议 P4 的前几个批次完成后就做 P5，不必等 P4 全部结束。
