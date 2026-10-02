# User 数据清单

`data-schema.json` 汇总模型可见的 User 插槽结构（与 [modules.json](modules.json) 中 `role=user` 且 `consumers∋main` 的模块一致）；修改投影时同步更新它。`../identity/catalog.json` 统一维护 ID 字段、前缀及编号范围。Schema 的 ID 定义引用由此生成的 `tchrome:identity`；使用 `data-schema.ts` 的 validateUserData 校验，不重复维护前缀正则。模块提示词解释含义，本清单约束数据结构，不注入提示词。

验证对象使用**不带尖括号**的模块名（如 `conversation`）。模型侧正文为 XML；`skill`、`conversation`、`tools` 保留文本，其余插槽取 JSON 解析后的值；全部模块必须存在。它不是磁盘存储格式。

| 模块 | 数据结构 | 身份字段 |
| --- | --- | --- |
| `skill` | 字符串 | 无 |
| `projectMemory` | `[{memoryId, turnId, sourceCallId?, sourceConversationId?, text}]` | `memoryId`（`lm_`） |
| `tools` | 本轮已加载动态工具的能力导航文本 | 工具名 |
| `conversation` | 嵌套 XML 时间线正文（见下） | 二级标签为 `tn_` turnId |

## conversation 嵌套结构

```xml
<conversation>
  <conversationMemory>…</conversationMemory>
  <conversationHistorySummary>…</conversationHistorySummary>
  <task>…</task>
  <tn_01>
    <userInput>…</userInput>
    <callRange>call_01–call_12</callRange>
    <observations>…</observations>
    <notes>…</notes>
    <reflection>…</reflection>
    <query>…</query>
    <stopReason>…</stopReason>
  </tn_01>
</conversation>
```

会话级（与 turn 平级）：`conversationMemory` 为 `[{memoryId, turnId, sourceCallId?, text}]`（`mm_`）；`conversationHistorySummary` 为 `[{sumId, turnId, tag, userRequest, actions, result}]`；`task` 为 `{id, title?, status, createdTurnId?, updatedTurnId?, items:[{id, text, status, expectedEffect?, verification?, blockedReason?, outcome?}]}`（当前活跃或最近完成的任务实体，跨轮唯一持久化，直到新任务顶替）。

轮次级（`<tn_xx>` 内，有则写、无则省略）：

| 标签 | 数据结构 | 身份字段 |
| --- | --- | --- |
| `userInput` | `{id, turnId, userInput}` | `id` |
| `callRange` | string \| null | 本段工具调用 ID 首尾（如 `call_01–call_12`；单次调用只一个 id） |
| `toolIO` | 数组 | conversation 底部全会话公用池：仅最近 10 次调用保留详情，更早按各轮 callRange 用 evidence_search(callId) 取回 |
| `observations` | `[{id, turnId, callId, batchId?, tabId, type, result}]` | `id` |
| `notes` | `{key:text}` 本轮草稿 | turnId + key |
| `reflection` | `{turnId, items:[{id,text,focus?}]}` 或 null | rf_ |
| `query` | 查询记录数组；`currentQuery:true` 标记当前查询 | `queryId` |
| `stopReason` | 轮次收口对象或 null | — |

被压缩覆盖的 `<tn_xx>` 整块删除，只在 `conversationHistorySummary` 留摘要。任务记录 `Task` 为会话级唯一实体，items 用 `item_` 编号。查询记录为 `{queryId, turnId, sumId, module, intent, status, records, sourceCallId?, detail?}`。

工具投影的 `return` 为 `{stage, result}`；result 与 observations 中同一 callId 的观察对应时，只保留 `{ok, observationId}`。context_query 的 result 为 `{ok, status, sumId, module, intent, currentQuery:true, recordCount}`。归档原文使用 `{stage, totalChars, text}`，只出现在压缩/查询候选里，不进主模型窗口。finishTurn / askUser 在 toolIO 只存指针 `{output:"reply"|"ask"}`，正文在本轮 stopReason。

Schema 检查字段类型、必填项、ID 格式及已知记录结构，拒绝未声明的顶层模块。编号至少两位，前缀来自 ID 清单。Schema 不检查编号唯一性、自增状态、引用是否存在或查询是否命中；统一内联门禁由 Runtime 验证。
