# schema

数据声明只写这里。`docs/data.md` 是账本形状和循环。`docs/examples/` 是阶段样例，字段怎么填看本文件。工具参数形状看 `catalog/tools/<id>.json`。Pack 用法看 `catalog/packs/pack.agent.md`。

## 落盘文件

```text
ledger.json
turns/<turnId>.json
memory/<memoryId>.json
observations/<observationId>.json
```

前缀：`cv_` 会话 · `tn_` 回合 · `mm_` 记忆 · `ob_` 压缩事实 · `call_` 工具调用。

## ledger.json

Runtime 独占维护。当前会话指针。

| 字段 | 类型 | 怎么填 |
|---|---|---|
| `schemaVersion` | number | `1` |
| `conversationId` | string | `cv_` |
| `createdAt` | string | ISO-8601 |
| `updatedAt` | string | ISO-8601 |
| `status` | string | `idle` 无活动回合 / `running` 在转 / `waiting_human` 冻在追问 / `paused` / `failed` |
| `active` | object \| null | `{turnId}`；没有就 `null` |
| `pendingAsk` | object \| null | `waiting_human` 时 `{turnId, question}`；否则 `null` |
| `turnIds` | string[] | 已建的回合，按时间 |
| `userInputHistory` | string[] | 上一轮及更早的用户原话，按时间。新会话 `[]`。用户下一条输入开新 Turn 时，Runtime 把刚结束那一轮的 `userInput` 追加进去 |
| `toolQueue` | object[] | 本 Turn 待执行的工具。模型一次出网交的 `toolCalls` 按数组顺序入队。任务队列按这个顺序跑。跑完一条弹出，写入 `toolIO`。新会话 / 新出网前空。每项 `{callId, name, arguments}` |
| `toolIO` | object[] | 本会话已执行、窗口里还带着的工具调用。新会话 `[]`。队列里跑完一条追加一条，最新在最下面。窗口到 200K 时较早的条目收进 `observation`。每项见「toolIO 项」 |
| `observation` | object[] | 压缩过的事实。新会话 `[]`。每项 `{id, text, sourceCallIds}`。`text` 是摘要。全文在 `observations/<id>.json`，用 `observation.detail` 取 |
| `windowChars` | number | 本轮出网窗口已用字符数。开 Turn 装配后、以及本 Turn 每次出网前，Runtime 写入 |
| `compressAt` | number | 压缩门槛，固定 `200000` |
| `memoryIds` | object | `{turn, conversation, project}`，各是 string[] |

## turns/<turnId>.json

用户一轮对话。用户一条输入开一个 Turn。本 Turn 内可多次出网。

| 字段 | 类型 | 怎么填 |
|---|---|---|
| `turnId` | string | `tn_` |
| `conversationId` | string | `cv_` |
| `status` | string | `assembling` → `inferring` → `completed` / `waiting_human` / `failed`。工具循环时停在 `inferring` |
| `createdAt` | string | ISO-8601 |
| `completedAt` | string \| null | 收口时写；进行中 `null` |
| `input.text` | string | 本轮用户原话。用户下一条输入才开新 Turn |
| `input.submittedAt` | string | 面板提交时间，ISO-8601 |
| `assembled` | object | 这一轮点名的 catalog IDs + 当前页，见「assembled」 |
| `output` | object | 见「output」 |

### assembled

| 字段 | 类型 | 怎么填 |
|---|---|---|
| `systemIds` | string[] | 本轮 Pack，对应 `catalog/packs/<id>.md` |
| `skillIds` | string[] | 本轮 skill，对应 `catalog/skills/<id>.md` |
| `sopIds` | string[] | 本轮 SOP，对应 `catalog/sops/<id>.md` |
| `baseToolsIds` | string[] | 常驻工具，对应 `catalog/tools/<id>.json`。固定 `askUser` `finishTurn` `tool.detail` `observation.detail` `memory.write` |
| `toolIds` | string[] | 动态工具，对应 `catalog/tools/<id>.json`。没有就 `[]` |
| `turnMemoryIds` | string[] | 这一轮记忆；没有就 `[]` |
| `conversationMemoryIds` | string[] | 这一次会话记忆；没有就 `[]` |
| `projectMemoryIds` | string[] | 项目记忆；没有就 `[]` |
| `mcpIds` | string[] | 本轮 MCP；没有就 `[]` |
| `currentPage` | object \| null | 没有就 `null`。有则 `description` `tab` `url` `title` |

`currentPage`：

| 字段 | 类型 | 怎么填 |
|---|---|---|
| `description` | string | 这块环境是什么 |
| `tab` | number | Chrome tabId，≥ 1 |
| `url` | string | 当前页 URL |
| `title` | string | 当前页标题 |

### output

`kind`：`tool` / `ask` / `reply` / `error`。

- `tool` → `{kind, name, callId}`（动态工具 / `tool.detail` / `observation.detail` / `memory.write`）
- `ask` → `{kind, question}`（`askUser`）
- `reply` → `{kind, text}`（`finishTurn`，`text` 取 content 的 action）
- `error` → `{kind, faultCode}`

## memory/<memoryId>.json

三层，从稳到新：project → conversation → turn。模型调 `memory.write` 提交。Runtime 落盘，ID 挂到 ledger.`memoryIds`。下一次出网装配进对应 user 槽。

窗口到 200K 时 Runtime 压缩 `turn` 和 `conversation`：槽里只留 `summary`，原文仍按 `memoryId` 落盘。`project` 不压。

| 字段 | 类型 | 怎么填 |
|---|---|---|
| `memoryId` | string | `mm_` |
| `layer` | string | `turn` / `conversation` / `project` |
| `text` | string | 原文 |
| `summary` | string | 压缩后的摘要 |
| `compressed` | boolean | `true` 时窗口槽用 `summary` |
| `createdAt` | string | ISO-8601 |
| `sourceCallId` | string | 写下这条的 `memory.write` 的 `callId` |

## observations/<observationId>.json

压缩过的事实全文。窗口只带摘要。

| 字段 | 类型 | 怎么填 |
|---|---|---|
| `observationId` | string | `ob_` |
| `text` | string | 摘要（窗口用同一段） |
| `full` | string | 被收走的 toolIO / 记忆原文 |
| `sourceCallIds` | string[] | 收进来的 `callId` |
| `totalChars` | number | `full` 的字符数 |
| `createdAt` | string | ISO-8601 |

## 窗口插槽

用户一条输入开一个 Turn，CE 装配一次。本 Turn 内工具循环不再走 CE。

system 顺序 = `systemSlots`：`#身份` `#记忆` `#观察` `#环境` `#原则` `#参数说明` `#内置工具` `#输出` `#user字段说明` `#skill` `#sop`

user 顺序 = `userSlots`：

| 槽 | 正文来自 |
|---|---|
| `#projectMemory` | ledger.`memoryIds.project` 对应文件。窗口到 200K 仍用全文 |
| `#conversationMemory` | ledger.`memoryIds.conversation`。压缩后用 `summary` |
| `#turnMemory` | ledger.`memoryIds.turn`。压缩后用 `summary` |
| `#contextSummary` | 最近一次 `memory.write` 的 `contextSummary` |
| `#observation` | ledger.`observation` |
| `#userInputHistory` | ledger.`userInputHistory`（不含本轮） |
| `#userInput` | Turn.`input.text` |
| `#currentEnvironment` | Turn.`assembled.currentPage` |
| `#toolIO` | ledger.`toolIO` |
| `#tools` | 本轮动态工具用法。常驻用法在 Pack |

出网 `tools[]` = `baseToolsIds` + `toolIds` 的 catalog schema。

## toolIO 项 / toolQueue 项

| 字段 | 类型 | 怎么填 |
|---|---|---|
| `callId` | string | `call_`。模型 `tool_calls[].id` |
| `name` | string | 工具名，必须在 `baseToolsIds` + `toolIds` |
| `arguments` | object | 已 parse。每个工具都有 `reason` `affectsPage`，其余按 catalog `required` |
| `return` | object | 队列跑完才有。`{stage, totalChars, text}` |

`return`：

| 字段 | 类型 | 怎么填 |
|---|---|---|
| `stage` | string | `complete` 全文 ≤ 2000 字；`truncated` 超出，`text` 只留前 2000 字 |
| `totalChars` | number | 全文长度（JS `string.length` / Python `len`） |
| `text` | string | 窗口正文，最多 2000 字 |

`askUser` 的 `text` 是问题和选项。`finishTurn` 的 `text` 是回复用户的正文（取 content 的 action）。动态工具 / `tool.detail` / `observation.detail` 的 `text` 是工具跑出来的正文。`memory.write` 的 `text` 是落下的层和条数。

要全文调 `tool.detail`，参数 `callId`。要看压缩事实调 `observation.detail`，参数 `observationId`。

## 阶段快照

`docs/examples/` 每份「写出的」是累积快照：前面已有的键原样带上，本环节改 `stage` 并追加键。字段声明只在本文件。

| `stage` | 文件 | 本环节追加 / 改写 |
|---|---|---|
| `normalize` | 01 | `conversationId` `turnId` `userInput` `userInputHistory` `submittedAt` |
| `context-engineering-input` | 02 | assembled 那组 ID + `currentPage` |
| `context-engineering-decode` | 03 | `systemSlots` `userSlots` |
| `provider-request` | 04 | `provider` `model` `stream` `maxAttempts` |
| `provider-response` | 05 | `finish` `content` `toolCalls` `attempts` `parseOk` `schemaOk` `faultCode` `missing` |
| `tool-execute` | 06 | `toolQueue` `toolIO` |
| `compress` | 07 | `observation` `windowChars` `compressAt`；改写 `toolIO` |
| `finish-turn` | 08 | 同一 Turn 再出网的 `finish` `content` `toolCalls`；`toolIO` 追加 `finishTurn` |

面板入口只有 `userInput` `submittedAt`。其余键 Runtime 写。

`provider`：`uuapi`。`model`：`gemini-3.7-flash`。`stream`：`true`。`maxAttempts`：`3`。

`finish`：`tool_calls` / `stop` / `error`。`content`：Pack `#输出` 三段 observation / reason / action。`toolCalls`：`{id, name, arguments}`，已 parse。

`faultCode`：

| 值 | 何时 |
|---|---|
| `arguments_not_json` | `function.arguments` 字符串 `JSON.parse` 失败 |
| `unknown_tool` | `name` 不在 `baseToolsIds` + `toolIds` |
| `missing_required` | catalog `required` 缺或空；`missing` 列出字段名 |
| `wrong_type` | Ajv：类型对不上 schema |
| `exclusive_resident` | 同一次出网里 `finishTurn` 不在最后一条 |

Ajv 只验 `tool_calls[].arguments`，不验 `content`。

## 工具参数

每个工具 `arguments` 都有 `reason`（string）和 `affectsPage`（boolean）。其余按 `catalog/tools/<id>.json`。

| 工具 | required 其余 | 谁填其余 |
|---|---|---|
| `askUser` | `choice` | 给用户的选项 |
| `finishTurn` | （无） | 回复正文在 content 的 action |
| `tool.detail` | `callId` | `#toolIO` 该项的 `callId` |
| `observation.detail` | `observationId` | `#observation` 该项的 `id` |
| `memory.write` | （无） | `turnMemory` `conversationMemory` `projectMemory` `contextSummary` 有则写 |
| `web.search` | `query` | 检索词 |

常驻：`askUser` `finishTurn` `tool.detail` `observation.detail` `memory.write`。动态本轮才挂，如 `web.search`。
