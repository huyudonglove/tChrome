# 上下文模块

本模块保留 system / user 分层。目录文件只决定加载顺序；能力导航由模块元数据生成，system 规则来自模块正文，user 工作材料由 runtime 注入。

| 入口 | 职责 |
|---|---|
| [system-slots.md](system-slots.md) | 仅编号文件名，例如 `1. identity`；对应 system/ 中的文件 |
| [user-slots.md](user-slots.md) | 仅编号文件名；对应 user/ 中的文件 |
| [system/](system/) | identity、environment、execution、toolProtocol、boundaries、output、baseTools 七个规则模块 |
| [user/](user/) | 保留十四个 tag，描述各栏用途并提供数据占位符 |
| [modules.ts](modules.ts) | 校验顺序与模块格式，读取 tag、能力、详细描述和内容，生成两份导航 |
| [window.ts](window.ts) | 拼装 system / user，并注入当轮数据、技能正文与工具说明 |

system 模块文件使用以下结构：

```text
#identity
能力：【说明本模块解决什么问题】
详细描述：
具体规则或材料正文。
```

user 模块在详细描述后增加内容段：

```text
#userInput
能力：【当前请求，任务入口】
详细描述：
说明这一栏的含义和使用边界，加载后进入 system 的 User 清单。

内容：
{{data}}
```

[user/skill.md](user/skill.md) 只维护用途、边界说明和 `{{data}}` 占位符：说明进入 system，runtime 提供的技能正文随 #skill 进入 user。system 模块文件格式保持不变，渲染时正文与能力合并到同一清单项。

目录中的名字是不含 .md 的文件名，不携带能力描述。编号从 1 连续递增，必须与目录文件一一对应。模块 tag、能力和正文只在模块文件维护，避免能力描述重复维护。

加载结果包含 systemOrder / userOrder，以及保存模块元数据与正文的 systemSlots / userSlots。systemInventory 和 userInventory 从顺序和能力元数据生成。最终 system 先输出 `# System 栏目清单`，每项 tag --能力之后直接跟该模块的详细正文，baseTools 注入常驻工具说明；再输出 `# User 栏目清单`，每项 tag --能力之后直接跟详细描述。system 正文已经合并在对应清单项内，不再额外拼接一份；user 仅保留 tag 与内容段。

execution 专注任务推进；toolProtocol 负责调用、返回和错误处理协议；boundaries 负责授权、来源与证据边界。具体技能由独立的 [service/skills/](../skills/) 能力目录维护：[index.json](../skills/index.json) 只声明成员和加载顺序，[web-observation/SKILL.md](../skills/web-observation/SKILL.md) 保存网页观察与操作方法。runtime 每轮调用一次 `loadSkills(root)`，按清单顺序读取各 `<name>/SKILL.md` 并拼接，再通过 `userText` 的 `skillText` 参数注入 #skill。context 只负责渲染，不能读取 skills 目录；ContextModules 不保存技能正文。

工具 schema 和说明仍由 [服务工具定义](../tools/definitions/) 提供，常驻说明进入 #baseTools，动态说明进入 #tools。memory.write 提供 conversationMemory 与 projectMemory 两个记忆参数，以及完整替换本会话工作汇总的 contextSummary 参数。

修改后运行 `bun run scripts/sync-context-examples.ts`，同步阶段示例中的导航、正文与 7/14 栏目数组。脚本只刷新真正的 schema，保留实际 tool_calls 的参数数据；再次运行结果应相同。然后运行 `bun run check`。

历史类数据（用户输入、目标历史、两层记忆、工具记录、观察摘要）按旧到新排列，新增记录追加末尾；最近窗口从尾部选取后仍保持原顺序。contextSummary 中历史事实和已完成进展数组遵守同样约定，由模型在提交整个汇总时维护；runtime 不对任意汇总数组猜测排序。待办和工具队列按执行顺序，选项与排名保留其业务含义。

记忆的文件读写、分层加载和窗口投影由 `service/memory/` 提供。Runtime 读取记忆并生成两层文本后传给 context；context 不读取记忆文件、不选择条数、不生成摘要，只将文本注入对应栏目。
