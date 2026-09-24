// 默认剧情内容：剧情线程、异界生物图鉴、剧情弧模板《镜湖裂隙》。
// 这些都是世界规格里的数据；叙事导演与剧情弧引擎读取它们，AI 之后也可以通过 WorldOp 扩充。

// ---------- 剧情线程：从居民的人设与记忆中整理出的未解之事（导演的首要任务是把它们编进剧情并回收）----------
export const DEFAULT_THREADS = () => [
  { id: 'concert', title: '萤火节露天音乐会', owners: ['lin', 'he'], hook: '晓雨想在萤火节办露天音乐会，还缺舞台、灯光和乐手' },
  { id: 'waterwheel', title: '农场的旧水车', owners: ['chen', 'zhao'], hook: '大山的旧水车坏了，铁柱答应帮忙却一直没顾上' },
  { id: 'confession', title: '苏墨的心意', owners: ['su', 'lin'], hook: '苏墨暗恋晓雨多年，小说也卡在了「该不该开口」' },
  { id: 'balloon', title: '铁柱的热气球', owners: ['zhao'], hook: '铁柱在后院偷偷造热气球，还缺一块足够大的布' },
  { id: 'sun_health', title: '孙婆婆的记性', owners: ['zhou', 'sun'], hook: '周医生担心孙婆婆的记性越来越差' },
  { id: 'treasure', title: '镜湖宝藏探秘', owners: ['wang'], hook: '小乐想拍一期「镜湖百年宝藏」上热搜' },
  { id: 'letter', title: '没有署名的信', owners: ['he'], hook: '何月收到一封匿名信：「萤火节那晚，老地方见」' },
  { id: 'legend', title: '传说的后半段', owners: ['sun', 'su'], hook: '孙婆婆知道镜湖传说里没人知道的后半段' },
  { id: 'daughter', title: '大山的女儿', owners: ['chen'], hook: '大山很想女儿回来过萤火节，却说不出口' },
];

// ---------- 异界生物图鉴 ----------
// bodyPlan 决定前端的像素造型；behavior.archetype 决定日常行为（规则驱动，不调用 LLM）
export const DEFAULT_CREATURES = () => ({
  shade_wisp: {
    name: '影灵', emoji: '👻', origin: '镜湖彼岸的暗月界', tags: ['shadow', 'otherworld'], temperament: 'mischievous',
    look: { bodyPlan: 'wisp', body: '#3a2f6b', glow: '#8f7bff', eyes: '#f5e663' },
    stats: { hp: 30, speed: 3.4, courage: 35 },
    behavior: { archetype: 'thief', targets: ['farm', 'pier', 'square', 'market'], fleeFrom: 'light', active: ['19:00', '05:30'] },
    weakness: ['强光', '萤火灯', '歌声'],
    lore: '暗月界的光正在熄灭，它们循着萤火而来，爱偷亮晶晶的东西和甜甜的西瓜。',
  },
  shade_hound: {
    name: '影犬', emoji: '🐺', origin: '镜湖彼岸的暗月界', tags: ['shadow', 'otherworld'], temperament: 'hostile', minRating: 'adventure',
    look: { bodyPlan: 'hound', body: '#241d45', glow: '#6b5bd6', eyes: '#ff6b6b' },
    stats: { hp: 50, speed: 3.8, courage: 55 },
    behavior: { archetype: 'chaser', targets: ['square', 'park', 'pier'], fleeFrom: 'light', active: ['19:30', '05:00'] },
    weakness: ['强光', '萤火灯'],
    lore: '守门人的猎犬，会追着落单的人跑，但只要灯光够亮就会呜咽着退开。',
  },
  moon_warden: {
    name: '暗月守门人', emoji: '🌑', origin: '暗月界', tags: ['shadow', 'otherworld', 'leader'], temperament: 'solemn', leader: true,
    look: { bodyPlan: 'warden', body: '#1d1838', glow: '#b9a8ff', eyes: '#f3f0ff' },
    stats: { hp: 200, speed: 2, courage: 90 },
    behavior: { archetype: 'guard', targets: ['pier'], active: ['00:00', '23:59'] },
    weakness: ['原初之灯'],
    lore: '暗月界的守门人。百年前，一位少女带走了暗月界的「原初之灯」，从此那边的天空一年比一年暗。',
  },
});

export const STORY_ITEMS = () => ({
  county_record: { name: '县志残页', emoji: '📜', desc: '泛黄的县志残页，画着湖心的门和一圈灯' },
  moonstone: { name: '月石', emoji: '🌙', desc: '影灵留下的微微发光的小石头' },
});

export const STORY_STRUCTURES = () => ({
  lamp_wheel: { name: '灯轮', emoji: '🎡', tags: ['light'], ttl: 240, light: { r: 150, color: '255,215,130' } },
});

// ---------- 剧情弧模板：《镜湖裂隙》----------
// 时间用 {d: 相对开弧日的天数, at: 'HH:MM'}；d=3 恰好落在萤火节（第 4 天）。
// 每个节拍的 do 是一组剧情动作（见 story/beats.js）。scene 的 fallback 在没有 LLM 时使用。
const RIFT_PORTAL = { x: 54, y: 38, spawn: { x: 51, y: 37 } };

export const RIFT_ARC = () => ({
  id: 'rift', title: '镜湖裂隙', emoji: '🌀',
  summary: '镜湖底下的「门」再次打开：暗月界的影灵涌入小镇，一位百年前的少女跌出裂隙。小镇要在封印、共存与智取之间做出选择。',
  start: { at: '21:00' },
  phases: [
    {
      id: 'omen', name: '伏笔', until: { d: 3, at: '20:30' },
      beats: [
        { id: 'ripple', when: { d: 0, at: '21:30' }, do: [
          { kind: 'portal', stage: 'crack', ...RIFT_PORTAL },
          { kind: 'omen', who: ['wang', 'chen'], text: '深夜的镜湖泛起一圈圈紫色的涟漪，像有什么在湖底呼吸', at: 'pier', vfx: 'ripple', color: '#9b6bff' },
          { kind: 'spawnCreatures', type: 'shade_wisp', count: 1, goal: 'farm' },
          { kind: 'thread', id: 'treasure', status: 'advanced', note: '小乐拍到了湖面的紫光' },
        ] },
        { id: 'rumor', when: { d: 1, at: '07:30' }, do: [
          { kind: 'spreadNews', text: '听说昨晚镜湖冒紫光，陈家的西瓜被啃了几个，地上还有发光的小脚印', about: 'rift', claim: '镜湖里有奇怪的东西', confidence: 0.5, at: 'all' },
          { kind: 'belief', who: ['zhou'], about: 'rift', claim: '八成是小乐为了拍视频搞的恶作剧', confidence: 0.8 },
          { kind: 'belief', who: ['sun'], about: 'rift', claim: '湖底的那扇门，又要开了', confidence: 0.9 },
        ] },
        { id: 'record', when: { d: 2, at: '10:00' }, do: [
          { kind: 'giveItem', who: 'su', item: 'county_record' },
          { kind: 'omen', who: ['su'], text: '在图书馆旧书堆里翻到一页县志残页，上面画着湖心的门和一圈灯' },
          { kind: 'thread', id: 'legend', status: 'advanced', note: '苏墨找到了县志残页' },
        ] },
        { id: 'tale', when: { d: 2, at: '16:00' }, do: [
          { kind: 'scene', location: 'park', participants: ['sun', 'su', 'wang'], title: '公园里的老故事',
            purpose: '孙婆婆终于讲出镜湖传说的后半段：百年前的少女放灯，其实是为了封住湖底的「门」，而她带走了门那边的一盏灯',
            fallback: [
              ['sun', '你们俩坐下，婆婆今天把后半段讲给你们听。'],
              ['su', '县志残页上画的那一圈灯……就是您说的那个？'],
              ['sun', '百年前那个姑娘放灯，不是为了等恋人，是为了把湖底的门关上。'],
              ['wang', '门？！婆婆您是说，湖底真的有东西？'],
              ['sun', '她还从门那边带回了一盏灯。那边的人，一直在找它。'],
            ] },
        ] },
        { id: 'tale_after', when: { d: 2, at: '17:30' }, do: [
          { kind: 'thread', id: 'legend', status: 'resolved', note: '孙婆婆讲出了传说的后半段' },
          { kind: 'canon', text: '镜湖传说的后半段：百年前的少女放灯是为了封住湖底通往暗月界的门，她还带走了那边的「原初之灯」。', tags: ['镜湖', '传说'] },
          { kind: 'belief', who: ['su', 'wang'], about: 'rift', claim: '湖底有一扇通往别处的门', confidence: 0.8 },
        ] },
        { id: 'dim', when: { d: 2, at: '21:00' }, do: [
          { kind: 'spawnCreatures', type: 'shade_wisp', count: 2, goal: 'square' },
          { kind: 'omen', who: ['lin'], text: '打烊时，咖啡馆门口的灯被什么东西「呼」地吹灭了' },
        ] },
      ],
    },
    {
      id: 'breach', name: '爆发', until: { d: 4, at: '07:00' },
      beats: [
        { id: 'open', when: { enter: true }, do: [
          { kind: 'portal', stage: 'open' },
          { kind: 'weather', id: 'fog' },
          { kind: 'spreadNews', text: '湖心裂开了一道紫色的口子，影子一样的小东西从里面涌了出来！', about: 'rift', claim: '裂隙是真的，影灵进镇了', confidence: 0.95, at: 'all' },
          { kind: 'effect', who: 'all', effects: [{ op: 'stat', stat: 'courage', add: -10, target: 'self' }] },
          { kind: 'spawnCreatures', type: 'shade_wisp', count: 5 },
          { kind: 'spawnCreatures', type: 'shade_hound', count: 1 },
          { kind: 'traveller', id: 'aying', at: 'pier' },
        ] },
        { id: 'letter', when: { d: 3, at: '22:00' }, do: [
          { kind: 'omen', who: ['he'], text: '那个从裂隙里跌出来的姑娘手里攥着的信笺，和匿名信是同一种字迹' },
          { kind: 'thread', id: 'letter', status: 'advanced', note: '匿名信的字迹与阿萤的信笺相同' },
        ] },
      ],
    },
    {
      id: 'struggle', name: '发展', until: { d: 6, at: '19:30' },
      beats: [
        { id: 'council', when: { d: 4, at: '09:00' }, do: [
          { kind: 'scene', location: 'tavern', participants: ['he', 'zhao', 'zhou', 'lin', 'su', 'aying'], title: '月光酒馆紧急议事会',
            purpose: '商量怎么应对影灵、谁负责什么：铁柱做灯、苏墨和阿萤研究古法灯阵、周医生照看受惊的人、晓雨把咖啡馆变成避难所',
            fallback: [
              ['he', '人都到齐了。昨晚的事大家都看见了，得拿个主意。'],
              ['zhao', '它们怕光！包在我身上，我今天就扎一批萤火灯出来。'],
              ['aying', '家母说过，古法的灯阵能挡住门那边的东西……我只记得一半。'],
              ['su', '县志残页上画着灯阵，我和阿萤去图书馆把它拼出来。'],
              ['zhou', '受了惊吓的都到诊所来，别硬撑。'],
              ['lin', '咖啡馆晚上不关门，谁害怕就过来坐。'],
            ],
            assignments: [
              { who: 'zhao', time: '13:00', duration: 120, location: 'workshop', activity: '赶制萤火灯', emoji: '🔨', act: { type: 'use', ability: 'craft_lantern' } },
              { who: 'su', time: '10:00', duration: 150, location: 'library', activity: '和阿萤研究古法灯阵', emoji: '📜', act: { type: 'research', topic: '古法灯阵与萤火结界' } },
              { who: 'aying', time: '10:00', duration: 150, location: 'library', activity: '帮苏墨回忆灯阵', emoji: '🏮' },
              { who: 'lin', time: '19:00', duration: 180, location: 'cafe', activity: '守着咖啡馆当避难所', emoji: '☕' },
            ] },
          { kind: 'thread', id: 'concert', status: 'advanced', note: '音乐会改成了守夜灯会的计划' },
        ] },
        { id: 'wave1', when: { d: 4, at: '20:00' }, do: [
          { kind: 'spawnCreatures', type: 'shade_wisp', count: 3, goal: 'farm' },
          { kind: 'spawnCreatures', type: 'shade_hound', count: 1 },
        ] },
        { id: 'wheel', when: { d: 5, at: '10:00' }, do: [
          { kind: 'structure', type: 'lamp_wheel', at: 'farm' },
          { kind: 'omen', who: ['chen', 'zhao'], text: '铁柱和大山一起，把旧水车改成了挂满萤火灯的「灯轮」，转起来整片瓜田都亮了' },
          { kind: 'thread', id: 'waterwheel', status: 'resolved', note: '水车修好了，还变成了灯轮' },
          { kind: 'canon', text: '陈家农场的旧水车被改装成了「灯轮」。', tags: ['农场', '灯轮'] },
        ] },
        { id: 'little_shade', when: { d: 5, at: '15:00' }, do: [
          { kind: 'omen', who: ['lin'], text: '在咖啡馆后门收留了一只受伤的小影灵。它缩在灯下发抖——它怕的不是人，是黑暗' },
          { kind: 'spreadNews', text: '晓雨说，影灵怕的是黑暗：它们那边的天空正在熄灭', about: 'shades', claim: '影灵并不想伤害人，它们在逃离黑暗', confidence: 0.7, at: 'cafe' },
          { kind: 'flag', name: 'shades_understood', value: true },
        ] },
        { id: 'truth', when: { d: 5, at: '18:00' }, do: [
          { kind: 'scene', location: 'tavern', participants: ['he', 'aying'], title: '匿名信的来历',
            purpose: '何月拿出匿名信和阿萤对质：信是阿萤跌入裂隙前写下的，本该寄给百年前的恋人，却漂到了十年前何月下船的码头',
            fallback: [
              ['he', '这封信，是你写的吧？'],
              ['aying', '……是。我写给他的，约他萤火节那晚在码头见。'],
              ['he', '十年前我在码头下船，它就夹在我的行李里。'],
              ['aying', '原来它比我先到了这里。'],
            ] },
        ] },
        { id: 'truth_after', when: { d: 5, at: '19:30' }, do: [
          { kind: 'thread', id: 'letter', status: 'resolved', note: '匿名信是阿萤写给百年前恋人的' },
        ] },
      ],
    },
    {
      id: 'climax', name: '高潮', until: null,
      beats: [
        { id: 'warden', when: { enter: true }, do: [
          { kind: 'portal', stage: 'wide' },
          { kind: 'weather', id: 'bloodmoon' },
          { kind: 'traveller', id: 'moon_warden', at: 'pier' },
          { kind: 'spreadNews', text: '暗月守门人现身湖心，要小镇交出百年前被带走的「原初之灯」', about: 'warden', claim: '守门人要回原初之灯', confidence: 0.95, at: 'all' },
          { kind: 'scene', location: 'pier', participants: ['moon_warden', 'sun', 'he', 'zhao', 'aying', 'lin'], title: '湖边的谈判',
            purpose: '与暗月守门人谈判。三条路：封印裂隙（阿萤带着灯回到过去）、交还灯火与暗月界共存、或者用铁柱的热气球载着灯阵重新点亮暗月（智取，有风险）',
            fallback: [
              ['moon_warden', '百年了。把原初之灯还来，否则这扇门永不关闭。'],
              ['sun', '当年那孩子带走灯，是怕门那边的东西伤人。可你们……也只是怕黑吧。'],
              ['aying', '灯在我这儿。我可以带着它回去，把门关上。'],
              ['he', '或者把灯还给他们，两边都点着灯，门开着又何妨？'],
              ['zhao', '我还有个法子——热气球载着灯阵飞上去，把他们的月亮重新点亮！'],
              ['lin', '不管选哪条，我们都一起。'],
            ],
            choices: ['seal', 'coexist', 'outwit'],
            // 没有 LLM 时各角色的立场
            fallbackChoice: { sun: 'seal', aying: 'seal', he: 'coexist', lin: 'coexist', moon_warden: 'coexist', zhao: 'outwit' } },
          { kind: 'vote', question: '小镇该怎么回应暗月守门人？', minutes: 90, options: [
            { id: 'seal', label: '🔒 封印裂隙', desc: '阿萤带着原初之灯回到百年前，把门永远关上' },
            { id: 'coexist', label: '🌗 交还灯火，两界共存', desc: '把灯还给暗月界，裂隙成为往来的渡口' },
            { id: 'outwit', label: '🎈 热气球智取', desc: '铁柱的热气球载着灯阵升空，重新点亮暗月（可能失败）' },
          ] },
        ] },
      ],
    },
    { id: 'aftermath', name: '余波', until: { d: 7, at: '12:00' }, beats: [] },
  ],
  endings: {
    seal: { title: '门扉合拢', do: [
      { kind: 'omen', who: ['aying'], text: '我提着原初之灯走进裂隙。回头时，小镇的灯火一盏一盏亮着' },
      { kind: 'portal', stage: 'sealed' },
      { kind: 'dismissCreatures' },
      { kind: 'depart', id: 'aying' }, { kind: 'depart', id: 'moon_warden' },
      { kind: 'canon', text: '阿萤带着原初之灯回到了百年前，镜湖的门在灯光中合拢。镇上多了一个伤感而美丽的传说。', tags: ['镜湖', '阿萤'] },
      { kind: 'spreadNews', text: '阿萤走了，裂隙合上了。湖面上只剩一盏慢慢漂远的灯', about: 'rift', claim: '裂隙已经封印', confidence: 0.95, at: 'all' },
    ] },
    coexist: { title: '双月当空', do: [
      { kind: 'portal', stage: 'stable', name: '月之渡口' },
      { kind: 'dismissCreatures', keep: { type: 'shade_wisp', name: '小影', near: 'cafe' } },
      { kind: 'depart', id: 'moon_warden' },
      { kind: 'calendar', id: 'double_moon', name: '双月节', emoji: '🌗', inDays: 7, from: '19:00', location: 'pier', hint: '两个世界的人会在月之渡口一起放灯' },
      { kind: 'canon', text: '小镇把原初之灯还给了暗月界。镜湖的裂隙成了「月之渡口」，每年双月节，两个世界的人一起放灯。', tags: ['镜湖', '双月节'] },
      { kind: 'spreadNews', text: '灯还回去了，暗月界的天空亮了。守门人说，以后门就开着，像个渡口', about: 'rift', claim: '裂隙成了两个世界之间的渡口', confidence: 0.95, at: 'all' },
    ] },
    outwit: { title: '热气球点亮暗月', check: { base: 0.35 }, do: [
      { kind: 'omen', who: ['zhao'], text: '热气球载着一整圈灯阵升上了血月，暗月一点一点亮了起来' },
      { kind: 'portal', stage: 'sealed' },
      { kind: 'dismissCreatures' },
      { kind: 'depart', id: 'moon_warden' },
      { kind: 'thread', id: 'balloon', status: 'resolved', note: '热气球终于飞上了天' },
      { kind: 'canon', text: '赵铁柱的热气球载着灯阵升空，重新点亮了暗月。守门人带着影灵回家了，阿萤决定留在小镇。', tags: ['热气球', '暗月'] },
      { kind: 'spreadNews', text: '铁柱的热气球飞上天了！暗月亮了，影灵们都回家了', about: 'rift', claim: '暗月被重新点亮了', confidence: 0.95, at: 'all' },
    ], fail: 'seal', failText: '一阵湖风把热气球吹偏了，灯阵落进了湖里……最后，还是阿萤提着原初之灯走进了裂隙。' },
  },
  // 所有结局共同的收尾
  finale: [
    { kind: 'growth', who: 'zhao', change: '在危机里戒了酒' },
    { kind: 'growth', who: 'su', change: '终于写完了小说的结局' },
    { kind: 'thread', id: 'confession', status: 'advanced', note: '苏墨把小说的结局念给了晓雨听' },
    { kind: 'newspaper' },
  ],
  // 剧情里登场的角色（开弧时以 addPersona 写入世界规格）
  cast: {
    aying: {
      id: 'aying', name: '阿萤', age: 17, role: '从百年前来的少女', kind: 'traveller', home: 'tavern', work: 'pier',
      persona: '倔强、礼貌、说话带着旧式腔调，对新事物既害怕又好奇。一百年前在镜湖边放灯时跌进了裂隙。',
      goal: '弄清自己为什么来到百年后；想找到她当年在码头等的人，也想回到自己的年代。',
      look: { skin: '#f5d6c0', hair: '#1b1b22', hairStyle: 'braid', shirt: '#6f8fb5', pants: '#2f3b55', acc: ['hairpin', 'qipao'] },
      relations: {}, memories: ['我在镜湖边放灯，湖心忽然裂开一道紫光……再睁眼，镇上的一切都变了样。', '我怀里还揣着那封没寄出去的信，和一盏旧灯。'],
      traveller: { origin: '1926 年的云溪镇', knowledgeGap: ['手机', '咖啡', '短视频', '热气球', '电灯'] },
      start: { abilities: ['firefly_ward'], inventory: { lantern: 1 } },
    },
    moon_warden: {
      id: 'moon_warden', name: '暗月守门人', age: 300, role: '暗月界的守门人', kind: 'creature', creature: 'moon_warden', home: 'pier', work: 'pier',
      persona: '庄重、寡言、说话像古老的钟声。并不憎恨人类，只是为暗月界的黑暗而焦急。',
      goal: '要回百年前被带走的「原初之灯」，让暗月界重新亮起来。',
      idle: '静静地立在湖边，望着血月',
      look: { bodyPlan: 'warden', body: '#1d1838', glow: '#b9a8ff', eyes: '#f3f0ff', skin: '#1d1838', hair: '#1d1838', shirt: '#1d1838', pants: '#1d1838', hairStyle: 'buzz', acc: [] },
      relations: {}, memories: ['百年前，一个人类少女带走了原初之灯。从那以后，暗月一年比一年暗。'],
      start: { abilities: [], inventory: {} },
    },
  },
});
