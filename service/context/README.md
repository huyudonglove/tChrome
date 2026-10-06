# 上下文模块

模块的**唯一注册表**是 [modules.json](modules.json)：顺序、XML 文件路径、给谁用（`consumers`）、是否进压缩（带 `archiveField` 即进）。主 Agent 的归档字段与压缩岗共用这张表。

三套 `modules.json` 各自独立、互不共用：主 Agent 在 `service/context/`，压缩 Agent 在 `service/agents/compression/context/`，查询 Agent 在 `service/agents/query/context/`。改哪一岗就改哪一份，不要把字段从一份复制到另一份。

目录内的 [README.md](README.md) 与 [DATA.md](DATA.md) 是维护文档，不进注册表、不注入模型窗口。

| 入口 | 职责 |
|---|---|
| [modules.json](modules.json) | 注册表：id、role、order、file、consumers、archiveField |
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

| order | id | 压缩归档字段 | consumers |
|---:|---|---|---|
| 1 | skill | — | main |
| 2 | projectMemory | — | main |
| 3 | tools | — | main |
| 4 | conversation | — | main |

`<conversation>` 内为会话级 `<ConverstionMemories>`、`<summary>`、`<task>` 与按 turnId 嵌套的 `<turn>` 轮次切片（标签属性 turnId / start / end；二级标签 userInput / calls / observations / workspaces / notes / reflections / queries / stopReason，详见 user/conversation.md）；各轮 `<calls>` 按 keepInCalls 展示调用详情（start/end 为该轮调用范围，kept 为可见条数，total 为该轮调用总数）；被压缩覆盖的轮次整块删除。

### Archive · 仅压缩

| id | 归档字段 | 说明 |
|---|---|---|
| userInput | userInput | 轮次用户输入 |
| workspace | workspace | 因果工作区条目（op/value，按批随轮归档） |
| toolIO | toolIO | 该轮完整调用参数与返回；窗口是否继续展示不影响归档 |
| observations | observations | 观察（页面/代码等） |
| memoryWrites | memoryWrites | 会话记忆写入 |
| reflection | reflection | 轮次反思 |
| queryHistory | queryHistory | 查询记录 |
| turnOutput | stopReason | 轮次收口 |

压缩 Agent 提示词在 `service/agents/compression/context/`，字段列表由注册表中带 `archiveField` 的条目生成注入，**不**把主 Agent 全套模块塞给压缩模型。

## 模型可见格式（XML）

每个模块以 `<purpose>` 包裹完整功能说明；含动态数据的模块在 `</purpose>` 后直接放数据正文。

System 模块：

```xml
<identity>
<purpose>
本模块定身份与协作方式——通晓底层的白盒工程搭档，用可验证事实说话，结构性摩擦当场记录。
我是 Helm，中文名「驭舟」。…
</purpose>
</identity>
```

User 模块（含数据）：

```xml
<conversation>
<purpose>
本模块是本会话过程记录——按 turn 嵌套原文与 calls，摘要和任务位于会话级。
本会话过程记录。…
</purpose>

<ConverstionMemories memoryId="mm_01" turnId="tn_01">…</ConverstionMemories>
<turn turnId="tn_01" start="call_01" end="call_12">
<userInput id="input_01">{"turnId":"tn_01","userInput":"…"}</userInput>
<calls start="call_01" end="call_12" kept="1" total="12">
<call callId="call_01" name="open_url">…</call>
</calls>
</turn>
</conversation>
```

## 加模块时改哪里

1. `modules.json`：加一项（`consumers` / `archiveField`）  
2. `system/` 或 `user/`：对应 XML 正文文件  
3. `system/overview.md`（及压缩/查询岗各自的 overview）模块粗览：补一行 `- <id>：…`，与注册表 `consumers∋main`（或该岗）集合保持一致  
4. 需进压缩：同一 `archiveField` 要在 `service/runtime/turn-history.ts` 的 `projectors` 提供取数函数，并在 `modules.ts` 的 `DEFAULT_SEMANTICS`（或该项 `inputSemantics`）写清材料形状；缺 projector 时装配归档会抛错  
5. 压缩 Agent 岗措辞：只动 `agents/compression/context/`（字段说明由主注册表生成）  
6. 窗口投影：主 Agent User 槽位在 `context/projections/` 与 `window.ts`；与 turn-history 的 archiveField 是同一数据的两种视图
7. 数字阈值：`service/config/runtime.json` 的 `context` / `results`；System 用 `{{compressAt}}` 等占位，由 `modules.json` 的 `inject` 与 `prompt-numbers.ts` 注入


共用措辞见 `templates.ts`；字段语义在 `modules.ts` 的 `DEFAULT_SEMANTICS`。

## 数据结构

User 槽位的数据契约仍见 [DATA.md](DATA.md) 与 `data-schema.json`（校验用不带 `#` 的模块名）。`skill` / `conversation` / `tools` 为文本，其余为 JSON。DATA.md 约束数据形状，不注入提示词。

调用可见性由统一可选参数 `keepInCalls` 决定：显式 true 保留至原有压缩覆盖；false 或未指定只在返回后的下一次模型请求展示一次。所有调用完整落盘并按来源轮次参与压缩，callId 全会话唯一，移出窗口后仍可回查。
