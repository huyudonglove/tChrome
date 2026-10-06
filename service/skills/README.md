# Skill 能力

本目录维护可复用的操作方法。

- `index.json`：技能分组注册表。`residentSkillIds` 为常驻技能，正文每轮装配进 System `<systemSkill>`；`dynamicSkillIds` 为动态技能，经 skill_list / skill_load 使用。
- `<name>/SKILL.md`：技能正文。
- `loader.ts`：清单校验、分组读取；`skillGuide` 供 System `<systemSkill>`（常驻正文 + 动态清单，动态清单最多列前 `gates.skillCatalogLimit` 条、其余附一条提示），`skillCatalogPage` 供 `skill_list` 分页全量取回，`loadedSkillText` 供 User `<skill>`（仅动态已加载正文）。

常驻技能与 baseTools 同理，System 一直携带完整正文，不需 skill_load。动态技能由常驻工具 `skill_list` / `skill_load` 管理，`ledger.loadedSkillIds` 持久化；正文只出现在 User `<skill>`。

技能正文围绕当前任务组织：说明适用场景、具体缺口对应的工具、何时信息足够可以执行，以及怎样用实际反馈验证和修正。阅读与排查不作为固定前置清单；已确认事实按 workspace 规则复用。代码修改通过差异、类型检查、测试或运行结果验证，页面操作通过相关状态、响应或截图验证。授权规则引用 System 对应模块，记录提醒引用动态 runtimeNotices，不在技能内新增门禁。

新增技能：建 `service/skills/<id>/SKILL.md`，文件最外层写一行 `SUMMARY:` 摘要（在标题之前，缺省回退标题），并按装配方式登记进 `index.json` 的 `residentSkillIds` 或 `dynamicSkillIds`：

```text
SUMMARY: 网页观察与操作：按区域缩小到控件、交互验收与截图证据。
# Web observation
正文…
```

修改后运行 `bun run check`。
