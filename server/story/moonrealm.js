// 暗月界的专属内容：物品、构筑物、能力、法则。
// 居民第一次走到暗月界的某个地点时，由法则把当地的能力教给他；能力只在那边的地点可用，
// 做出来的双月灯可以带回镇上，在双月节的码头放。

const MOON_PURPLE = '#b9a8ff';

export const MOON_ITEMS = () => ({
  moon_dew: { name: '月露', emoji: '💧', desc: '月光花瓣上接下的露水，喝一口清凉提神' },
  moon_lantern: { name: '双月灯', emoji: '🏮', desc: '用两块月石扎成的灯，点起来一半金一半紫' },
});

export const MOON_STRUCTURES = () => ({
  moon_float: { name: '双月灯', emoji: '🏮', tags: ['light'], ttl: 120, light: { r: 120, color: '190,170,255' } },
});

export const MOON_ABILITIES = () => [
  {
    id: 'gather_dew', name: '采月露', emoji: '🌸', target: 'self',
    desc: '用月光花的花瓣接一小瓶月露',
    aiHint: '在月光花园，想给朋友带点暗月界的礼物时',
    cost: { stamina: 5 }, cooldown: 90, requires: "self.loc == 'moon_garden'",
    effects: [
      { op: 'giveItem', item: 'moon_dew', count: 1 },
      { op: 'vfx', preset: 'sparkle', color: MOON_PURPLE, radius: 1 },
    ],
    learn: { teach: true },
  },
  {
    id: 'share_dew', name: '赠月露', emoji: '💧', target: 'agent',
    desc: '把一瓶月露递给身边的人，清凉提神',
    aiHint: '朋友累了或受了惊吓时',
    cost: { items: { moon_dew: 1 } }, cooldown: 30,
    effects: [
      { op: 'stat', stat: 'stamina', add: 15, target: 'target' },
      { op: 'condition', remove: '疲惫', target: 'target' },
      { op: 'condition', remove: '受惊', target: 'target' },
      { op: 'affinity', toward: 'self', delta: 2, target: 'target' },
      { op: 'memory', text: '{self}递给我一瓶暗月界的月露，凉丝丝的', target: 'target', importance: 4 },
      { op: 'vfx', preset: 'heal', color: MOON_PURPLE, radius: 1, target: 'target' },
    ],
    learn: { teach: true },
  },
  {
    id: 'pick_moonstone', name: '拾月石', emoji: '🌙', target: 'self',
    desc: '在崖边的月砂里捡一块发光的月石',
    aiHint: '在星坠崖，想扎双月灯却缺月石时',
    cost: { stamina: 8 }, cooldown: 120, requires: "self.loc == 'moon_lookout'",
    effects: [
      { op: 'giveItem', item: 'moonstone', count: 1 },
      { op: 'vfx', preset: 'sparkle', color: '#f5e663', radius: 1 },
    ],
    learn: { teach: true },
  },
  {
    id: 'star_wish', name: '星坠许愿', emoji: '✨', target: 'self',
    desc: '在崖边对着两个月亮许一个愿',
    aiHint: '傍晚以后在星坠崖，心里有放不下的事时',
    cost: { stamina: 5 }, cooldown: 1440, requires: "self.loc == 'moon_lookout' && hour >= 19",
    effects: [
      { op: 'stat', stat: 'courage', add: 8, target: 'self' },
      { op: 'memory', text: '我在星坠崖对着两个月亮许了一个愿', target: 'self', importance: 6 },
      { op: 'memory', text: '看见{self}在星坠崖闭着眼睛许愿', target: 'nearby', radius: 4, importance: 3 },
      { op: 'vfx', preset: 'sparkle', color: MOON_PURPLE, radius: 2 },
    ],
  },
  {
    id: 'craft_moon_lantern', name: '扎双月灯', emoji: '🔨', target: 'self',
    desc: '跟影灵学着用两块月石扎一盏双月灯',
    aiHint: '在暗月广场、有两块月石时，为双月节备灯',
    cost: { stamina: 8, items: { moonstone: 2 } }, cooldown: 60, requires: "self.loc == 'moon_plaza'",
    effects: [
      { op: 'giveItem', item: 'moon_lantern', count: 1 },
      { op: 'vfx', preset: 'burst', color: MOON_PURPLE, radius: 1 },
    ],
    learn: { teach: true },
  },
  {
    id: 'release_moon_lantern', name: '放双月灯', emoji: '🌗', target: 'area',
    desc: '把双月灯放上夜空，两个世界都看得见',
    aiHint: '双月节晚上，在码头、渡口或星坠崖',
    cost: { stamina: 5, items: { moon_lantern: 1 } }, cooldown: 60,
    requires: "(self.loc == 'pier' || self.loc == 'moon_gate' || self.loc == 'moon_lookout') && hour >= 18",
    effects: [
      { op: 'spawn', structure: 'moon_float', ttl: 120 },
      { op: 'vfx', preset: 'glow_ring', color: MOON_PURPLE, radius: 3 },
      { op: 'stat', stat: 'courage', add: 6, target: 'nearby', radius: 4, includeSelf: true },
      { op: 'memory', text: '{self}放起一盏双月灯，金色和紫色的光一起飘上了天', target: 'nearby', radius: 4, includeSelf: true, importance: 5 },
    ],
    learn: { teach: true },
  },
];

// 到了某个地点才学会当地的能力：影灵会把手艺教给第一次来的人
const learnAt = (id, name, loc, abilities, text) => ({
  id, name, when: { enter: loc },
  if: abilities.map((ab) => `!knows(e, '${ab}')`).join(' || '),
  then: [
    { op: 'memory', text, target: 'e', importance: 5 },
    ...abilities.map((ability) => ({ op: 'grantAbility', ability, target: 'e' })),
  ],
});

export const MOON_RULES = () => [
  learnAt('learn_moon_garden', '花园里的影灵', 'moon_garden', ['gather_dew', 'share_dew'], '月光花园里的影灵教我用花瓣接月露'),
  learnAt('learn_moon_lookout', '星坠崖的传说', 'moon_lookout', ['pick_moonstone', 'star_wish'], '影灵说，星坠崖的月砂里藏着月石，对着双月许的愿会被记住'),
  learnAt('learn_moon_plaza', '影灵的灯艺', 'moon_plaza', ['craft_moon_lantern', 'release_moon_lantern'], '暗月广场的影灵给我看了它们怎么用月石扎灯'),
  {
    id: 'moon_garden_calm', name: '月光花园安神', when: { every: 30 }, forEach: 'agent',
    if: "e.loc == 'moon_garden' && e.status != 'sleeping'",
    then: [{ op: 'stat', stat: 'stamina', add: 2, target: 'e' }, { op: 'stat', stat: 'courage', add: 2, target: 'e' }],
  },
  {
    id: 'moon_dark_chill', name: '暗月寒意', when: { every: 60 }, forEach: 'agent',
    if: "e.region == 'moonrealm' && e.status != 'sleeping' && (hour >= 22 || hour < 5) && !nearStructure(e, 'light', 3)",
    then: [{ op: 'stat', stat: 'courage', add: -3, target: 'e' }],
  },
];
