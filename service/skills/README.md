# Skill 能力

本目录维护可复用的操作方法，与 context 和 tools 同属 service 能力层。

- `index.json`：启用的 Skill 目录名及顺序，不重复正文。空数组表示不注入 Skill。
- `<name>/SKILL.md`：该 Skill 的方法、经验和注意事项；相关参考资料也可放在同一目录，当前加载器只读取 SKILL.md。
- `loader.ts`：校验目录清单并按顺序读取正文，原样拼接，不解析能力语义。

Runtime 在每轮开始时读取一次 Skill 内容，本轮多次模型请求使用同一份。Context 不读取此目录，只将 runtime 提供的文本注入 `<skill>`。`context/user/skill.md` 保留模块用途说明和 `{{data}}` 占位，不维护具体方法。

新增 Skill：创建独立目录及 SKILL.md，在 index.json 中加入目录名。当前启用项全部注入，不做自动筛选或按需工具加载。修改后运行示例同步脚本和相关验证。
