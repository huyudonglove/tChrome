# Skill 能力

本目录维护可复用的操作方法。

- `index.json`：登记可用技能目录名（数组）。
- `<name>/SKILL.md`：技能正文。
- `loader.ts`：清单校验、目录列举、按 id 读取；`skillGuide` 供 System `<systemSkill>`，`loadedSkillText` 供 User `<skill>`。

常驻工具 `skill.list` / `skill.load` 管理会话内加载；`ledger.loadedSkillIds` 持久化。System `<systemSkill>` 始终有技能导航；正文只出现在已加载的 `<skill>`。系统级技能说明写在 `<systemSkill>`，不经 User 动态加载。

新增技能：建 `service/skills/<id>/SKILL.md`，需要出现在 skill.list 时加入 `index.json`。修改后运行 `bun run scripts/sync-context-examples.ts` 与 `bun run check`。