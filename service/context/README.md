# 上下文模块

本模块保留 system / user 分层。目录文件只决定加载顺序；能力导航由模块元数据生成，system 规则来自模块正文，user 工作材料由 runtime 注入。

| 入口 | 职责 |
|---|---|
| [overview.md](overview.md) | 整份提示词总纲，说明 System 规则与 User 材料如何支撑判断、行动和反馈；置于两份清单之前 |
| [system-slots.md](system-slots.md) | 仅编号文件名，例如 `1. identity`；对应 system/ 中的文件 |
| [user-slots.md](user-slots.md) | 仅编号文件名；对应 user/ 中的文件 |
| [system/](system/) | identity、environment、execution、toolProtocol、boundaries、output、baseTools 七个规则模块 |
| [user/](user/) | 保留十六个 tag，描述各栏用途并提供数据占位符 |
| [modules.ts](modules.ts) | 校验顺序与模块格式，读取 tag、能力、详细描述和内容，生成两份导航 |
| [projections/](projections/) | 模块字段投影，隐藏归档元数据，保留操作引用与完整内容 |
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

加载结果包含 systemOrder / userOrder，以及保存模块元数据与正文的 systemSlots / userSlots。systemInventory 和 userInventory 从顺序和能力元数据生成。最终 system 先输出 overview.md 总纲，然后输出 `# System 栏目清单`，每项 tag --能力之后直接跟该模块的详细正文，baseTools 注入常驻工具说明；再输出 `# User 栏目清单`，每项 tag --能力之后直接跟详细描述。system 正文已经合并在对应清单项内，不再额外拼接一份；user 仅保留 tag 与内容段。

execution 专注任务推进；toolProtocol 负责调用、返回和错误处理协议；boundaries 负责授权、来源与证据边界。具体技能由独立的 [service/skills/](../skills/) 能力目录维护：[index.json](../skills/index.json) 只声明成员和加载顺序，[web-observation/SKILL.md](../skills/web-observation/SKILL.md) 保存网页观察与操作方法。runtime 每轮调用一次 `loadSkills(root)`，按清单顺序读取各 `<name>/SKILL.md` 并拼接，再通过 `userText` 的 `skillText` 参数注入 #skill。context 只负责渲染，不能读取 skills 目录；ContextModules 不保存技能正文。

工具 schema 和说明仍由 [服务工具定义](../tools/definitions/) 提供，常驻说明进入 #baseTools，动态说明进入 #tools。memory.write 提供 conversationMemory 与 projectMemory 两个记忆参数。目标、草稿与事实决定分别由 goal、notes 和 conversationMemory 承担，历史压缩摘要使用各模块独立的 Summary 插槽。

修改后运行 `bun run scripts/sync-context-examples.ts`，同步阶段示例中的导航、正文与 7/16 栏目数组。脚本只刷新真正的 schema，保留实际 tool_calls 的参数数据；再次运行结果应相同。然后运行 `bun run check`。

历史类数据（用户输入、目标历史、两层记忆、工具记录、分模块摘要）按旧到新排列，新增记录追加末尾；最近窗口从尾部选取后仍保持原顺序。待办和工具队列按执行顺序，选项与排名保留其业务含义。

记忆读写和分层加载由 service/memory 提供。Runtime 按归档覆盖关系过滤可见原文，再投影为完整文本数组传给 context；不按条数或字符数静默裁剪。模块投影负责字段白名单，输入和目标显示文本，历史显示文本数组，页面保留 tab/url/title/description，工具保留名称、操作参数、reason 和解析后的结果。页面控件引用继续保留。

总纲中的 `{{currentDate}}` 由 runtime 在每次模型请求组装前按 `America/Los_Angeles` 计算，格式为 YYYY-MM-DD，自动处理夏令时。示例使用固定日期 2026-09-06，以保持可重复生成。

每次发送主模型前，Runtime 检测 System + User 文本长度；达到 200,000 字符时，分别调用独立 LLM 压缩请求处理 userInputHistory、pageObservedHistory、conversationMemory 和 toolIO。前三个模块保留最近 3 条原文，toolIO 保留最近 2 个调用批次。压缩只改变窗口覆盖关系，账本和本地完整原文保持不变。各层连续摘要累计达到 20,000 字符后生成更高层摘要，旧摘要与来源关联继续保留。

常驻 `context.query(module, tag, question?)` 将主题交给查询 Agent 语义匹配本会话对应模块目录，由 runtime 校验内部 ID、沿来源关系读取原文并去重，按原顺序返回。主 Agent 无需提供记录 ID。只检索已压缩归档；支持多条或 not_found，单次原文内容上限 30,000 字符，超过时返回 partial 和遗漏数量，不截断单条原文。请缩小主题或问题后再查；单条原文本身超过上限时也会明确返回 partial。查询不会刷新页面。

每个模块在 LLM 输出校验成功、完整来源与摘要落盘后，才原子更新目录索引。失败或取消不推进该模块覆盖关系，原文继续可用；同一轮中此前成功提交的其他模块可以保留。索引是提交点，中断可能留下未被索引引用的文件。

压缩和查询 Agent 分别位于 `service/agents/compression/`、`service/agents/query/`，各自管理提示词、输入组装与输出校验，共用现有 `provider.complete`。`service/context-archive/` 管理归档存储和来源关系；本目录负责主 Agent 的窗口投影与组装，不发起模型请求。
