# schema

数据声明只写这里。`docs/data.md` 是账本形状和循环。`docs/examples/` 是阶段样例，字段怎么填看本文件。工具参数形状看 `catalog/tools/<id>.json`。Pack 用法看 `catalog/packs/pack.agent.md`。

## 仓目录

```text
extension/          GUI：Side Panel + background。常规通用 UI 组件和样式
  ui/               通用组件、样式
  sidepanel/        面板入口
service/            后端：Bun.serve 127.0.0.1:18788。按模块分
  runtime/
  prompt/
  context/
  tools/
  subagent/         第一期空着
  provider/
catalog/            Pack / skill / SOP / 参考 / tools schema / 窗口模板
  assemble.json     本轮点哪些 pack / skill / sop / 常驻工具 / 核心工具
  advice.md         user `#参考`
  window.system.md  system 插槽：事实
  window.user.md    user 插槽：参考材料
docs/               schema、账本、阶段样例
```

Load unpacked：`bun build` 把 `extension/` 打进 `dist/`，仓根 `manifest.json` 拷进 `dist/`。Chrome 加载 `dist/`。`dist/` 已 gitignore。产物路径仍是 `background.js` / `sidepanel.html`。GUI 只跟本机服务说话。密钥、落盘、出网 UUAPI 在 `service/`。

## 本机 HTTP

第一期七条。面板长请求直连 `http://127.0.0.1:18788`。浏览器工具由 background 泵：面板每秒 `ping` worker，worker 拉 `/tool-request`，跑完交 `/tool-result`。

| 方法 | 路径 | 体 | 回 |
|---|---|---|---|
| GET | `/health` | 无 | `{ok:true}` |
| POST | `/turn` | `{userInput, submittedAt, currentTab?}` | `{conversationId, turnId, output}`。`currentTab` 是 `{tab, url, title}`，开 Turn 写入 `#currentPage`。没有就槽空着 |
| POST | `/stop` | 无 | 停当前 Turn。账本 `paused`，投影回 `{conversationId, status, pendingAsk, liveTool, messages}`。下一句可再开 Turn |
| GET | `/session` | 无 | 当前 `session.json` 指向的会话投影：`{conversationId, status, pendingAsk, liveTool, messages}`。`messages` 含 user / 已跑工具 / 正在跑（`live:true`）/ 排队工具 / assistant |
| GET | `/conversations` | 无 | `{items:[{conversationId, updatedAt, status, preview}]}`。当前 `session.json` 指向的排第一，其余按 `updatedAt` 新到旧。空会话 preview 是「新会话」 |
| POST | `/conversations/open` | `{conversationId}` | 该会话投影，并写入 `session.json` |
| POST | `/conversations/new` | 无 | 新建空 `cv_`，写入 `session.json`，回空投影 |
| POST | `/conversations/delete` | `{conversationId}` | 删掉该会话目录。若删的是当前会话，切到最近一条或新建 |
| GET | `/tool-request` | 无 | `{request}`，没有就 `request=null`。`request` 是 `{id, name, input}` |
| POST | `/tool-result` | `{id, result}` | `{ok:true}` |

`output` 见「output」。整轮收口再回一次。工具循环不推到面板。面板读账本：`messages` 按 `turnIds` 展开，每轮用户句 + 助手 `output`。`pendingAsk.choice` 取最近一次 `askUser` 的 `choice`。`/turn` 仍不带 id，用当前 `session.json`。

## 落盘文件

运行时数据在 `~/Library/Application Support/tChrome/`：

```text
session.json
conversations/<cvId>/ledger.json
conversations/<cvId>/events.jsonl
conversations/<cvId>/provider.json
conversations/<cvId>/turns/<turnId>.json
conversations/<cvId>/memory/<memoryId>.json
conversations/<cvId>/observations/<observationId>.json
conversations/<cvId>/returns/<callId>.txt
```

JSON 快照覆盖写。流水只追加，不改已经写下的行。

前缀：`cv_` 会话 · `tn_` 回合 · `mm_` 记忆 · `ob_` 压缩事实 · `call_` 工具调用。

## events.jsonl

每次数据产生追加一行，不覆盖。一行一个 JSON 对象。

| 字段 | 类型 | 怎么填 |
|---|---|---|
| `at` | string | ISO-8601 |
| `kind` | string | `session` 建会话 / `normalize` 用户输入开 Turn / `assemble` 装配 / `provider-request` 出网前 / `provider-response` 模型交口 / `tool` 工具跑完 / `memory` 落下一条记忆 / `compress` 压缩 / `turn-output` 本 Turn 收口 |
| `turnId` | string | 有回合就写 `tn_`；建会话没有 |
| `data` | object | 这一次产出的正文 |

`kind=normalize` 的 `data`：`userInput` `submittedAt` `userInputHistory`。
`kind=assemble` 的 `data`：`assembled`。
`kind=provider-request` 的 `data`：`windowChars` `toolIds`。
`kind=provider-response` 的 `data`：`finish` `content` `toolCalls` `attempts` `parseOk` `schemaOk` `faultCode` `missing`。
`kind=tool` 的 `data`：`callId` `name` `arguments` `return`。
`kind=memory` 的 `data`：`memoryId` `layer` `sourceCallId`。
`kind=compress` 的 `data`：`observationId` `windowChars` `sourceCallIds` `compressedMemoryIds` `prunedToolIds`。`observationId` 没有折 toolIO 时为 `null`。压缩先裁 `toolIds`（留下 core + 本轮已用过的）和记忆窗口（每层最近 8 条），再把 turn/conversation 收成 `summary`。
`kind=turn-output` 的 `data`：`output`。
`kind=session` 的 `data`：`conversationId`，可选 `action`=`new`/`open`。

## provider.json

每个会话一份。每次出网追加一条，不覆盖前面的。看发给模型的窗口和模型交回的 content / toolCalls。

```json
[
  {
    "at": "2026-09-07T00:00:00.000Z",
    "turnId": "tn_01",
    "outbound": 1,
    "request": {
      "messages": [
        { "role": "system", "content": "..." },
        { "role": "user", "content": "..." }
      ],
      "toolIds": ["askUser", "finishTurn"]
    },
    "response": {
      "finish": "tool_calls",
      "content": "observation\n...\nreason\n...\naction\n...",
      "toolCalls": [{ "id": "call_01", "name": "finishTurn", "arguments": { "reason": "答完", "affectsPage": false } }],
      "attempts": 1,
      "parseOk": true,
      "schemaOk": true,
      "faultCode": null,
      "missing": [],
      "detail": ""
    }
  }
]
```

| 字段 | 类型 | 怎么填 |
|---|---|---|
| `at` | string | ISO-8601 |
| `turnId` | string | 这次出网所属 Turn |
| `outbound` | number | 本 Turn 第几次出网，从 1 起 |
| `request.messages` | array | 发给模型的 system / user 全文 |
| `request.toolIds` | string[] | 这次 `tools[]` 的名字，schema 仍在 catalog |
| `response` | object | 模型交口：`finish` `content` `toolCalls` `attempts` `parseOk` `schemaOk` `faultCode` `missing` `detail` |

`events.jsonl` 的 `provider-request` / `provider-response` 仍只记元数据。完整窗口看这份。

## session.json

当前打开的会话。Runtime 独占维护。面板不带 id。

| 字段 | 类型 | 怎么填 |
|---|---|---|
| `conversationId` | string | `cv_`。第一次没有就建一个，写进这里。切会话走 `POST /conversations/open`，新建走 `POST /conversations/new` |

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
| `goal` | string | 当前目标。新会话 `""`。模型调 `submitGoal` 写入。空着也能干活 |
| `goalHistory` | string[] | 旧目标。Runtime 在 `submitGoal` 改写且新值和旧值不同时，把旧目标追加进去。模型不要写 |
| `toolQueue` | object[] | 本 Turn 待执行的工具。模型一次出网交的 `toolCalls` 按数组顺序入队。任务队列按这个顺序跑。跑完一条弹出，写入 `toolIO`。新会话 / 新出网前空。每项 `{callId, name, arguments}` |
| `liveTool` | object \| null | 正在跑的那条 `{name, callId}`。空闲 / 追问 / 失败为 `null` |
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
| `skillIds` | string[] | 本轮 skill，对应 `catalog/skills/<id>.md`，进 user `#skill` |
| `sopIds` | string[] | 本轮 SOP，对应 `catalog/sops/<id>.md`，进 user `#sop` |
| `baseToolsIds` | string[] | 常驻工具，对应 `catalog/tools/<id>.json`。固定 `askUser` `finishTurn` `submitGoal` `tool.detail` `observation.detail` `memory.write` |
| `toolIds` | string[] | 动态工具，对应 `catalog/tools/<id>.json`。开 Turn 先挂 core（`page.get_summary` `page.list_regions` `page.list_interactive_elements` `page.click` `page.type` `open_url` `web_search` `list_browser_tools` `catalog.add`）。缺了 `catalog.add` 再补。压缩时先裁回 core + 本轮已用过的 |
| `turnMemoryIds` | string[] | 这一轮记忆；没有就 `[]` |
| `conversationMemoryIds` | string[] | 这一次会话记忆；没有就 `[]` |
| `projectMemoryIds` | string[] | 项目记忆；没有就 `[]` |
| `mcpIds` | string[] | 本轮 MCP；没有就 `[]` |
| `currentTab` | object \| null | 开 Turn 由 Runtime 写入。面板 `POST /turn` 带当前标签 `{tab, url, title}`。没有就 `null`。进 user `#currentPage` |
| `currentPage` | object \| null | 开 Turn 为 `null`。模型调 `page.get_summary`（或其它会改当前页的工具）跑完后，Runtime 用返回填 `description` `tab` `url` `title`。进 user `#currentEnvironment` |

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
- `reply` → `{kind, text}`（`finishTurn`，`text` 只取 content 的 action。没有 action 就空着，不用 reason 顶）
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

system 顺序 = `catalog/window.system.md`：身份、记忆、观察、环境、协议、参数、内置工具、输出、user槽说明。都是事实。
user 顺序 = `catalog/window.user.md`：参考 / skill / sop / 记忆 / 输入 / 目标 / 当前页 / toolIO / tools。都是参考材料，按需取用。

| 槽 | 正文来自 |
|---|---|
| `#参考` | `catalog/advice.md` |
| `#skill` | `catalog/skills/` |
| `#sop` | `catalog/sops/` |
| `#projectMemory` | ledger.`memoryIds.project` 对应文件。窗口只带最近 8 条，到 200K 仍用全文 |
| `#conversationMemory` | ledger.`memoryIds.conversation`。窗口只带最近 8 条，压缩后用 `summary` |
| `#turnMemory` | ledger.`memoryIds.turn`。窗口只带最近 8 条，压缩后用 `summary` |
| `#contextSummary` | 最近一次 `memory.write` 的 `contextSummary` |
| `#observation` | ledger.`observation` |
| `#userInputHistory` | ledger.`userInputHistory`（不含本轮） |
| `#userInput` | Turn.`input.text` |
| `#goal` | ledger.`goal` |
| `#goalHistory` | ledger.`goalHistory`。Runtime 组装 |
| `#currentPage` | Turn.`assembled.currentTab`。开 Turn 写入，只有 tab / url / title |
| `#currentEnvironment` | Turn.`assembled.currentPage` |
| `#toolIO` | ledger.`toolIO` |
| `#tools` | 本轮动态工具用法。常驻用法在 Pack |

出网 `tools[]` = `baseToolsIds` + `toolIds` 的 catalog schema。

## toolIO 项 / toolQueue 项

| 字段 | 类型 | 怎么填 |
|---|---|---|
| `callId` | string | `call_`。模型 `tool_calls[].id` |
| `name` | string | 工具名，必须在 `baseToolsIds` + `toolIds` |
| `turnId` | string | 这条工具属于哪一轮。`GET /session` 按这个把过程挂到对话里 |
| `arguments` | object | 已 parse。每个工具都有 `reason` `affectsPage`，其余按 catalog `required` |
| `return` | object | 队列跑完才有。`{stage, totalChars, text}` |

`return`：

| 字段 | 类型 | 怎么填 |
|---|---|---|
| `stage` | string | `complete` 全文 ≤ 2000 字；`truncated` 超出，`text` 只留前 2000 字 |
| `totalChars` | number | 全文长度（JS `string.length` / Python `len`） |
| `text` | string | 窗口正文，最多 2000 字 |

`askUser` 的 `text` 是问题和选项。`finishTurn` 的 `text` 是回复用户的正文（只取 content 的 action）。动态工具 / `tool.detail` / `observation.detail` 的 `text` 是工具跑出来的正文。`memory.write` 的 `text` 是落下的层和条数。

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
| `arguments_not_json` | `function.arguments` 解析失败。对象原样用；字符串 `JSON.parse`；围栏、尾逗号、单引号只修外壳。不补字段。好的 `toolCalls` 照跑，坏的那条写进 `#toolIO` 再出网。同一 Turn 最多 3 次 |
| `unknown_tool` | `name` 不在 `baseToolsIds` + `toolIds` |
| `missing_required` | catalog `required` 缺或空。`missing` 列出字段名，写进 `#toolIO` 再出网。不补字段。同一 Turn 最多 3 次 |
| `wrong_type` | Ajv：类型对不上 schema。写进 `#toolIO` 再出网。同一 Turn 最多 3 次 |
| `exclusive_resident` | 同一次出网里 `finishTurn` / `askUser` 不在最后一条。写进 `#toolIO` 再出网 |
| `need_finish_turn` | `finish=stop` 且 `tool_calls` 为空，连续 3 次。每次先写 `assemble.messages.needFinishTurn` 进 `#toolIO` 再出网 |

Ajv 只验 `tool_calls[].arguments`，不验 `content`。

## 工具参数

每个工具 `arguments` 都有 `reason`（string）和 `affectsPage`（boolean）。其余按 `catalog/tools/<id>.json`。动态工具名单和用法在 `catalog/tools/index.json`。

| 工具 | required 其余 | 谁填其余 |
|---|---|---|
| `askUser` | `choice` | 给用户的选项 |
| `submitGoal` | `goal` | 当前目标。改写时 Runtime 把旧值追加进 `goalHistory` |
| `finishTurn` | （无） | 回复正文在 content 的 action。没有 action 就空着 |
| `tool.detail` | `callId` | `#toolIO` 该项的 `callId` |
| `observation.detail` | `observationId` | `#observation` 该项的 `id` |
| `memory.write` | （无） | `turnMemory` `conversationMemory` `projectMemory` `contextSummary` 有则写 |
| `catalog.add` | `names` | 把缺的动态工具挂进本轮 |

常驻：`askUser` `finishTurn` `submitGoal` `tool.detail` `observation.detail` `memory.write`。动态开 Turn 先挂 core（`page.get_summary` `page.list_regions` `page.list_interactive_elements` `page.click` `page.type` `open_url` `web_search` `list_browser_tools` `catalog.add`）。全表见 `catalog/tools/index.json`，缺了 `catalog.add`。浏览器工具经 `/tool-request` 泵到 background。

没迁、原因：

| 工具 | 原因 |
|---|---|
| Planner / Task / Review / Memory / Compress / Evolve 岗工具（`submit_plan` `submit_split` `ask_choice` `continue_task` `stop` `use_skill` …） | tChrome 单 Agent，没有这套岗 |
| `native_host` `port_scan` `dns_enum` `proxy_chain` `code_runner` `use_host` `local_workspace` `project_storage` | 没有 Native Messaging / 本机宿主 |
| `request_tool_service` `request_memory_service` | 挂在岗流水线上，tChrome 没有对应岗 |

`api_discover` / `api_manage` 迁了 schema 和执行入口，登记表第一期空数组。

