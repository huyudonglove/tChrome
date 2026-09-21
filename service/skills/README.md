# Skill 能力

本目录维护可复用的操作方法。

- `index.json`：技能分组注册表。`residentSkillIds` 为常驻技能，正文每轮装配进 System `<systemSkill>`；`dynamicSkillIds` 为动态技能，经 skill.list / skill.load 使用。
- `<name>/SKILL.md`：技能正文。
- `loader.ts`：清单校验、分组读取；`skillGuide` 供 System `<systemSkill>`（常驻正文 + 动态清单），`loadedSkillText` 供 User `<skill>`（仅动态已加载正文）。

常驻技能与 baseTools 同理，System 一直携带完整正文，不需 skill.load。动态技能由常驻工具 `skill.list` / `skill.load` 管理，`ledger.loadedSkillIds` 持久化；正文只出现在 User `<skill>`。

新增技能：建 `service/skills/<id>/SKILL.md`，文件最外层写标签块（在标题之前），并按装配方式登记进 `index.json` 的 `residentSkillIds` 或 `dynamicSkillIds`：

```text
TAGS:
- 浏览器
- 截图
# Web observation
正文…
```

修改后运行 `bun run scripts/sync-context-examples.ts` 与 `bun run check`。
