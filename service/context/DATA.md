# User 数据清单

`data-schema.json` 汇总模型可见的 User 标签结构（与 [modules.json](modules.json) 中 `role=user` 且 `consumers∋main` 的模块一致）；修改投影时同步更新它。`../identity/catalog.json` 统一维护 ID 字段、前缀及编号范围。Schema 的 ID 定义引用由此生成的 `tchrome:identity`；使用 `data-schema.ts` 的 validateUserData 校验，不重复维护前缀正则。模块提示词解释含义，本清单约束数据结构，不注入提示词。

验证对象使用**不带尖括号**的模块名（如 `conversation`）。模型侧正文为 XML；`skill`、`conversation`、`tools`、`runtimeNotices` 保留文本，其余标签取 JSON 解析后的值；全部模块必须存在。它不是磁盘存储格式。

| 模块 | 数据结构 | 身份字段 |
| --- | --- | --- |
| `skill` | 字符串 | 无 |
| `projectMemory` | `[{memoryId, turnId, sourceCallId?, sourceConversationId?, text}]` | `memoryId`（`lm_`） |
| `tools` | 本轮已加载动态工具的能力导航文本 | 工具名 |
| `conversation` | 嵌套 XML 时间线正文（见下） | `<turn>` 元素的 `turnId` 属性（`tn_`） |
| `runtimeNotices` | 字符串；动态提醒 XML 正文，每条为 `<notice id kind scope>`，同 kind 只保留最新一条 | `id`（`rt_`）；独立 User 模块，不进压缩 |

`runtimeProtocol` 是 System 模块，保存稳定运行规则，不属于 User 数据契约。`runtimeNotices` 仅保存当前动态提醒，与 `conversation` 平级。

## conversation 嵌套结构

```xml
<conversation>
  <ConverstionMemories memoryId="mm_01" turnId="tn_01" sourceCallId="call_09">…</ConverstionMemories>
  <summaries start="sum_01" end="sum_01">
    <summary sumId="sum_01" turnId="tn_01" summary="…" level="1" turnIds="tn_01">…</summary>
  </summaries>
  <tasks start="task_01" end="task_01">
    <task id="task_01" title="…" status="active" createdTurnId="tn_02" updatedTurnId="tn_02">
      <item id="item_01" status="done">…</item>
    </task>
  </tasks>
  <workspaces>
    <workspace kind="file" key="/repo/src/app.ts">{"operations":[{"op":"local_fs_read","result":{"ok":true},"content":"…","revision":1,"sources":[{"id":"ws01","turnId":"tn_01","callId":"call_01","boundId":"b01"}]}]}</workspace>
  </workspaces>
  <turn turnId="tn_01" start="call_01" end="call_12">
    <userInput id="input_01">{"turnId":"tn_01","userInput":"…"}</userInput>
    <observations start="page_01" end="page_01">
      <observation id="page_01" callId="call_60" type="code">{"tabId":101,"result":{}}</observation>
    </observations>
    <notes start="nt_01" end="nt_01">
      <note id="nt_01" key="draft">…</note>
    </notes>
    <reflections start="rf_01" end="rf_01">
      <reflect id="rf_01" focus="证据">…</reflect>
    </reflections>
    <queries start="query_01" end="query_01">
      <query id="query_01" sumId="sum_03" module="toolIO" status="complete">…</query>
    </queries>
    <calls start="call_01" end="call_12" kept="1" total="12">
      <call callId="call_12" name="task_update" ok="true">…</call>
    </calls>
    <stopReason kind="reply">…</stopReason>
  </turn>
</conversation>
<runtimeNotices>
  <notice id="rt_01" kind="budget" scope="turn">…</notice>
</runtimeNotices>
```

会话级（与 turn 平级）：`ConverstionMemories` 逐条渲染为 `<ConverstionMemories memoryId turnId sourceCallId?>` 元素、正文为 `text`（`mm_`）；`summaries` 容器以 start / end 标出首尾 sumId，每条摘要渲染为 `<summary sumId turnId summary? level? turnIds? from?>` 元素、正文为 `userRequest` / `actions` / `result`；`tasks` 容器以 start / end 标出任务 ID，`task` 为 `<task id title? status createdTurnId? updatedTurnId?>` 元素，每条步骤一个 `<item id status expectedEffect? verification? blockedReason? outcome?>`、正文为步骤 `text`（当前活跃或最近完成的任务实体，跨轮唯一持久化，直到新任务顶替）。

`workspaces` 在会话级按 `target` 对象归组展示，每组为 `<workspace kind key>`，正文为 `{operations:[...]}`；目标种类为 `file`、`browser`、`script`、`process`、`tool`。每项操作证据保存 `op`、`args`、`result`、`content`、`range`、`mutation`、`revision` 与 `sources:[{id,turnId,callId,boundId}]`，字段按实际工具结果提供。文件按明确路径归组，同文件内容合并，shell 命令不推断文件路径。归组只影响展示：每项证据仍归属来源 turn，随该轮压缩归档；已覆盖的证据从当前归组中移除，剩余证据继续展示。

轮次级（`<turn>` 内，有则写、无则省略）：轮次 ID 与本段工具调用 ID 范围已收为 `<turn>` 的属性（`turnId` / `start` / `end`，单次调用时 start 与 end 相同），不再是二级标签。

| 标签 | 渲染形状 | 身份字段 |
| --- | --- | --- |
| `userInput` | `<userInput id>`，正文含 `turnId` 与 `userInput` 用户原话 | `id` |
| `calls` | 每轮的 `<calls start end kept total>`，每条一个 `<call callId name ok?>` 元素 | start / end 为该轮调用范围，kept 为本次可见条数，total 为该轮调用总数；callId 全会话唯一，凭 callId 调 evidence_search 回查 |
| `observation` | 每条观察一个元素，容器为 `<observations start end>`，元素属性含 `id callId type` 等，正文保留 `tabId`（如有）与 `result` 等返回字段 | `id` |
| `note` | 本轮草稿，`<note id key>` + 正文；容器 `<notes start end>` | `id`（`nt_`），key 为业务键；start / end 使用首尾笔记 ID |
| `reflections` | `<reflections start end>` 下每条 `<reflect id focus?>` + 正文 | rf_ |
| `query` | `<queries start end>` 下每条一个 `<query id sumId module status sourceCallId?>` 元素 | `id` 使用记录的 `queryId`（`query_`）；start / end 使用首尾查询 ID |
| `stopReason` | `<stopReason kind callId?>` + 正文 | — |

被压缩覆盖的 `<turn>` 整块删除，只在 `<summary>` 留摘要。会话记忆随来源轮次进入压缩，对应原文被覆盖后不再展示该条 `<ConverstionMemories>` 全文，落盘原记录仍保留；长期记忆 `<projectMemory>` 不参与压缩，被注入时保留全文。任务记录 `Task` 为会话级唯一实体，items 用 `item_` 编号。查询记录为 `{queryId, turnId, sumId, module, intent, status, records, sourceCallId?, detail?}`。

统一可选布尔参数 `keepInCalls` 只影响窗口可见性：显式 true 持续保留至原有压缩覆盖；false 或未指定的调用详情仅在返回后的下一次模型请求展示一次。全部原始调用完整落盘并按原轮次参与压缩，窗口移出不影响归档与 callId 回查。

工具投影的每条调用带 `args`（调用参数；大小超门禁时只留 `files` 路径，记账类指针调用不带）、`return` 为 `{stage, result}`；操作证据已保存到 workspace 时，调用投影使用 workspace 引用，正文保留在对应对象中，避免重复。result 与 observations 中同一 callId 的观察对应时，只保留 `{ok, observationId}`。context_query 的 result 为 `{ok, status, sumId, module, intent, recordCount}`。归档原文使用 `{stage, totalChars, text}`，只出现在压缩/查询候选里，不进主模型窗口。finishTurn / askUser 在 toolIO 只存指针 `{output:"reply"|"ask"}`，正文在本轮 stopReason。

Schema 检查字段类型、必填项、ID 格式及已知记录结构，拒绝未声明的顶层模块。编号至少两位，前缀来自 ID 清单。Schema 不检查编号唯一性、自增状态、引用是否存在或查询是否命中；统一内联门禁由 Runtime 验证。

workspace 记录现有门禁处理后的最终返回：小结果保留正文，大结果保留门禁返回的状态、错误、索引及原文路径；完整原文沿用 returns 落盘，不重新塞回 workspace。calls 只引用对应 workspace，不增加另一层门禁。
