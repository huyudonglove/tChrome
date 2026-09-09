# schema

数据声明只写这里。`docs/data.md` 是账本形状和循环。`docs/examples/` 是阶段样例，字段怎么填看本文件。工具参数形状看 `context/tools/<id>.json`。插槽用途、来源与边界见 `context/system-slots.md`、`context/user-slots.md` 和各独立槽文件。

## 仓目录

```text
extension/          GUI：Side Panel + background。常规通用 UI 组件和样式
  ui/               通用组件、样式
  sidepanel/        面板入口
service/            后端：Bun.serve 127.0.0.1:18788。按模块分
  runtime/
  context/          读取上下文模块，按清单顺序装配窗口
  tools/
  subagent/         第一期空着
  provider/
context/            独立模块 / skill / tools schema / 栏目顺序清单
  system/           一个 system 插槽一个文件
  user/             一个 user 插槽一个文件
  system-slots.md   system 职责与顺序清单
  user-slots.md     user 职责与顺序清单
  README.md         人类维护入口，不进入模型窗口
  skills/           网页方法
  tools/groups.json 常驻基础工具 / 初始动态工具分组
  tools/index.json  browser / service 分类
  tools/*.json      完整工具 schema

docs/               schema、账本、阶段样例
```

Load unpacked：`bun build` 把 `extension/` 打进 `dist/`，仓根 `manifest.json` 拷进 `dist/`。Chrome 加载 `dist/`。`dist/` 已 gitignore。产物路径仍是 `background.js` / `sidepanel.html`。GUI 只跟本机服务说话。密钥、落盘、出网 UUAPI 在 `service/`。

## 本机 HTTP

第一期七条。面板长请求直连 `http://127.0.0.1:18788`。浏览器工具由 background 泵：面板每秒 `ping` worker，worker 拉 `/tool-request`，跑完交 `/tool-result`。

| 方法 | 路径 | 体 | 回 |
|---|---|---|---|
| GET | `/health` | 无 | `{ok:true}` |
| POST | `/turn` | `{userInput, submittedAt, currentTab?}` | `{conversationId, turnId, output}`。`currentTab` 是 `{tab, url, title}`，开 Turn 写入 `#currentTab`。没有就槽空着 |
| POST | `/stop` | 无 | 停当前 Turn。账本 `paused`，投影回 `{conversationId, status, pendingAsk, liveTool, messages}`。下一句可再开 Turn |
| GET | `/session` | 无 | 当前 `session.json` 指向的会话投影：`{conversationId, status, pendingAsk, liveTool, messages}`。`messages` 按流水：user / 每次出网的 `content` / 已跑工具的 `return` / 正在跑（`live:true`）/ 排队工具。没有 `content` 时才用收口 `output` |
| GET | `/conversations` | 无 | `{items:[{conversationId, updatedAt, status, preview}]}`。当前 `session.json` 指向的排第一，其余按 `updatedAt` 新到旧。空会话 preview 是「新会话」 |
| POST | `/conversations/open` | `{conversationId}` | 该会话投影，并写入 `session.json` |
| POST | `/conversations/new` | 无 | 新建空 `cv_`，写入 `session.json`，回空投影 |
| POST | `/conversations/delete` | `{conversationId}` | 删掉该会话目录。若删的是当前会话，切到最近一条或新建 |
| GET | `/tool-request` | 无 | `{request}`，没有就 `request=null`。`request` 是 `{id, name, input}` |
| POST | `/tool-result` | `{id, result}` | `{ok:true}` |

`output` 见「output」。整轮收口再回一次。面板读 `/session`：模型和工具的 reason 作为过程说明，Turn.output 作为助手回复；工具原始 return 不显示。`pendingAsk.choice` 取最近一次 `askUser` 的 `choice`。`/turn` 仍不带 id，用当前 `session.json`。

## 落盘文件

运行时数据在 `~/Library/Application Support/tChrome/`：

```text
session.json
conversations/<cvId>/ledger.json
conversations/<cvId>/events.jsonl
conversations/<cvId>/provider.md
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

## provider.md

每个会话一份。每次出网追加一节。发送和返回都留。正文用真换行，不塞进 JSON 字符串。

标题 `## tn_01 / 1`。json 围栏只放元数据。system / user / content / tool_calls 四个小节用普通围栏，正文真换行。

| 字段 | 怎么填 |
|---|---|
| 标题 `## tn_ / outbound` | 本 Turn 第几次出网 |
| json 围栏 | 元数据：`at` `toolIds` `finish` `toolCalls` `faultCode` |
| `### system` / `### user` | 发给模型的窗口，真换行 |
| `### content` | 模型 content，真换行 |
| `### tool_calls` | 模型交的工具，一行一个 |

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
| `notes` | object | 模型自管的 key/value。新会话 `{}`。`notes.write` 写入或覆盖 `notes[key]`。`notes.delete` 删除 `notes[key]`。进 user `#notes` |
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
| `usage` | object，可选 | 新 Turn 分别记录 `modelRequests` 与 `toolCalls`。工具批次逐个计数，包含常驻与收口工具；未通过校验而未执行的调用不计入。旧 Turn 可缺省。统计不作为累计 20 次的停止条件。 |

### assembled

| 字段 | 类型 | 怎么填 |
|---|---|---|
| `baseToolsIds` | string[] | 常驻工具，对应 `context/tools/<id>.json`；完整名单以 `context/tools/groups.json` 为准，说明进入 system `#baseTools` |
| `toolIds` | string[] | 动态工具，对应 `context/tools/<id>.json`。开 Turn 先挂 core（`page.get_summary` `page.list_regions` `page.list_interactive_elements` `page.click` `page.type` `open_url` `web_search` `list_browser_tools` `catalog.add`）。缺了 `catalog.add` 再补。压缩时先裁回 core + 本轮已用过的 |
| `turnMemoryIds` | string[] | 这一轮记忆；没有就 `[]` |
| `conversationMemoryIds` | string[] | 这一次会话记忆；没有就 `[]` |
| `projectMemoryIds` | string[] | 项目记忆；没有就 `[]` |
| `mcpIds` | string[] | 本轮 MCP；没有就 `[]` |
| `currentTab` | object \| null | 开 Turn 由 Runtime 写入。面板 `POST /turn` 带当前标签 `{tab, url, title}`。没有就 `null`。进 user `#currentTab` |
| `currentPage` | object \| null | 开 Turn 为 `null`。模型调 `page.get_summary`（或其它会改当前页的工具）跑完后，Runtime 用返回填 `description` `tab` `url` `title`。进 user `#currentPage` |

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
- `reply` → `{kind, text}`（`finishTurn`，`text` 取 finishTurn.arguments.text；历史调用可回退 content.action，不用 reason 顶）
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

插槽导航分别维护在 `context/system-slots.md` 与 `context/user-slots.md`。程序直接读取两份清单的编号行，按清单顺序加载并排列对应模块，不再维护独立窗口模板；`context/system/<name>.md` 和 `context/user/<name>.md` 各自维护执行规则或 `{{data}}`。静态 system 规则直接在各文件中维护，无运行时附加数据；动态槽由 Runtime 注入。装配不再按大 Pack 标题切割。空数据仍保留说明，不能解释为页面为空或任务完成。

顺序仅以两份栏目清单为准，本文不再另列顺序。

`#skill` 数据来自固定的 `context/skills/skill.web.md`；不再记录无实际加载作用的 systemIds / skillIds。其余 user 数据分别来自 Turn.input、ledger、Turn.assembled 和 memory 文件，具体字段与可信边界见各独立槽文件。

`#baseTools` 按 toolGroups.baseToolsIds 生成常驻工具说明；`#tools` 按 Turn.assembled.toolIds 生成已加载动态工具说明。说明唯一来源是各工具 `function.description`；`context/tools/index.json` 只保存 browser / service 分类，不能另写 usage。`#tools` 是 user 参考文本，不是 role=tool 消息。工具 schema 的 description 与窗口说明同源。

维护：增删、重命名或调整插槽职责、顺序时，同步清单、独立文件、装配测试与阶段窗口示例；修改工具说明只改该工具定义，并重新生成示例中的 schema / 工具说明。测试检查目录、清单、顺序、装配及全量工具 description 缺失。

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

`askUser` 的 `text` 是问题和选项。`finishTurn` 的 `text` 是回复用户的正文（优先取 finishTurn.arguments.text，兼容历史 content.action）。动态工具 / `tool.detail` / `observation.detail` 的 `text` 是工具跑出来的正文。`memory.write` 的 `text` 是落下的层和条数。

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

`finish`：`tool_calls` / `stop` / `error`。`content`：system `#output` 三段 seen / reason / action。`toolCalls`：`{id, name, arguments}`，已 parse。

`faultCode`：

| 值 | 何时 |
|---|---|
| `arguments_not_json` | `function.arguments` 解析失败。对象原样用；字符串 `JSON.parse`；围栏、尾逗号、单引号只修外壳。不补字段。好的 `toolCalls` 照跑，坏的那条写进 `#toolIO` 再出网。同一 Turn 最多 3 次 |
| `unknown_tool` | `name` 不在 `baseToolsIds` + `toolIds` |
| `missing_required` | catalog `required` 缺或空。`missing` 列出字段名，写进 `#toolIO` 再出网。不补字段。同一 Turn 最多 3 次 |
| `wrong_type` | Ajv：类型对不上 schema。写进 `#toolIO` 再出网。同一 Turn 最多 3 次 |
| `exclusive_resident` | 同一次出网里 `finishTurn` / `askUser` 不在最后一条。写进 `#toolIO` 再出网 |
| `need_finish_turn` | `finish=stop` 且 `tool_calls` 为空，连续 3 次。每次先写 `service/runtime/messages.json 的 needFinishTurn` 进 `#toolIO` 再出网 |

Ajv 只验 `tool_calls[].arguments`，不验 `content`。

## 工具参数

每个工具 `arguments` 都有 `reason`（string）和 `affectsPage`（boolean）。其余按 `context/tools/<id>.json`。动态工具分类在 `context/tools/index.json`；用法只维护在每个工具定义的 function.description。

| 工具 | required 其余 | 谁填其余 |
|---|---|---|
| `askUser` | `question`、`choice` | 非空问题正文与选项 |
| `submitGoal` | `goal` | 当前目标。改写时 Runtime 把旧值追加进 `goalHistory` |
| `finishTurn` | `text` | 非空回复正文，不依赖 content |
| `tool.detail` | `callId` | `#toolIO` 该项的 `callId` |
| `observation.detail` | `observationId` | `#observation` 该项的 `id` |
| `notes.write` | `key` `value` | 写入或覆盖 `ledger.notes[key]`。模型自定 key |
| `notes.delete` | `key` | 删除 `ledger.notes[key]` |
| `memory.write` | （无） | `turnMemory` `conversationMemory` `projectMemory` `contextSummary` 有则写 |
| `catalog.add` | `names` | 把缺的动态工具挂进本轮 |

常驻与初始动态工具名单以 `context/tools/groups.json` 的 baseToolsIds / coreToolIds 为准。动态目录分类见 `context/tools/index.json`，缺能力通过 catalog.add 加载。浏览器工具经 `/tool-request` 泵到 background。

没迁、原因：

| 工具 | 原因 |
|---|---|
| Planner / Task / Review / Memory / Compress / Evolve 岗工具（`submit_plan` `submit_split` `ask_choice` `continue_task` `stop` `use_skill` …） | tChrome 单 Agent，没有这套岗 |
| `native_host` `port_scan` `dns_enum` `proxy_chain` `code_runner` `use_host` `local_workspace` `project_storage` | 没有 Native Messaging / 本机宿主 |
| `request_tool_service` `request_memory_service` | 挂在岗流水线上，tChrome 没有对应岗 |

`api_discover` / `api_manage` 迁了 schema 和执行入口，登记表第一期空数组。

运行提示独立维护在 `service/runtime/messages.json`，由运行层按需写入工具记录。
