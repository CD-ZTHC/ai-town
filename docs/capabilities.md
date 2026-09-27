# 能力清单（自动生成）

> 由 `mise run manifest` 从代码生成，请勿手工编辑。这就是 AI（叙事导演、世界架构师）当前能使用的全部能力。

## 世界操作（WorldOp）

| 操作 | 审批等级 | 架构师可用 | 参数 |
| --- | --- | --- | --- |
| `setParam` | major | — | 仅管理员 / 剧情弧使用 |
| `setMeta` | major | — | 仅管理员 / 剧情弧使用 |
| `addCanon` | micro | ✅ | {"text":"写进小镇历史的事实（≤100字）","tags":["标签"]} |
| `addCalendarEvent` | minor | ✅ | {"id","name":"≤16字","emoji","day":第几天（必须大于今天）,"from":"HH:MM","location":"地点id","hint":"≤60字","countdown":true} |
| `addWeather` | minor | ✅ | {"id","name":"≤8字","emoji","weight":0~20,"render":{"base":"sunny/cloudy/rain/storm/fog/snow","tint":"#rrggbb","tintAlpha":0~0.5}} |
| `addItem` | micro | ✅ | {"id","name":"≤8字","emoji","desc":"≤40字"} |
| `addStructure` | minor | ✅ | {"id","name":"≤8字","emoji","ttl":10~240,"tags":["light"],"light":{"r":20~160,"color":"255,200,100"}} |
| `addAbility` | minor | ✅ | {"id","name":"≤8字","emoji","target":"self/agent/area","desc":"≤50字","aiHint":"≤50字","cost":{"stamina":0~40,"items":{"物品id":1~3}},"cooldown":0~1440,"requires":"表达式(可选)","effects":[效果，最多8个],"learn":{"teach":true,"research":{"location":"地点id","keywords":["关键词"]}}} |
| `addBuilding` | minor | ✅ | {"id":"英文小写id","name":"≤10字","kind":"英文小写类型，如 tower/shrine/shop/garden","w":3~7,"h":3~6,"place":{"near":"地点id","within":6~16},"roof":"#rrggbb","wall":"#rrggbb","sign":"一个emoji","desc":"≤60字","lightAtNight":true/false} —— 不要写坐标，系统会在 near 附近自动找空地；新建筑会成为居民可以去的地点 |
| `addRegion` | major | — | 仅管理员 / 剧情弧使用 |
| `linkRegions` | minor | — | 仅管理员 / 剧情弧使用 |
| `addPersona` | major | — | 仅管理员 / 剧情弧使用 |
| `setPersonaStatus` | major | — | 仅管理员 / 剧情弧使用 |
| `settlePersona` | major | — | 仅管理员 / 剧情弧使用 |
| `addRule` | major | ✅ | {"id","name":"≤16字","when":{"every":10~1440} 或 {"at":"HH:MM"} 或 {"weather":"天气id"} 或 {"enter":"地点id"},"forEach":"agent"(可选),"if":"表达式(可选)","then":[效果]} |

## 效果原语

| 效果 | 来源 | 格式与作用 |
| --- | --- | --- |
| `stat` | 内核 | {"op":"stat","stat":"hp/stamina/courage","add":-30~30 或 "set":0~100,"target":"self/target/e/nearby/all","radius":1~6} 改变体力、勇气等 |
| `condition` | 内核 | {"op":"condition","add":"≤6字" 或 "remove":"≤6字","target":…} 添加或移除状态（如 受惊、疲惫） |
| `mood` | 内核 | {"op":"mood","text":"两字","emoji":"一个emoji","target":…} 设置心情 |
| `memory` | 内核 | {"op":"memory","text":"≤80字，可用 {self} {target}","importance":1~8,"target":…} 写入记忆 |
| `belief` | 内核 | {"op":"belief","about":"≤12字话题","claim":"≤40字看法","confidence":0~1,"target":…} 写入信念 |
| `affinity` | 内核 | {"op":"affinity","toward":"self/target","delta":-10~10,"target":…} 改变好感 |
| `giveItem` | 内核 | {"op":"giveItem","item":"物品id","count":1~5,"target":…} 获得物品 |
| `takeItem` | 内核 | {"op":"takeItem","item":"物品id","count":1~5,"target":…} 失去物品 |
| `flag` | 内核 | {"op":"flag","name":"英文小写","value":布尔/数字/字符串} 设置世界标记 |
| `spawn` | 内核 | {"op":"spawn","structure":"构筑物id","ttl":10~240,"target":"self/target"} 在身边生成构筑物 |
| `vfx` | 内核 | {"op":"vfx","preset":"glow_ring/sparkle/heal/notes/burst/ripple","color":"#rrggbb","radius":0.5~6} 播放特效 |
| `say` | 内核 | {"op":"say","text":"≤40字","target":"self/target"} 说一句话（气泡） |
| `log` | 内核 | {"op":"log","text":"≤60字"} 在动态栏记一笔 |
| `paramMod` | 内核 | {"op":"paramMod","name":"参数名","mul":0.5~2 或 "add":-60~60,"ttl":10~600} 临时调整内核参数 |
| `grantAbility` | 内核 | {"op":"grantAbility","ability":"能力id","target":…} 授予能力 |
| `goTo` | 扩展 | {"op":"goTo","location":"地点id","activity":"≤14字","minutes":30~180,"target":"self/target/e/nearby/all","radius":1~6} 让对象立刻动身前往某地（插入一段即时日程；睡着或正在交谈的人不受影响） |

## 表达式函数

- `has`：has(e, '物品id', 数量=1) 身上是否有某物品
- `count`：count(e, '物品id') 物品数量
- `knows`：knows(e, '能力id') 是否会某能力
- `hasCondition`：hasCondition(e, '状态') 是否处于某状态
- `nearStructure`：nearStructure(e, '标签', 半径=3) 附近是否有带该标签的构筑物
- `nearAgents`：nearAgents(e, 半径=3) 附近醒着的人数
- `min`：min(a, b…)
- `max`：max(a, b…)
- `abs`：abs(x)
- `rand`：rand() 0~1 随机数

## 其他可用资源

- 特效预设：glow_ring、sparkle、heal、notes、burst、ripple
- 生物体型：wisp、hound、warden
- 可调参数：`walkSpeed`（2~5）、`maxConvos`（1~6）、`convoBaseProb`（0.05~0.6）、`reflectThreshold`（20~80）、`dayEnd`（1260~1500）
- 地点：`cafe` 星光咖啡馆、`library` 云溪图书馆、`tavern` 月光酒馆、`clinic` 云溪诊所、`workshop` 铁柱工坊、`square` 中央广场、`market` 广场集市、`park` 樱花公园、`farm` 陈家农场、`pier` 镜湖码头
- 异界地点（不能建房）：`moon_gate` 月之渡口·彼岸（moonrealm）、`moon_plaza` 暗月广场（moonrealm）、`moon_garden` 月光花园（moonrealm）、`moon_lookout` 星坠崖（moonrealm）
- 物品：`lantern` 萤火灯、`wood` 木材、`herb` 草药、`melon` 西瓜、`county_record` 县志残页、`moonstone` 月石、`moon_dew` 月露、`moon_lantern` 双月灯
- 能力：`firefly_ward` 萤火结界、`warm_coffee` 暖心咖啡、`checkup` 问诊、`moon_song` 月光之歌、`craft_lantern` 扎萤火灯、`old_tale` 讲古、`pick_melon` 摘西瓜、`gather_dew` 采月露、`share_dew` 赠月露、`pick_moonstone` 拾月石、`star_wish` 星坠许愿、`craft_moon_lantern` 扎双月灯、`release_moon_lantern` 放双月灯

## 已加载的扩展（插件）

- 效果 `goTo`（go-to）：{"op":"goTo","location":"地点id","activity":"≤14字","minutes":30~180,"target":"self/target/e/nearby/all","radius":1~6} 让对象立刻动身前往某地（插入一段即时日程；睡着或正在交谈的人不受影响）
