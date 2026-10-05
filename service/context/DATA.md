# User 数据清单

`data-schema.json` 汇总模型可见的 User 标签结构（与 [modules.json](modules.json) 中 `role=user` 且 `consumers∋main` 的模块一致）；修改投影时同步更新它。`../identity/catalog.json` 统一维护 ID 字段、前缀及编号范围。Schema 的 ID 定义引用由此生成的 `tchrome:identity`；使用 `data-schema.ts` 的 validateUserData 校验，不重复维护前缀正则。模块提示词解释含义，本清单约束数据结构，不注入提示词。

验证对象使用**不带尖括号**的模块名（如 `conversation`）。模型侧正文为 XML；`skill`、`conversation`、`tools` 保留文本，其余标签取 JSON 解析后的值；全部模块必须存在。它不是磁盘存储格式。

| 模块 | 数据结构 | 身份字段 |
| --- | --- | --- |
| `skill` | 字符串 | 无 |
| `projectMemory` | `[{memoryId, turnId, sourceCallId?, sourceConversationId?, text}]` | `memoryId`（`lm_`） |
| `tools` | 本轮已加载动态工具的能力导航文本 | 工具名 |
| `conversation` | 嵌套 XML 时间线正文（见下） | `<turn>` 元素的 `turnId` 属性（`tn_`） |

## conversation 嵌套结构

```xml
<conversation>
  <memory memoryId="mm_01" turnId="tn_01" sourceCallId="call_09">…</memory>
  <summary sumId="sum_01" turnId="tn_01" tag="…" level="1" turnIds="tn_01" from="call_01">…</summary>
  <task id="task_01" title="…" status="active" createdTurnId="tn_02" updatedTurnId="tn_02">
    <item id="item_01" status="done">…</item>
  </task>
  <turn turnId="tn_01" from="call_01" to="call_12">
    <userInput id="input_01" turnId="tn_01" submittedAt="…">…</userInput>
    <observation id="page_01" turnId="tn_01" callId="call_60" batchId="batch_32" tabId="101" type="code">…</observation>
    <note key="…">…</note>
    <reflection turnId="tn_01">
      <reflect id="rf_01" focus="证据">…</reflect>
    </reflection>
    <query queryId="query_01" turnId="tn_01" sumId="sum_03" module="toolIO" status="complete">…</query>
    <stopReason kind="reply">…</stopReason>
  </turn>
  <toolIO from="call_01" to="call_86" kept="10" total="86">
    <call callId="call_77" turnId="tn_02" batchId="batch_40" name="task_update" stage="complete" ok="true">…</call>
  </toolIO>
</conversation>
```

会话级（与 turn 平级）：`memory` 逐条渲染为 `<memory memoryId turnId sourceCallId?>` 元素、正文为 `text`（`mm_`）；`summary` 逐条渲染为 `<summary sumId turnId summary? level? turnIds? from?>` 元素、正文为 `userRequest` / `actions` / `result`；`task` 为 `<task id title? status createdTurnId? updatedTurnId?>` 元素，每条步骤一个 `<item id status expectedEffect? verification? blockedReason? outcome?>`、正文为步骤 `text`（当前活跃或最近完成的任务实体，跨轮唯一持久化，直到新任务顶替）。

轮次级（`<turn>` 内，有则写、无则省略）：轮次 ID 与本段工具调用 ID 范围已收为 `<turn>` 的属性（`turnId` / `from` / `to`，单次调用时 from 与 to 相同），不再是二级标签。

| 标签 | 渲染形状 | 身份字段 |
| --- | --- | --- |
| `userInput` | `<userInput id turnId>`，正文为用户原话 | `id` |
| `toolIO` | 池属性 + 每条一个 `<call callId turnId name ok?>` 元素 | conversation 底部全会话公用池：仅最近 kept 条调用保留详情（kept / from / to / total 见标签属性），更早按各轮 `<turn>` 的 from / to 用 evidence_search(callId) 取回 |
| `observation` | 每条观察一个元素，属性含 `id callId tabId? type` 等，正文为该次观察的完整返回 | `id` |
| `note` | 本轮草稿，`<note key>` + 正文；容器为无属性 `<notes>` | turnId + key |
| `reflection` | `<reflection turnId>` 下每条 `<reflect id focus?>` + 正文 | rf_ |
| `query` | 每条一个 `<query queryId turnId sumId module status sourceCallId?>` 元素 | `queryId` |
| `stopReason` | `<stopReason kind callId?>` + 正文 | — |

被压缩覆盖的 `<turn>` 整块删除，只在 `<summary>` 留摘要。任务记录 `Task` 为会话级唯一实体，items 用 `item_` 编号。查询记录为 `{queryId, turnId, sumId, module, intent, status, records, sourceCallId?, detail?}`。

工具投影的每条调用带 `args`（调用参数；大小超门禁时只留 `files` 路径，记账类指针调用不带）、`return` 为 `{stage, result}`；result 与 observations 中同一 callId 的观察对应时，只保留 `{ok, observationId}`。context_query 的 result 为 `{ok, status, sumId, module, intent, recordCount}`。归档原文使用 `{stage, totalChars, text}`，只出现在压缩/查询候选里，不进主模型窗口。finishTurn / askUser 在 toolIO 只存指针 `{output:"reply"|"ask"}`，正文在本轮 stopReason。

Schema 检查字段类型、必填项、ID 格式及已知记录结构，拒绝未声明的顶层模块。编号至少两位，前缀来自 ID 清单。Schema 不检查编号唯一性、自增状态、引用是否存在或查询是否命中；统一内联门禁由 Runtime 验证。
