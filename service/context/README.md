# 上下文模块

本模块保留 system / user 分层。目录文件只决定加载顺序；能力导航由模块元数据生成，system 规则来自模块正文，user 工作材料由 runtime 注入。

| 入口 | 职责 |
|---|---|
| [overview.md](overview.md) | 整份提示词总纲，说明 System 规则与 User 材料如何支撑判断、行动和反馈；置于两份清单之前 |
| [system-slots.md](system-slots.md) | 仅编号文件名，例如 `1. identity`；对应 system/ 中的文件 |
| [user-slots.md](user-slots.md) | 仅编号文件名；对应 user/ 中的文件 |
| [system/](system/) | identity、environment、recordIdentity、execution、toolProtocol、boundaries、output、baseTools 八个规则模块 |
| [user/](user/) | 保留十五个 tag，描述各栏用途并提供数据占位符 |
| [modules.ts](modules.ts) | 校验顺序与模块格式，读取 tag、能力、详细描述和内容，生成两份导航 |
| [projections/](projections/) | 模块字段投影，保留记录身份、来源关联、操作引用与完整内容 |
| [window.ts](window.ts) | 拼装 system / user，并注入当轮数据、技能正文与能力导航 |

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

加载结果包含 systemOrder / userOrder，以及保存模块元数据与正文的 systemSlots / userSlots。systemInventory 和 userInventory 从顺序和能力元数据生成。最终 system 先输出 overview.md 总纲，然后输出 `# System 栏目清单`，每项 tag --能力之后直接跟该模块的详细正文；再输出 `# User 栏目清单`，每项 tag --能力之后直接跟详细描述。system 正文已经合并在对应清单项内，不再额外拼接一份；user 仅保留 tag 与内容段。

execution 专注任务推进；toolProtocol 负责调用、返回和错误处理协议；boundaries 负责授权、来源与证据边界。具体技能由独立的 [service/skills/](../skills/) 能力目录维护：[index.json](../skills/index.json) 只声明成员和加载顺序，[web-observation/SKILL.md](../skills/web-observation/SKILL.md) 保存网页观察与操作方法。runtime 每轮调用一次 `loadSkills(root)`，按清单顺序读取各 `<name>/SKILL.md` 并拼接，再通过 `userText` 的 `skillText` 参数注入 #skill。context 只负责渲染，不能读取 skills 目录；ContextModules 不保存技能正文。

工具 schema 和说明仍由 [服务工具定义](../tools/definitions/) 提供，System #baseTools 展示常驻能力导航，User #tools 展示本轮已加载的动态能力导航；每项由工具名和 function.description 首句生成，完整调用说明与参数 schema 通过 tools[] 发送。memory.write 提供 conversationMemory 与 projectMemory 两个记忆参数。目标、草稿与事实决定分别由 goal、notes 和 conversationMemory 承担，历史压缩摘要统一使用 conversationHistorySummary 插槽。

修改后运行 `bun run scripts/sync-context-examples.ts`，同步阶段示例中的导航、正文与栏目数组。脚本只刷新真正的 schema，保留实际 tool_calls 的参数数据；再次运行结果应相同。按改动范围执行相关检查。

`currentQuery` 保存最近一次查询，缺省 `null`；`queryHistory` 保存此前查询，缺省 `[]`。下一次查询完成（包括失败）或新 Turn 开始时，上一份查询进入历史并保留发起轮次；取消不替换当前查询。原文仅放在查询插槽，toolIO 记录条件、状态和引用。当前查询计入总窗口但不参与压缩；历史查询按发起 Turn 归档，结论合入 result。

历史类数据（用户输入、目标历史、两层记忆、工具记录、轮次摘要、查询历史）按旧到新排列，新增记录追加末尾；最近窗口从尾部选取后仍保持原顺序。待办和工具队列按执行顺序，选项与排名保留其业务含义。

记忆读写和分层加载由 service/memory 提供。Runtime 按归档覆盖关系过滤可见原文，再按模块投影记录对象传给 context；不按条数或字符数静默裁剪；发送预算不足时将模块完整正文写入文件，并显式展示文件引用。模块投影保留具体记录身份与来源关联，各模块说明解释其 ID 含义，ID 格式与范围由 identity/catalog.json 维护，System #recordIdentity 从该清单生成类型、示例、范围表，并说明原样引用、各类型在所属范围独立递增、允许空号及不跨类型或范围比较编号的规则：

| 模块 | 记录字段 |
|---|---|
| userInput / userInputHistory | id、turnId、userInput |
| goal / goalHistory | id、turnId、sourceCallId、goal |
| currentPage / pageObservedHistory | 观察的 id、turnId、callId，以及 tab、url、title、description；初始标签快照可无观察 ID |
| conversationMemory / projectMemory | memoryId、turnId、sourceCallId、text；长期记忆有来源会话时保留 sourceConversationId |
| toolIO | callId、turnId、可选 batchId、name、arguments 和解析后的 return |
| conversationHistorySummary | sumId、turnId、tag、userRequest、actions、result |
| currentQuery / queryHistory | queryId、发起查询的 turnId、sumId、module、intent、status、records；records 直接保留原模块记录和身份字段，不包装 id/content |

currentPage 展示最新观察，pageObservedHistory 排除同 id 的观察。toolIO 中与已展示观察完全相同的 description 替换为 pageObservationId 引用，保留其他返回字段；本地原文保持完整。过程展示仅取 arguments.reason，最终 text/question 来自相应收口工具参数，不使用 content 回退。

页面控件引用及工具参数中的业务 ID 继续保留；它们与观察 ID、调用 ID 各自承担不同的定位职责。notes 使用 key 标识条目，工具定义使用工具名，无需新增通用记录 ID。

总纲中的 `{{currentDate}}` 由 runtime 在每次模型请求组装前按 `America/Los_Angeles` 计算，格式为 YYYY-MM-DD，自动处理夏令时。示例使用固定日期 2026-09-06，以保持可重复生成。

每次发送主模型前，Runtime 检测 System + User 文本长度；达到 200,000 字符才触发压缩。按 turnId 汇集当轮输入、目标变化、工具调用与完整返回、页面观察、会话记忆写入、查询历史和最终输出，保留最近 3 个已结束轮次及当前轮次。较早轮次可批量提交，但每轮分别生成 tag、userRequest、actions、result，追加到 conversationHistorySummary。若归档较早轮次后仍达到阈值，再归档当前轮次较早的执行片段，保留最近 2 个完整工具批次。当前输入、目标、当前页面、notes、长期记忆和 currentQuery 不参与历史压缩，正文或文件引用保持可见；currentQuery 计入总窗口但不参与压缩，queryHistory 作为取证参考，结论合入 result。摘要保持每轮独立。

主模型发送前另设 System + User 合计 250000 字符硬内联上限。先执行上述 200000 字符门槛的压缩检查，再检查内联预算；压缩后仍超过 250000 时，优先将 notes 正文完整写入 `TCHROME_DATA/context-files/`，以文件引用替换内联正文，直到满足发送预算。notes 外置后仍超限时，再外置其他大块内容。数组模块也允许将大记录单独替换为文件引用，保留后续较小记录内联，便于模型看到分页读取结果。JSON 数据模块或数组记录的引用为 `{contextFile:{path,chars,format}}`，其中 path 为绝对路径、chars 为原文字符数、format 为 `json` 或 `text`；skill 仍为字符串，以文本说明文件路径。System #baseTools、User #tools 和编号规则保持内联。文件替换仅影响本次请求的展示，不删除历史记录，也不改变记忆和 notes 的存储内容。引用契约见 [data-schema.json](data-schema.json)。模型可通过 `catalog.add` 加载 `local.fs_read`，使用 `offset` / `limit` 按字节分段读取所需原文，后续页使用返回的 `nextOffset`，避免一次回读全文再次撑大上下文。若固定规则与文件引用本身仍无法装入，返回 `context_limit`。

常驻 `context.query(sumId, module, intent, cursor?)` 从指定摘要的来源中查询一个模块。模块为 userInput、goalChanges、toolIO、pageObservations、memoryWrites、output、queryHistory 或 summaries。Runtime 装配候选原文，查询 Agent 通过 submitMatches 返回命中的 turnIds，Runtime 校验后将对应记录放入 currentQuery；工具返回只含状态和引用。每次 records 的紧凑 JSON 最多 2000 字符；超出返回 partial 与 nextCursor，可带原查询参数和 cursor 继续读取，无需再次调用查询 Agent。超大单条保留身份字段及 fragment:{offset,totalChars,text}，text 是原记录 JSON 的连续片段，不是摘要。查询不会刷新页面。

模型输出校验成功、完整来源与摘要落盘后，才原子更新目录索引和覆盖关系。失败或取消不提交该批次覆盖，原文继续可用；此前成功提交的归档保留。索引是提交点，中断可能留下未被索引引用的文件。窗口按来源覆盖过滤历史输入、目标版本、页面观察、会话记忆写入和工具记录，本地原文不删除。

压缩和查询 Agent 分别位于 `service/agents/compression/`、`service/agents/query/`，各自管理提示词、输入组装与输出校验，共用现有 `provider.complete`。`service/context-archive/` 管理归档存储和来源关系；本目录负责主 Agent 的窗口投影与组装，不发起模型请求。

`conversationHistorySummary` 位于当前输入之后，承载逐轮或同轮执行片段摘要，投影 sumId、turnId、tag、userRequest、actions、result。历史结果只描述当时的事实，不产生新的待办。

发送前先按最近一次模型返回的工具批次选择图片附件，再进行 200K 压缩判断与 250K 文本裁剪。工具结果入库时已保存图片文件和引用；同批多个截图全部保留 callId 与图片 ID 的对应关系，旧批次只保留本地引用，不重发图片。无图片批次、无工具调用或新用户回合均不携带历史图片；原始记录和图片文件不修改。
