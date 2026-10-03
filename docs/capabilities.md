# 能力清单（自动生成）

> 由 `mise run manifest` 从代码生成，请勿手工编辑。这就是 AI（叙事导演、世界架构师）当前能使用的全部能力。

## 世界操作（WorldOp）

| 操作 | 审批等级 | 架构师可用 | 参数 |
| --- | --- | --- | --- |
| `setParam` | major | — | 仅管理员 / 剧情弧使用 |
| `setMeta` | major | — | 仅管理员 / 剧情弧使用 |
| `addCanon` | micro | ✅ | {"text":"写进小镇历史的事实（≤100字）","tags":["标签"]} |
| `addThread` | micro | — | 仅管理员 / 剧情弧使用 |
| `addCalendarEvent` | minor | ✅ | {"id","name":"≤16字","emoji","day":第几天（必须大于今天）,"from":"HH:MM","location":"地点id","hint":"≤60字","countdown":true} |
| `addWeather` | minor | ✅ | {"id","name":"≤8字","emoji","weight":0~20,"render":{"base":"sunny/cloudy/rain/storm/fog/snow","tint":"#rrggbb","tintAlpha":0~0.5}} |
| `setWeatherWeights` | major | — | 仅管理员 / 剧情弧使用 |
| `addItem` | micro | ✅ | {"id","name":"≤8字","emoji","desc":"≤40字"} |
| `addStructure` | minor | ✅ | {"id","name":"≤8字","emoji","ttl":10~240,"tags":["light"],"light":{"r":20~160,"color":"255,200,100"}} |
| `addAbility` | minor | ✅ | {"id","name":"≤8字","emoji","target":"self/agent/area","desc":"≤50字","aiHint":"≤50字","cost":{"stamina":0~40,"items":{"物品id":1~3}},"cooldown":0~1440,"requires":"表达式(可选)","effects":[效果，最多8个],"learn":{"teach":true,"research":{"location":"地点id","keywords":["关键词"]}},"combat":{"windup":0~12,"recover":0~20,"range":1~8,"shape":"single/circle/line/cone","radius":0~6,"cd":0~400}(可选)} —— 写了 combat 块就是战斗招式（拍数，一拍 0.25 秒）：蓄力 windup 拍后生效，招式命中的敌人由 shape 决定，效果里用 strike / status / knockback；例：{"combat":{"windup":3,"range":5,"shape":"line","cd":16},"effects":[{"op":"strike","power":1.5,"tags":["fire"]},{"op":"status","status":"slow","beats":8}]} |
| `addBuilding` | minor | ✅ | {"id":"英文小写id","name":"≤10字","kind":"英文小写类型，如 tower/shrine/shop/garden","w":3~7,"h":3~6,"place":{"near":"地点id","within":6~16},"roof":"#rrggbb","wall":"#rrggbb","sign":"一个emoji","desc":"≤60字","lightAtNight":true/false} —— 不要写坐标，系统会在 near 附近自动找空地；新建筑会成为居民可以去的地点 |
| `setBuildingState` | minor | ✅ | {"id":"现有建筑id","state":"closed 停业 / damaged 受损 / ruin 废墟","reason":"≤30字"} —— 变成废墟与拆除一样要给出 remap（见 removeBuilding），并经过居民议事 |
| `renovateBuilding` | minor | ✅ | {"id":"现有建筑id","name":"新名字≤10字(可选)","kind":"新类型(可选)","desc":"≤60字(可选)","sign":"emoji(可选)","roof":"#rrggbb(可选)","public":true/false(可选)} —— 改建 / 换用途：占地不变，住户与所有引用照旧；闲置或不合用的建筑优先改建而不是拆 |
| `removeBuilding` | major | ✅ | {"id":"现有建筑id","remap":{"residents":"住户搬去的建筑id","workers":"在这里工作的人改去的地点id","location":"节日、规则等引用的替代地点id"}} —— 拆除，原址变成空地；remap 不写时系统就近安排；要经过居民议事（住户不同意时需要其他居民全票同意） |
| `restoreBuilding` | minor | ✅ | {"id":"停业、受损或成了废墟的建筑id"} —— 修好、重新开门 |
| `addPath` | minor | ✅ | {"from":"地点id","to":"地点id","surface":"path 石板 / dirt 泥路（可选）"} —— 修一条路：系统找最省事的路线（砍掉挡路的树丛，窄水面顺带架桥）；居民往返变近时用 |
| `addBridge` | major | ✅ | {"near":"地点id"} —— 在附近最窄的水面上架桥（大改） |
| `clearArea` | minor | ✅ | {"near":"地点id","w":3~10,"h":3~10} —— 清理附近的树丛石头，腾出空地（为以后建房） |
| `plantGrove` | minor | ✅ | {"near":"地点id","w":2~8,"h":2~8,"trees":"oak/pine/sakura（可选）"} —— 在附近的空草地上种一片树 |
| `addOutdoorPlace` | minor | ✅ | {"id":"英文小写id","kind":"garden/orchard/market/plaza/field/pond/well/camp/shrine/clearing/grove/meadow","name":"≤16字","emoji","desc":"≤60字","near":"地点id"} —— 新的户外去处，系统在附近找空地画出来 |
| `expandMap` | major | ✅ | {"side":"north/south/east/west","by":8~24,"biome":"meadow/village/forest/…","name":"新地块的名字≤16字","places":[{"id":"英文小写id","kind":"house/cottage/shop/inn/…或 garden/orchard/market/…","name":"≤16字","emoji","desc":"≤60字"}]（最多6个）} —— 地图向一边长出一片新地方（大改）；空地不够、镇子要长大时用；地图最大 96×64 |
| `addRegion` | major | ✅ | {"id","name","biome","areas":[同上]} —— 远处的新地方（北山、河对岸的村子、异界…）；必须同时用 linkRegions 打通（大改） |
| `linkRegions` | minor | ✅ | {"region":"区域id","open":true,"entry":"主地图上的路口地点id","gateName":"路口的名字，如 北山山口"} |
| `addAdjacentRegion` | major | ✅ | {"id":"英文小写id","name":"如 城东","from":"相邻的哪张地图（默认 town）","side":"north/south/east/west","length":32~96,"fromName":"原来那张地图的新称呼，如 城中（可选）","biome","areas":[{"id","biome","size":"small/medium/large","places":[{"id","kind","name","emoji","desc"}]}]} —— 某个方向的地图到了 96×64 的上限、镇子还要往那边长时，在那一侧新建一张相邻的地图（大改）；接壤的边上自动开通道，走到边缘就过去了 |
| `addPersona` | major | — | 仅管理员 / 剧情弧使用 |
| `setPersonaStatus` | major | — | 仅管理员 / 剧情弧使用 |
| `settlePersona` | major | — | 仅管理员 / 剧情弧使用 |
| `setAvatarKit` | minor | ✅ | {"ids":["带 combat 块的能力id"]（最多4个）} —— 旅人（玩家）在游戏模式里能用的技能栏，整体替换 |
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
| `kill` | 内核 | {"op":"kill","target":"self/target/e","text":"≤40字，一笔带过的描写，可用 {self}"} 让人死去（分级不允许、死亡预算用完或有主角光环时降为重伤） |
| `wound` | 内核 | {"op":"wound","amount":5~100,"target":…} 受伤（hp 降到 30 以下为重伤，送去休养） |
| `heal` | 内核 | {"op":"heal","amount":5~100,"target":…} 治疗伤势 |
| `casualties` | 内核 | {"op":"casualties","min":0~50,"max":0~50,"text":"≤30字"} 当地的群众伤亡（只记数字） |
| `clue` | 内核 | {"op":"clue","kind":"rule/next_victim/origin","threat":"威胁id(可选)","target":…} 得到一条关于威胁的线索（规律 / 下一个受害者 / 来历） |
| `burden` | 内核 | {"op":"burden","id":"负担id","amount":-100~100 或 "freeze":10~1440,"target":…} 改变或冻结负担值 |
| `spawnThreat` | 内核 | {"op":"spawnThreat","threat":"威胁id" 或 "from":"host","target":"self/target"} 在某人身边出现一个威胁；from 为 host 时，是这个人身上寄宿的威胁脱出 |
| `host` | 内核 | {"op":"host","threat":"威胁id","target":…} 让某人成为某个威胁的宿主（寄宿后获得它的能力，也背上它的负担值） |
| `suppress` | 内核 | {"op":"suppress","power":1~10,"minutes":5~240,"radius":1~8} 压制身边的威胁：强度够的话，它在这段时间里不能移动，规律也不生效 |
| `damage` | 内核 | {"op":"damage","amount":1~100,"tags":["弱点标签"],"radius":1~8} 攻击身边会死的威胁（杀不死的威胁只会停顿一会儿） |
| `worldOp` | 内核 | {"op":"worldOp","action":"addRegion/addAdjacentRegion/linkRegions/expandMap/addBuilding/addOutdoorPlace/plantGrove/addPath/addPersona/addWeather/setWeatherWeights/addItem/addCanon","args":{同世界操作},"generate":"意图（可选，≤80字）"} 创世：直接改变世界的结构（只能写在世界包里）；写了 generate 时由模型按意图现场设计新地方的布局（addRegion/addAdjacentRegion/expandMap），args 是兜底 |
| `transform` | 内核 | {"op":"transform","text":"≤40字，可用 {self}","memory":"≤40字，其他人记住的事"} 化身：这个人离开世界（不算死亡），之后的效果照常执行 |
| `stage` | 内核 | {"op":"stage","template":"intro/moment/reveal/aftermath/genesis","target":"self/target/threat/at/loc:地点id/agent:居民id/region:区域id","name":"≤40字","title":"≤40字","text":"≤40字","ai":"让模型写旁白的提示（可选）","priority":"minor/major"} 演出：镜头、黑边、慢镜、名字卡、横幅、旁白（也可以用 steps 写分镜：[{"do":"focus/letterbox/slow/card/banner/narrate/flash/shake/vfx/reveal/sound/wait",…}]，最多 12 步、15 秒）；普通演出全世界 30 秒最多一次 |
| `weather` | 内核 | {"op":"weather","id":"天气id","minutes":30~1440} 天气立刻变成某种，持续一段时间后恢复自动天气 |
| `cast` | 内核 | {"op":"cast","ability":"能力id","target":"self/e"} 让这个人立即使用一项能力（剧情、规则里用；照常检查条件、消耗、冷却） |
| `strike` | 内核 | {"op":"strike","power":0.2~5,"add":0~80,"tags":["弱点标签"]} 战斗招式：对命中的敌人造成伤害（攻击力×power+add）；不在战斗中时打身边会死的威胁 |
| `status` | 内核 | {"op":"status","status":"stun/root/shield/haste/slow/bleed/weaken/guard","beats":1~40,"amount":0~100,"target":"self/target"} 战斗招式：给自己或命中的敌人挂状态（拍数；护盾、流血、架势用 amount） |
| `knockback` | 内核 | {"op":"knockback","cells":1~4} 战斗招式：把命中的敌人击退几格 |
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
- `seen`：seen(e) 在威胁的规律里：e 看得见这个威胁（6 格内、没闭眼、没睡着）
- `near`：near(e, 半径=3) 在威胁的规律里：e 离这个威胁不超过半径
- `heard`：heard(e, '声音id') e 最近 10 分钟内听到了某种声音（威胁发出的）
- `opened`：opened(e) e 最近 10 分钟内开门进过屋
- `entered`：entered(e, '地点id') e 此刻在某地点
- `speaking`：speaking(e) e 最近 2 分钟内在对话里说过话
- `named`：named(e) e 最近 30 分钟内被人当面叫了名字
- `alone`：alone(e) e 身边 4 格内没有醒着的人
- `asleep`：asleep(e) e 在睡觉
- `night`：night() 现在是夜里（20:00~05:00）
- `marked`：marked(e) e 被这个威胁（不在威胁的规律里时：任何威胁）标记了
- `inZone`：inZone(e) e 在这个威胁（或任何威胁）的区域里
- `posture`：posture(e, 'eyesClosed/silent/noOpen/stayLit/notAlone') e 正保持着某种禁忌姿态
- `burden`：burden(e, '负担id') e 的负担值
- `anchors`：anchors(e, 好感阈值=50) e 身边好感达到阈值、还活着的人数
- `believes`：believes(e, '话题') e 对某个话题的确信度（0~1，没有这个看法时为 0）
- `flag`：flag('标记名') 世界标记是否为真
- `hosts`：hosts(e, '威胁id') e 身上寄宿着某个威胁

## 其他可用资源

- 特效预设：glow_ring、sparkle、heal、notes、burst、ripple、split、quake
- 生物体型：wisp、hound、warden
- 可调参数：`walkSpeed`（2~5）、`maxConvos`（1~6）、`convoBaseProb`（0.05~0.6）、`reflectThreshold`（20~80）、`dayEnd`（1260~1500）、`deathNamed`（0~20）、`deathDays`（1~14）
- 地点：`cafe` 星光咖啡馆、`library` 云溪图书馆、`tavern` 月光酒馆、`clinic` 云溪诊所、`workshop` 铁柱工坊、`square` 中央广场、`market` 广场集市、`park` 樱花公园、`farm` 陈家农场、`pier` 镜湖码头
- 异界地点（不能建房）：`moon_gate` 月之渡口·彼岸（moonrealm）、`moon_plaza` 暗月广场（moonrealm）、`moon_garden` 月光花园（moonrealm）、`moon_lookout` 星坠崖（moonrealm）
- 物品：`lantern` 萤火灯、`wood` 木材、`herb` 草药、`melon` 西瓜、`county_record` 县志残页、`moonstone` 月石、`moon_dew` 月露、`moon_lantern` 双月灯
- 能力：`firefly_shot` 萤火弹、`bell_ring` 铃铛震、`warm_tea` 热茶、`firefly_ward` 萤火结界、`warm_coffee` 暖心咖啡、`checkup` 问诊、`moon_song` 月光之歌、`craft_lantern` 扎萤火灯、`old_tale` 讲古、`pick_melon` 摘西瓜、`gather_dew` 采月露、`share_dew` 赠月露、`pick_moonstone` 拾月石、`star_wish` 星坠许愿、`craft_moon_lantern` 扎双月灯、`release_moon_lantern` 放双月灯

## 已加载的扩展（插件）

- 效果 `goTo`（go-to）：{"op":"goTo","location":"地点id","activity":"≤14字","minutes":30~180,"target":"self/target/e/nearby/all","radius":1~6} 让对象立刻动身前往某地（插入一段即时日程；睡着或正在交谈的人不受影响）
