# User 数据清单

`data-schema.json` 汇总模型可见的 User 插槽结构（与 [modules.json](modules.json) 中 `role=user` 且 `consumers∋main` 的模块一致）；修改投影时同步更新它。`../identity/catalog.json` 统一维护 ID 字段、前缀及编号范围。Schema 的 ID 定义引用由此生成的 `tchrome:identity`；使用 `data-schema.ts` 的 validateUserData 校验，不重复维护前缀正则。模块提示词解释含义，本清单约束数据结构，不注入提示词。

验证对象使用**不带尖括号**的模块名（如 `toolIO`）。模型侧正文为 XML（`<toolIO>…</toolIO>`）；`skill`、`tools` 保留文本，其余插槽取 JSON 解析后的值；全部模块必须存在，空数组用 `[]`，空对象槽按下表处理。它不是完整 User XML 文本，也不是磁盘存储格式。

| 模块 | 数据结构 | 身份字段 |
| --- | --- | --- |
| `skill` | 字符串 | 无 |
| `userInput` | `{id, turnId, userInput}` | `id` |
| `conversationHistorySummary` | `[{sumId, turnId, tag, userRequest, actions, result}]` | `sumId` |
| `userInputHistory` | 用户输入记录数组 | `id` |
| `goal` | `{currentGoalId, goals}`；goals 为全部 active 目标及其父级记录 | `currentGoalId`、记录 `id` / `parentId` |
| `goalHistory` | completed / cancelled 的目标记录数组 | `id` / `parentId` |
| `openTabs` | `{ok:true, windows:[{windowId, focused, tabs:[{tabId, url, title, active}]}]}` 或 `{ok:false, error}` | 浏览器原始 windowId / tabId |
| `pageObservedHistory` | 页面观察数组（旧→新）：`id / turnId / callId / tabId / type / result` | `id` |
| `projectMemory` | `[{memoryId, turnId, sourceCallId?, sourceConversationId?, text}]` | `memoryId`（`lm_`） |
| `conversationMemory` | 同上 | `memoryId`（`mm_`） |
| `notes` | 字符串键值对象，空值为 `{}` | 键名 |
| `toolIO` | `[{callId, turnId, batchId?, name, arguments, return}]` | `callId` |
| `queryHistory` | 查询记录数组 | `queryId` |
| `currentQuery` | 查询记录或 `null` | `queryId` |
| `tools` | 本轮已加载动态工具的能力导航文本，每项为工具名和说明首句 | 工具名 |

目标记录统一为 `{id, parentId, status, turnId, sourceCallId?, goal}`。总目标 `goal_01` 的 parentId 为 null；子目标 `subgoal_01` 的 parentId 指向总目标。两类编号在会话内分别持久自增，更新保留原 ID。currentGoalId 可为 null；新会话 goal 为 `{currentGoalId:null,goals:[]}`，goalHistory 为 `[]`。磁盘以 Ledger.goals 保存全部最新记录、currentGoalId 保存选择，Turn.goalChanges 保存调用时的变更快照。

查询记录统一为 `{queryId, turnId, sumId, module, intent, status, records, sourceCallId?, detail?}`。`records` 直接保存原模块记录，不新增通用 `id`，不加 `content` 包装；身份字段沿用原记录。查询自身的 `turnId` 与结果记录的 `turnId` 分别表示发起轮次和来源轮次。`status` 为 `complete / not_found / error`。

工具投影的 `return` 为 `{stage, result}`；result 与 pageObservedHistory 中同一 callId 的观察对应时，只保留 `{ok, pageObservationId}`，完整观察结果在 `<pageObservedHistory>`。其他字段保留。查询原始工具记录时也允许 `{stage, totalChars, text}`。工具参数、解析后的结果和图片对象属于工具协议，不限制其内部业务 ID。查询原记录允许已有时间和来源字段；查询记录可包含历史查询记录、带 turnId 的最终输出，以及指定摘要的各层来源摘要。查询结果走统一 4000 内联门禁。

Schema 检查字段类型、必填项、ID 格式及已知记录结构，拒绝未声明的顶层模块和记录字段。编号至少两位，前缀来自 ID 清单。Schema 不检查编号唯一性、自增状态、引用是否存在或查询是否命中，也不实现查询链路；统一内联门禁由 Runtime 验证。
