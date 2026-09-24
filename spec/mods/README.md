# Mod：把 AI 创造的内容分享给别的小镇

Mod 是一组「内容类」世界操作（WorldOp），例如 AI 设计的新建筑、节日、天气、物品、构筑物、能力、世界法则和设定。一个小镇里长出来的东西，可以打包成 Mod，让别的小镇从第一天起就拥有。

## 导出

```bash
mise run export-mod -- --id my-mod --name 我的小镇 --desc "说明"
# 只导出经建设提案落地的内容（不含剧情弧写下的设定）
mise run export-mod -- --id my-mod --proposals-only
```

参数：`--data`（存档目录，默认 `data`）、`--out`（输出目录，默认 `spec/mods`）。

## 加载

```bash
MODS=lakeside-story-corner,my-mod mise run start
```

加载顺序：默认世界规格 → Mod（按 `MODS` 的顺序）→ 本小镇存档里的操作历史。

- Mod 的内容不会写进本小镇的操作历史，去掉 `MODS` 就恢复原样（已经基于 Mod 内容发生的事，例如在 Mod 建筑里的约定，会被当作无效地点忽略）。
- 只接受内容类操作：`addBuilding`、`addCalendarEvent`、`addWeather`、`addItem`、`addStructure`、`addAbility`、`addRule`、`addCanon`。角色、参数、分级这类状态类操作会被过滤掉。
- 每个操作都经过与运行时相同的校验；和已有内容冲突（例如 id 重复、建筑位置被占）的操作会被跳过，并在启动日志里说明原因。
- Mod 文件名必须是 `<id>.json`，id 只能包含小写字母、数字和短横线。

## 自带的 Mod

| Mod | 内容 |
| --- | --- |
| `lakeside-story-corner` | 真实模型实测中，林晓雨在聊天里想到的点子，经世界架构师设计、考据官审查后落地：码头边的「湖畔故事角」和「湖边老故事会」。 |
