# schema

数据声明只写这里。`docs/data.md` 是账本形状和循环。`docs/examples/` 是阶段样例，字段怎么填看本文件。工具参数形状看 `service/tools/definitions/<id>.json`。模块用途、来源与边界见 `service/context/modules.json`、`service/context/README.md` 和各 XML 模块文件。

## 仓目录

```text
service/                  本机服务，按职责组织
  runtime/                循环、账本、持久化、证据归档与浏览器桥
  context/                上下文正文、模块加载与纯窗口投影
    system/               固定规则与常驻工具模块
    user/                 请求、状态、记忆与动态工具模块
    modules.json          模块注册表：顺序、文件、consumers、compress
    README.md             维护入口，不进入模型窗口
  tools/                  工具注册、校验与服务端执行
    definitions/          schema、groups.json 分组与 index.json 分类
  agents/                 工具类 Agent，复用 provider.complete
    compression/          context 模块、输入输出校验与逐轮压缩流程
    query/                context 模块、输入输出校验与目录语义匹配
  context-archive/        归档存储、覆盖索引与来源展开
  provider/               模型通信、重试与响应解析
  presentation/           会话消息与列表的纯展示投影
extension/                Chrome 宿主
  background.ts           接收服务请求并调度浏览器工具
  tools/                  依赖 Chrome API 的宿主执行器及测试
  sidepanel/              面板入口
  ui/                     通用组件和样式
docs/                     数据协议与阶段示例
scripts/                  构建与示例同步
```

Load unpacked：`bun build` 把 `extension/` 打进 `dist/`，仓根 `manifest.json` 拷进 `dist/`。Chrome 加载 `dist/`。`dist/` 已 gitignore。产物路径仍是 `background.js` / `sidepanel.html`。GUI 只跟本机服务说话。密钥、落盘、出网 UUAPI 在 `service/`。

## 本机 HTTP

面板请求本机服务 `http://127.0.0.1:18788`。background 独立调度浏览器工具：拉 `/tool-request`，执行后交 `/tool-result`；面板 ping 用于唤醒，alarms 支持休眠后恢复。

| 方法 | 路径 | 体 | 回 |
|---|---|---|---|
| GET | `/health` | 无 | `{ok:true}` |
| POST | `/turn` | `{userInput, submittedAt}` | `{conversationId, turnId, output}`。Runtime 每次请求主模型前读取所有普通窗口及标签，刷新 `<openTabs>` |
| POST | `/stop` | 无 | 停当前 Turn。账本 `paused`，投影回 `{conversationId, status, pendingAsk, liveTool, messages}`。下一句可再开 Turn |
| GET | `/session` | 无 | 当前 `session.json` 指向的会话投影：`{conversationId, status, pendingAsk, liveTool, messages}`。`messages` 按流水展示用户输入、工具 arguments.reason、最终 output，以及正在执行（`live:true`）和排队工具的状态；原始 content 和工具 return 不作为助手回复 |
| GET | `/conversations` | 无 | `{items:[{conversationId, updatedAt, status, preview}]}`。当前 `session.json` 指向的排第一，其余按 `updatedAt` 新到旧。空会话 preview 是「新会话」 |
| POST | `/conversations/open` | `{conversationId}` | 该会话投影，并写入 `session.json` |
| POST | `/conversations/new` | 无 | 新建空 `cv_`，写入 `session.json`，回空投影 |
| POST | `/conversations/delete` | `{conversationId}` | 删掉该会话目录。若删的是当前会话，切到最近一条或新建 |
| GET | `/tool-request` | 无 | `{request}`，没有就 `request=null`。`request` 是 `{id, name, input}` |
| POST | `/tool-result` | `{id, result}` | `{ok:true}` |

`output` 见「output」。整轮收口再回一次。面板读 `/session`：工具 arguments.reason 作为唯一过程说明，Turn.output 作为助手回复；工具原始 return 不显示。`pendingAsk.choice` 取最近一次 `askUser` 的 `choice`。`/turn` 仍不带 id，用当前 `session.json`。

## 落盘文件

运行时数据在服务数据目录（绝对路径，默认为用户主目录下 `Library/Application Support/tChrome`，可用环境变量 `TCHROME_DATA` 覆盖；模型侧由 System `<overview>` 注入该绝对路径）：

```text
session.json
conversations/<cvId>/ledger.json
conversations/<cvId>/events.jsonl
conversations/<cvId>/events.NN.jsonl
conversations/<cvId>/provider.md
conversations/<cvId>/provider.NN.md
conversations/<cvId>/provider-system.md
conversations/<cvId>/turns/<turnId>.json
conversations/<cvId>/memory/<memoryId>.json
conversations/<cvId>/context-records/<kind>/<id>.json
conversations/<cvId>/context-records/pageObservation/<id>.txt
conversations/<cvId>/compression/<module>/index.json
conversations/<cvId>/compression/<module>/records/<id>.json
conversations/<cvId>/compression/<module>/sources/<id>.json
conversations/<cvId>/returns/<callId>.txt
```

JSON 快照覆盖写。流水只追加，不改已经写下的行。`returns/<callId>.txt` 与 `context-records/pageObservation/<id>.txt` 为超量结果的检索正文，按默认 100 字/行拆行；对应 externalized 摘要返回 totalLines/lineWidth，evidence.search 支持 keyword 或只传 startLine（约 400 字窗口）。

记录 ID 规则统一见 `service/identity/catalog.json`；System `<recordIdentity>` 的编号规则表和 User 数据校验从同一清单生成。表格展示类型、示例和范围，配套规则要求原样引用已有 ID，各类型在所属范围独立递增、允许空号，不跨类型或范围比较编号。模块 JSON 契约见 `service/context/data-schema.json`，字段速查见 `service/context/DATA.md`。

## events.jsonl

每次数据产生追加一行，不覆盖。一行一个 JSON 对象。单文件超过 3MB 时，先改名为 `events.NN.jsonl`（NN 自增），再开新的 `events.jsonl`。`loadEvents` 按 `events.01.jsonl`…再到 `events.jsonl` 的顺序读取全部行。

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
`kind=compress` 的 data 为 beforeChars、afterChars；compress-start 记录压缩前 windowChars，compress-error 记录失败 detail。每次发送主模型前，Runtime 检测 System + User 文本长度；达到 200,000 字符才触发压缩。按 turnId 汇集当轮输入、目标变化、工具调用与完整返回、页面观察、会话记忆写入、查询历史和最终输出，所有已结束轮次均可归档，当前轮次按完整工具批次处理。较早轮次可批量提交，但每轮分别生成 tag、userRequest、actions、result，追加到 conversationHistorySummary。若归档较早轮次后仍达到阈值，再归档当前轮次较早的执行片段，保留最近 2 个完整工具批次。当前输入、目标、当前页面、notes、长期记忆和 currentQuery 以正文或文件引用保持可见；currentQuery 计入总窗口但不参与压缩，queryHistory 作为取证参考，结论合入 result。摘要保持每轮独立。
`kind=turn-output` 的 `data`：`output`。
`kind=session` 的 `data`：`conversationId`，可选 `action`=`new`/`open`。

## provider.md / provider-system.md

每次出网追加一节到当前 `provider.md`。单个 `provider.md` 超过 3MB 时，先改名为 `provider.NN.md`（NN 自增），再开新的 `provider.md`。`loadProviderLog` 按 `provider.01.md`…再到 `provider.md` 的顺序读取全部节。

主日志只记录 **user 窗口** 与模型返回，不再每条抄写 system。system 全文写入 `provider-system.md`：按正文 sha256 前 16 位分块，`## system <hash>` 首次出现或哈希变化时各记一次；exchange 的 json 围栏用 `systemHash` 引用。

标题 `## tn_01 / 1`。json 围栏只放元数据。user / content / tool_calls 小节用普通围栏，正文真换行。

| 字段 | 怎么填 |
|---|---|
| 标题 `## tn_ / outbound` | 本 Turn 第几次出网 |
| json 围栏 | 元数据：`at` `systemHash` `toolIds` `finish` `toolCalls` `faultCode` |
| `### user` | 发给模型的 User 窗口，真换行 |
| `### content` | 模型 content，真换行 |
| `### tool_calls` | 模型交的工具，一行一个 |
| `provider-system.md` | 每个 `systemHash` 对应一份 System 全文 |

`events.jsonl` 的 `provider-request` / `provider-response` 仍只记元数据。User 全文看 `provider.md`，System 全文看 `provider-system.md`。

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
| `userInputHistory` | object[] | 上一轮及更早的输入，按旧到新排列。每项 `{id, turnId, userInput, submittedAt}`；新会话 `[]`。当前输入进入历史时保留原 ID |
| `goals` | object[] | 全部目标的最新记录 `{id, parentId, status, turnId, goal, sourceCallId, createdAt, updatedAt}`；总目标 `goal_01`、子目标 `subgoal_01` 分别持久自增。parentId 为 null 或所属总目标 ID，status 为 active/completed/cancelled；更新保留 ID。新会话 `[]` |
| `currentGoalId` | string \| null | 当前选择的 active 目标。`<goal>` 展示此指针、全部 active 目标及所需父级；`<goalHistory>` 展示已结束目标。新会话 null |
| `toolQueue` | object[] | 本 Turn 待执行的工具。模型一次出网交的 `toolCalls` 按数组顺序入队。任务队列按这个顺序跑。跑完一条弹出，写入 `toolIO`。新会话 / 新出网前空。每项 `{callId, name, arguments}` |
| `liveTool` | object \| null | 正在跑的那条 `{name, callId}`。空闲 / 追问 / 失败为 `null` |
| `toolIO` | object[] | 本会话完整工具记录，按执行顺序追加。本地始终保留；模型窗口按压缩目录 coveredSourceIds 过滤已覆盖记录 |
| `currentQuery` | object \| null | 最近一次查询，含 queryId、发起 turnId、sumId、module、intent、status、records，可含错误详情；计入窗口但不压缩 |
| `queryHistory` | object[] | 被后续查询或新 Turn 替换的查询，保留发起 turnId；按独立查询来源归档，结论合入轮次 result |
| `notes` | object | 模型自管的 key/value。新会话 `{}`。`notes.write` 写入或覆盖 `notes[key]`。`notes.delete` 删除 `notes[key]`。进 user `<notes>` |
| `windowChars` | number | 本轮出网窗口已用字符数。开 Turn 装配后、以及本 Turn 每次出网前，Runtime 写入 |
| `compressAt` | number | 压缩门槛，固定 `200000` |

统一在发送前按原始 System + User 文本执行 `200000` 字符压缩检查；压缩后仍超过 `250000` 字符，优先外置 notes，必要时继续外置其他模块或数组大记录，完整存入 `TCHROME_DATA/context-files/`，模型使用 `{contextFile:{path,chars,format}}` 引用，原记录保留；格式见 `service/context/data-schema.json`。压缩按原始视图触发，`windowChars` 记录文件引用替换后的实际发送文本。固定内容无法满足预算时返回 `context_limit`，文件保存失败返回 `context_storage_failed`，详细原因记录在 `context-budget-error` 事件。
| `memoryIds` | object | `{conversation, project}`，各是 string[] |

## turns/<turnId>.json

用户一轮对话。用户一条输入开一个 Turn。本 Turn 内可多次出网。

| 字段 | 类型 | 怎么填 |
|---|---|---|
| `turnId` | string | `tn_` |
| `conversationId` | string | `cv_` |
| `status` | string | `assembling` → `inferring` → `completed` / `waiting_human` / `failed`。工具循环时停在 `inferring` |
| `createdAt` | string | ISO-8601 |
| `completedAt` | string \| null | 收口时写；进行中 `null` |
| `input.id` | string | 创建输入时生成并持久保存的 `input_01`；不从 turnId 推导，后续渲染和进入历史沿用此 ID |
| `input.text` | string | 本轮用户原话。用户下一条输入才开新 Turn |
| `input.submittedAt` | string | 面板提交时间，ISO-8601 |
| `goalChanges` | object[] | 本轮每次 submitGoal 更新后的目标快照，按调用顺序保留；同一目标可多次出现，sourceCallId 区分变更，供归档和历史查询使用 |
| `assembled` | object | 这一轮点名的 catalog IDs + 标签快照与页面观察，见「assembled」 |
| `output` | object | 见「output」 |
| `usage` | object，可选 | 新 Turn 分别记录 `modelRequests` 与 `toolCalls`。工具批次逐个计数，包含常驻与收口工具；未通过校验而未执行的调用不计入。旧 Turn 可缺省。统计不作为累计 20 次的停止条件。 |

### assembled

| 字段 | 类型 | 怎么填 |
|---|---|---|
| `baseToolsIds` | string[] | 常驻工具，对应 `service/tools/definitions/<id>.json`；完整名单以 `service/tools/definitions/groups.json` 为准，能力导航进入 System `<baseTools>`，完整 schema 和说明进入出网 tools[] |
| `toolIds` | string[] | 动态工具，对应 `service/tools/definitions/<id>.json`。开 Turn 先挂 core（`page.get_summary` `page.list_regions` `page.list_interactive_elements` `page.click` `page.type` `open_url` `web_search` `list_browser_tools` `catalog.add`）。缺了 `catalog.add` 再补。能力导航进入 User `<tools>`，窗口压缩保持已加载工具不变 |
| `conversationMemoryIds` | string[] | 这一次会话记忆；没有就 `[]` |
| `projectMemoryIds` | string[] | 项目记忆；没有就 `[]` |
| `mcpIds` | string[] | 本轮 MCP；没有就 `[]` |
| `openTabs` | object | 每次请求主模型前刷新；成功为 `{ok:true, windows:[{windowId, focused, tabs:[{tabId, url, title, active}]}]}`，失败为 `{ok:false, error}`；注入 `<openTabs>` |
| `currentPage` | object \| null | 内部保存最近实际页面观察，初始 null，由有效页面工具返回更新；不再单独注入插槽 |
| `pageObservedHistory` | object[] | 页面观察统一数组，初始 `[]`，按旧到新追加。每条：id、turnId、callId、batchId?、tabId、type（工具名）、result（完整返回）；存储另含 observedAt。注入 `<pageObservedHistory>` 时保留完整 result |

`currentPage`：

| 字段 | 类型 | 怎么填 |
|---|---|---|
| `description` | string | 这块环境是什么 |
| `tabId` | number | Chrome tabId，≥ 1 |
| `url` | string | 当前页 URL |
| `title` | string | 当前页标题 |

### output

`kind`：`tool` / `ask` / `reply` / `error`。

- `tool` → `{kind, name, callId}`（动态工具 / `context.query` / `memory.write`）
- `ask` → `{kind, question}`（`askUser`）
- `reply` → `{kind, text}`（`finishTurn`，`text` 取 finishTurn.arguments.text；不回退到 content 或 reason）
- `error` → `{kind, faultCode, causeCode?, toolName?, detail?}`；压缩失败保留顶层 compression_failed，causeCode 标识底层原因

## memory/<memoryId>.json

两层：project 是跨会话共享的长期记忆；conversation 保存本会话的过程发现和已确认事实。conversation 在本地按会话保存，跨轮读取，新会话不继承，删除会话时一起删除；project 独立于会话保存，删除来源会话不影响长期记忆。notes 保存本会话的草稿、候选和中间材料，按 key 覆盖或删除，不在每轮自动清空。模型调 `memory.write` 提交。Runtime 落盘，会话记忆 ID 挂到 ledger.`memoryIds.conversation`，长期记忆从共享目录读取。下一次出网投影为对象数组，保留 memoryId、turnId、sourceCallId、sourceConversationId（存在时）和完整 text。

Memory 投影保持全部可见原文。会话记忆根据来源 turnId 随轮次归档，覆盖关系由 runtime 管理；会话记忆随对应来源归档，长期记忆不参与压缩。

| 字段 | 类型 | 怎么填 |
|---|---|---|
| `memoryId` | string | `mm_` |
| `layer` | string | `conversation` / `project` |
| `text` | string | 原文 |
| `createdAt` | string | ISO-8601 |
| `turnId` | string | 写入这条记忆时的轮次，由 runtime 自动记录；表示来源，不改变记忆层级 |
| `sourceCallId` | string | 写下这条的 `memory.write` 的 `callId` |

## context-records/<kind>/<id>.json

用户输入和页面观察以稳定 ID 写入本会话独立记录，kind 为 userInput、pageObservation。目标最新状态统一保存在 Ledger.goals，读取 kind=goal 时按 ID 从账本查找；不另存目标文件。窗口变化和压缩不修改原记录。主模型用目标 ID 更新、选择目标，用 parentId 关联子目标。

- 用户输入：`{id: "input_01", turnId, userInput, submittedAt}`，当前 `#userInput` 和对应历史项共用 ID。
- 目标：`{id, parentId, status, turnId, goal, sourceCallId, createdAt, updatedAt}`，按稳定 ID 查询取得最新状态；历史变更快照保存在 Turn.goalChanges，按归档 goalChanges 回查。
- 页面观察：`{id, turnId, tabId, url, title, description, observedAt, callId, toolName}`，当前页和对应历史项共用观察 ID。
- 记忆继续使用 memory 文件及 memoryId，注入模型时仅显示原文。

conversationHistorySummary 显示当前有效摘要的 {sumId, turnId, tag, userRequest, actions, result}；sumId 用于查询入口，来源关系保存在本地归档。

## compression/conversationHistory/

这是运行数据目录，由 `service/context-archive/` 管理，路径保持不变。`service/agents/compression/` 和 `service/agents/query/` 分别负责摘要生成与目录语义匹配，各自的 `protocol.ts` 管理提示词组装与 返回工具参数校验，`index.ts` 管理业务流程。二者直接复用现有无状态 `provider.complete`，不另建 LLM 请求层。

唯一查询和归档模块为 conversationHistory，目录包含：

| 文件 | 内容 |
|---|---|
| `index.json` | {version, module, entries, activeIds, coveredSourceIds}，目录是提交点 |
| `source-ids.json` | 原始轮次、批次、查询的内部逻辑键到 `src_01` 短编号的持久映射；仅选中归档材料时从会话计数器分配，重复检查不分配新号 |
| `records/<id>.json` | {id, module, level, tag, turnId, userRequest, actions, result, sourceIds, createdAt}，每次压缩追加不可变记录 |
| `sources/<id>.json` | {id, content}，完整原始内容，工具使用完整落盘结果 |

每条摘要关联一个真实 turnId 和对应原始轮次或执行片段来源 ID，同批次的不同轮次分别保存。level 是记录结构字段，不触发额外的分层合并。activeIds 保存窗口当前摘要，coveredSourceIds 记录已归档覆盖的来源。runtime 按来源内容过滤发送视图，不清除账本原文。查询展开来源、去重并保持原顺序。

每次发送主模型前，Runtime 检测 System + User 文本长度；达到 200,000 字符才触发压缩。按 turnId 汇集当轮输入、目标变化、工具调用与完整返回、页面观察、会话记忆写入、查询历史和最终输出，所有已结束轮次均可归档，当前轮次按完整工具批次处理。较早轮次可批量提交，但每轮分别生成 tag、userRequest、actions、result，追加到 conversationHistorySummary。若归档较早轮次后仍达到阈值，再归档当前轮次较早的执行片段，保留最近 2 个完整工具批次。当前输入、目标、当前页面、notes、长期记忆和 currentQuery 以正文或文件引用保持可见；currentQuery 计入总窗口但不参与压缩，queryHistory 作为取证参考，结论合入 result。摘要保持每轮独立。

模型输出校验成功、完整来源与摘要落盘后，才原子更新目录索引和覆盖关系。失败或取消不提交该批次覆盖，原文继续可用；此前成功提交的归档保留。索引是提交点，中断可能留下未被索引引用的文件。窗口按来源覆盖过滤历史输入、已结束目标、页面观察、会话记忆写入和工具记录，本地原文不删除。

## 窗口模块

用户一条输入开一个 Turn，CE 装配一次。本 Turn 内工具循环不再走 CE。

加载顺序由 `service/context/modules.json` 决定。每个模块是一份 XML 文件，含 `<id>`、能力、详细描述；User 模块另含独立的 `内容：` 段，通过 `{{data}}` 注入运行数据。System 与 User 窗口都渲染完整 XML 模块。

加载器返回 systemOrder / userOrder，systemSlots / userSlots 保存模块元数据与对应正文。阶段 JSON 中 systemSlots / userSlots 是对应的 10 / 16 个内部 `#id` 名数组，并非模块对象。

system 的 runtime 管装配预算、压缩外置与图片附件，execution 聚焦推进流程，toolProtocol 管调用/返回协议，boundaries 管授权和证据来源。网页方法维护于 `service/skills/web-observation/SKILL.md`，runtime 按 `service/skills/index.json` 加载后作为数据注入 `<skill>`，模块描述仍由 `service/context/user/skill.md` 提供。User 模块投影保留记录 ID、轮次与来源关联和完整内容；工具 schema 以 definitions 为准。

System `<baseTools>` 展示常驻能力导航，User `<tools>` 展示本会话已加载的动态能力导航；每项由工具名和 function.description 首句生成，完整调用说明与参数 schema 通过 tools[] 发送，唯一来源仍是 `service/tools/definitions/<id>.json` 的 function.description。调整模块后同步生成导航、装配测试与阶段示例。

出网 `tools[]` = `baseToolsIds` + `toolIds` 的 catalog schema。

## toolIO 项 / toolQueue 项

| 字段 | 类型 | 怎么填 |
|---|---|---|
| `callId` | string | `call_`。模型 `tool_calls[].id` |
| `name` | string | 工具名，必须在 `baseToolsIds` + `toolIds` |
| `turnId` | string | 这条工具属于哪一轮。`GET /session` 按这个把过程挂到对话里 |
| `batchId` | string，可选 | 一次模型响应的工具批次标识；压缩保留最近两个批次，缺省时按 turnId 分组 |
| `arguments` | object | 已 parse。每个工具都有 `reason` `affectsPage`，其余按 catalog `required` |
| `return` | object | 队列跑完才有。`{stage, totalChars, text}` |

`return`：

| 字段 | 类型 | 怎么填 |
|---|---|---|
| `stage` | string | 当前运行记录使用 complete 并保留完整返回；字段表示文本完整度，不证明操作成功。context.query 仅返回查询状态和来源引用，证据放入 currentQuery |
| `totalChars` | number | 全文长度（JavaScript string.length，UTF-16 代码单元） |
| `text` | string | 完整工具返回正文；context.query 不在此重复原文 |

`askUser` 的 `text` 是根据 arguments.question 和选项生成的工具返回文本。`finishTurn` 的 `text` 是回复用户的正文（仅取 finishTurn.arguments.text，不使用 content 回退）。动态工具的 `text` 是工具正文；`context.query` 的 `text` 仅含状态和引用。`memory.write` 的 `text` 是落下的层和条数。

常驻 `context.query(sumId, module, intent)` 从指定摘要的来源中查询一个模块。模块为 userInput、goalChanges、toolIO、pageObservations、memoryWrites、output、queryHistory 或 summaries。Runtime 装配候选原文，Query Agent 通过 submitMatches 返回命中的 turnIds，Runtime 校验后将完整 records 放入 currentQuery；`<toolIO>` 只投影 currentQuery 指针。查询结果与其它工具返回共用统一内联门禁（默认 4000 字符），超出时注入 externalized 摘要（preview+path+totalLines/lineWidth）；本地全文按默认 100 字/行拆行，可用 evidence.search 按 keyword 或只传 startLine（约 400 字窗口）检索。查询不会刷新页面。

工具窗口投影使用 {callId, turnId, batchId?, name, arguments, return: {stage, result}}，arguments 隐藏 affectsPage，保留 reason 与操作参数。result 对合法 JSON 解析一次，普通文本和截断文本保持原样。callId 标识调用，turnId 标识所属轮次，batchId 标识工具批次；totalChars 不注入主模型，操作用 tabId、控件引用及错误详情仍保留。与 pageObservedHistory 中同一 turnId+callId 的观察对应时，return.result 只保留 {ok, pageObservationId}，完整观察结果只出现在 `<pageObservedHistory>`；本地原始返回保持完整。

## 阶段快照

`docs/examples/` 每份「写出的」是累积快照：前面已有的键原样带上，本环节改 `stage` 并追加键。字段声明只在本文件。

| `stage` | 文件 | 本环节追加 / 改写 |
|---|---|---|
| `normalize` | 01 | `conversationId` `turnId` `userInput` `userInputHistory` `submittedAt` |
| `context-engineering-input` | 02 | assembled 那组 ID + `openTabs` 与实际页面观察 |
| `context-engineering-decode` | 03 | `systemSlots` `userSlots` |
| `provider-request` | 04 | `provider` `model` `stream` `maxAttempts` |
| `provider-response` | 05 | `finish` `content` `toolCalls` `attempts` `parseOk` `schemaOk` `faultCode` `missing` |
| `tool-execute` | 06 | `toolQueue` `toolIO` |
| `compress` | 07 | 按轮次更新压缩目录及覆盖关系，重新计算 windowChars；本地 ledger 原文保持完整 |
| `finish-turn` | 08 | 同一 Turn 再出网的 `finish` `content` `toolCalls`；`toolIO` 追加 `finishTurn` |

面板入口只有 `userInput` `submittedAt`。其余键 Runtime 写。

`provider`：`uuapi`。`model`：`gemini-3.7-flash`。`stream`：`false`。`maxAttempts`：`3`。

`finish`：`tool_calls` / `stop` / `error`。`content`：Provider 返回的可选文本，保留供日志检查；过程展示仅使用工具 arguments.reason，最终输出仅使用 finishTurn.arguments.text 或 askUser.arguments.question。`toolCalls`：`{id, name, arguments}`，已 parse。

`faultCode`：

| 值 | 何时 |
|---|---|
| `arguments_not_json` | `function.arguments` 解析失败。对象原样用；字符串经**全 Provider 共用**外壳拯救后再 `JSON.parse`（围栏、尾逗号、结构单引号只修外壳）。不补字段。格式/schema 错误回灌给模型自救，最多 3 次；好的 `toolCalls` 照跑，坏的写进 `<toolIO>`。压缩/查询 Agent 同样最多 3 次格式自救；传输层故障不循环 |
| `unknown_tool` | `name` 不在 `baseToolsIds` + `toolIds` |
| `missing_required` | catalog `required` 缺或空。`missing` 列出字段名，写进 `<toolIO>` 再出网。不补字段。同一 Turn 最多 3 次 |
| `wrong_type` | Ajv：类型对不上 schema。写进 `<toolIO>` 再出网。同一 Turn 最多 3 次 |
| `exclusive_resident` | 同一次出网里 `finishTurn` / `askUser` 不在最后一条。写进 `<toolIO>` 再出网 |
| `need_finish_turn` | `finish=stop` 且 `tool_calls` 为空，连续 3 次。每次先写 `shared/error-messages.json` 的 `need_finish_turn` 进 `<toolIO>` 再出网 |

Ajv 只验 `tool_calls[].arguments`，不验 `content`。

## 工具参数

每个工具 `arguments` 都有 `reason`（string）和 `affectsPage`（boolean）。其余按 `service/tools/definitions/<id>.json`。动态工具分类在 `service/tools/definitions/index.json`；用法只维护在每个工具定义的 function.description。

| 工具 | required 其余 | 谁填其余 |
|---|---|---|
| `askUser` | `question`、`choice` | 非空问题正文与选项 |
| `submitGoal` | 创建时 `goal`；更新时 `id` | 创建子目标时传 parentId；创建默认 active。按 id 更新正文、状态或选中 active 目标，parentId 创建后不变。关闭当前目标时转回 active 父目标，否则清空当前选择；不自动关闭其他目标，也不级联修改子目标 |
| `finishTurn` | `text` | 非空回复正文，不依赖 content |
| `context.query` | `sumId` `module` `intent` | 查询 Agent 选择来源轮次，Runtime 将完整 records 写入 currentQuery；超长走统一 4000 门禁 |
| `capture_page` | `mode`；element 另需 ref/selector 二选一 | `viewport` / `full_page` / `element`；元素定位不混用 page.* 的 id，PDF 使用 `save_pdf` |
| `probe_http` | `url` | HTTP(S) 网址，可选 `method=GET/HEAD`；返回状态、耗时、最终网址和响应头，`reachable=true` 表示收到 HTTP 响应（包括 4xx/5xx），`ok=true` 表示 2xx |
| `notes.write` | `key` `value` | 写入或覆盖 `ledger.notes[key]`。模型自定 key |
| `notes.delete` | `key` | 删除 `ledger.notes[key]` |
| `memory.write` | （无） | `conversationMemory` `projectMemory` 有则写 |
| `catalog.add` | `names` | 把缺的动态工具挂进本轮 |

常驻与初始动态工具名单以 `service/tools/definitions/groups.json` 的 baseToolsIds / coreToolIds 为准。动态目录分类见 `service/tools/definitions/index.json`，缺能力通过 catalog.add 加载。浏览器工具经 `/tool-request` 泵到 background。

没迁、原因：

| 工具 | 原因 |
|---|---|
| Planner / Task / Review / Memory / Compress / Evolve 岗工具（`submit_plan` `submit_split` `ask_choice` `continue_task` `stop` `use_skill` …） | tChrome 单 Agent，没有这套岗 |
| `native_host` `port_scan` `dns_enum` `proxy_chain` `code_runner` `use_host` `local_workspace` `project_storage` | 没有 Native Messaging / 本机宿主 |
| `request_tool_service` `request_memory_service` | 挂在岗流水线上，tChrome 没有对应岗 |

`api_discover` / `api_manage` 迁了 schema 和执行入口，登记表第一期空数组。

运行提示独立维护在 `shared/error-messages.json`，由运行层按需写入工具记录。

## 实现职责

工具 schema、分类和分组由 `service/tools/registry.ts` 读取同模块的 `service/tools/definitions/`。Provider 负责模型通信、传输重试及响应/参数解析；主 Agent 的 provider 返回由 `service/runtime/loop.ts` 的 `validateCompletion` 调用 `service/tools/schema.ts` 统一检查 schema、工具名和收口顺序，Runtime 根据结果推进状态。Context 接收数据与能力导航，生成窗口投影；完整工具说明通过 tools[] 发送。`service/presentation/session-view.ts` 以纯函数生成 UI 消息和会话列表；store 负责读取记录、持久化和会话命令。

查询状态保存 currentQuery 与 queryHistory。下一次查询结果或新 Turn 将当前查询迁入历史，保留原发起 turnId；取消不替换。查询历史作为独立来源补入对应轮次，避免原调用批次已归档后漏收。查询结果走统一 4000 内联门禁；超出时注入 externalized 摘要。

ledger.loadedToolIds 保存本会话通过 catalog.add 成功加载的工具名。Turn 的 assembled.toolIds 是本轮执行快照，初始来自默认工具与会话清单，加载成功时两者同时更新。
