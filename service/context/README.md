# 上下文模块

模块的**唯一注册表**是 [modules.json](modules.json)：顺序、XML 文件路径、给谁用（`consumers`）、是否进压缩（`compress` / `archiveField`）。主 Agent 的归档字段与压缩岗共用这张表。

三套 `modules.json` 各自独立、互不共用：主 Agent 在 `service/context/`，压缩 Agent 在 `service/agents/compression/context/`，查询 Agent 在 `service/agents/query/context/`。改哪一岗就改哪一份，不要把字段从一份复制到另一份。

目录内的 [README.md](README.md) 与 [DATA.md](DATA.md) 是维护文档，不进注册表、不注入模型窗口。

| 入口 | 职责 |
|---|---|
| [modules.json](modules.json) | 注册表：id、role、order、file、consumers、compress、archiveField |
| [system/overview.md](system/overview.md) | `<overview>`：Agent loop、装配顺序、模块粗览与日期 |
| [system/](system/) | 主 Agent System 模块 XML 正文 |
| [user/](user/) | 主 Agent User 模块 XML 正文 + `{{data}}` |
| [modules.ts](modules.ts) | 按注册表加载/渲染 XML；生成压缩字段说明 |
| [window.ts](window.ts) | 拼装主 Agent System/User（仅 `consumers∋main`） |
| [projections/](projections/) | 模块字段投影 |
| [../agents/compression/context/](../agents/compression/context/) | **压缩 Agent 独立分层**：`modules.json` + `system/*.md`；User 为 `<compressionTurns>` 内 JSON 数据 |
| [../agents/query/context/](../agents/query/context/) | **查询 Agent 独立分层**：`modules.json` + `system/*.md`；User 为 `<queryTurns>` 内 JSON 数据 |

## 模块总表（与 modules.json 对应）

测试 `modules-registry.test.ts` 校验本表 System/User id 与注册表一致，以及各岗 `overview.md` 模块粗览标签集合。

### System · 主 Agent（`consumers: main`）

| order | id | 文件 | 能力 |
|---:|---|---|---|
| 1 | overview | system/overview.md | Agent Loop, Context Assembly |
| 2 | identity | system/identity.md | Identity, Collaboration, Language |
| 3 | environment | system/environment.md | Environment, Tool Discovery |
| 4 | runtime | system/runtime.md | Context Assembly, Compression, Images |
| 5 | recordIdentity | system/recordIdentity.md | ID Rules, Record References |
| 6 | execution | system/execution.md | Task Execution, Verification, Recovery |
| 7 | toolProtocol | system/toolProtocol.md | Tool Calls, Parameters, Execution Order |
| 8 | boundaries | system/boundaries.md | Authorization, Reference Material |
| 9 | output | system/output.md | Responses, Action Reasons, Final Answer |
| 10 | baseTools | system/baseTools.md | Resident Tools, Task Management |
| 11 | systemSkill | system/systemSkill.md | System Skill Index |

### User · 主 Agent

| order | id | compress | 压缩归档字段 | coverage | consumers |
|---:|---|---|---|---|---|
| 1 | skill | 否 | — | — | main |
| 2 | userInput | 否 | — | — | main |
| 3 | conversationHistorySummary | 否（已是摘要） | — | — | main |
| 4 | userInputHistory | 是 | userInput | turn | main + compression |
| 5 | goal | 否 | — | — | main |
| 6 | goalHistory | 是 | goalChanges | sourceCallId | main + compression |
| 7 | openTabs | 否 | — | — | main |
| 8 | pageObservedHistory | 是 | pageObservations | callId | main + compression |
| 9 | projectMemory | 否 | — | — | main |
| 10 | conversationMemory | 是 | memoryWrites | sourceCallId | main + compression |
| 11 | notes | 否 | — | — | main |
| 12 | reflection | 是 | reflection | turn | main + compression |
| 13 | toolIO | 是 | toolIO | batch | main + compression |
| 14 | lastAction | 否 | — | — | main |
| 15 | checklist | 否 | — | — | main |
| 16 | queryHistory | 是 | queryHistory | queryId | main + compression |
| 17 | currentQuery | 否 | — | — | main |
| 18 | tools | 否 | — | — | main |

### Archive · 仅压缩

| id | compress | 归档字段 | 说明 |
|---|---|---|---|
| turnOutput | 是 | output | 仅 `consumers: compression`，无 User 窗口文件 |

压缩 Agent 提示词在 `service/agents/compression/context/`，字段列表由注册表 `compress=true` 生成注入，**不**把主 Agent 全套模块塞给压缩模型。

## 模型可见格式（B + XML）

System 模块：

```xml
<identity>
能力：【Identity, Collaboration, Language】

详细描述：
我是 Helm，中文名「驭舟」。…
</identity>
```

User 模块（含数据）：

```xml
<toolIO>
能力：【Execution Evidence, Error Details】

详细描述：
按旧到新排列的工具调用和返回。…

内容：
{{data}}
</toolIO>
```

## 加模块时改哪里

1. `modules.json`：加一项（`consumers` / `compress` / `archiveField`）  
2. `system/` 或 `user/`：对应 XML 正文文件  
3. `system/overview.md`（及压缩/查询岗各自的 overview）模块粗览：补一行 `- <id>：…`，与注册表 `consumers∋main`（或该岗）集合保持一致  
4. 需进压缩：同一 `archiveField` 要在 `service/runtime/turn-history.ts` 的 `projectors` 提供取数函数，并在 `modules.ts` 的 `DEFAULT_SEMANTICS`（或该项 `inputSemantics`）写清材料形状；缺 projector 时装配归档会抛错  
5. 压缩 Agent 岗措辞：只动 `agents/compression/context/`（字段说明由主注册表生成）  
6. 窗口投影：主 Agent User 槽位在 `context/projections/` 与 `window.ts`；与 turn-history 的 archiveField 是同一数据的两种视图
7. 数字阈值：`service/config/runtime.json` 的 `context` / `results`；System 用 `{{compressAt}}` 等占位，由 `modules.json` 的 `inject` 与 `prompt-numbers.ts` 注入
8. 本 README 模块总表与 `docs/prompt-hierarchy.md` 中的样例标签：保持与注册表一致（测试会校验）

共用措辞见 `templates.ts`；字段语义在 `modules.ts` 的 `DEFAULT_SEMANTICS`。

## 数据结构

User 槽位的数据契约仍见 [DATA.md](DATA.md) 与 `data-schema.json`（校验用不带 `#` 的模块名）。`skill` / `tools` 为文本，其余为 JSON。DATA.md 约束数据形状，不注入提示词。
