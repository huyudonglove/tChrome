# 上下文模块

模块的**唯一注册表**是 [modules.json](modules.json)：顺序、XML 文件路径、给谁用（`consumers`）、是否进压缩（`compress` / `archiveField`）。主 Agent 的归档字段与压缩岗共用这张表；查询岗另有 `service/agents/query/context/modules.json`。

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

### System · 主 Agent（`consumers: main`）

| order | id | 文件 | 能力 |
|---:|---|---|---|
| 1 | identity | system/identity.md | Identity, Collaboration, Language |
| 2 | environment | system/environment.md | Environment, Tool Discovery |
| 3 | runtime | system/runtime.md | Context Assembly, Compression, Images |
| 4 | recordIdentity | system/recordIdentity.md | ID Rules, Record References |
| 5 | execution | system/execution.md | Task Execution, Verification, Recovery |
| 6 | toolProtocol | system/toolProtocol.md | Tool Calls, Parameters, Execution Order |
| 7 | boundaries | system/boundaries.md | Authorization, Reference Material |
| 8 | output | system/output.md | Responses, Action Reasons, Final Answer |
| 9 | baseTools | system/baseTools.md | Resident Tools, Task Management |

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
| 12 | toolIO | 是 | toolIO | batch | main + compression |
| 13 | lastAction | 否 | — | — | main |
| 14 | checklist | 否 | — | — | main |
| 15 | queryHistory | 是 | queryHistory | queryId | main + compression |
| 16 | currentQuery | 否 | — | — | main |
| 17 | tools | 否 | — | — | main |

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

不再使用 `#tag` 编号清单。

## 加模块时改哪里

1. `modules.json`：加一项（`consumers` / `compress` / `archiveField`）  
2. `system/` 或 `user/`：对应 XML 正文文件  
3. 需进压缩：`service/runtime/turn-history.ts` 的 `projectors` 补取数函数  
4. 压缩措辞：只动 `agents/compression/context/`（字段说明自动来自注册表）

## 数据结构

User 槽位的数据契约仍见 [DATA.md](DATA.md) 与 `data-schema.json`（校验用不带 `#` 的模块名）。`skill` / `tools` 为文本，其余为 JSON。
