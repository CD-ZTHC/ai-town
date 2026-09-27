// 调度级别（多世界设计 §7.2）：调用点只声明「做什么」（label），这张表是调度策略的唯一出处。
// 调整优先级不需要改动任何调用点。
//   P0 交互：有人在等         P1 心跳：世界「活着」所必需
//   P2 叙事：可以晚一点        P3 创世：批处理            P4 进化：只用空闲容量
export const CLASSES = ['P0', 'P1', 'P2', 'P3', 'P4'];
export const CLASS_NAMES = { P0: '交互', P1: '心跳', P2: '叙事', P3: '创世', P4: '进化' };

const TABLE = {
  与旅人交谈: 'P0', 心声: 'P0', 内容审核: 'P0',
  规划一天: 'P1', 对话: 'P1', 内心独白: 'P1', 重新规划: 'P1',
  叙事导演: 'P2', 人员流动: 'P2', 多人场景: 'P2', 反思: 'P2', 写日记: 'P2', 撰写日报: 'P2', 记忆整理: 'P2', 群体心智: 'P2',
  世界架构师: 'P2', 设定考据: 'P2', 'AI 裁决官': 'P2',
  抽样审核: 'P3', 发布审核: 'P0', // 发布时 owner 在等结果
  撰写需求文档: 'P4',
};
const PREFIX = [['创世：', 'P3'], ['进化：', 'P4'], ['插件：', 'P2']];

/** label → 调度级别；未登记的 label 按叙事（P2）处理 */
export function classOf(label) {
  const l = String(label || '');
  if (Object.hasOwn(TABLE, l)) return TABLE[l];
  for (const [p, c] of PREFIX) if (l.startsWith(p)) return c;
  return 'P2';
}
