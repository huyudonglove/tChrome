# 数据

会话账本 + 记录。扩展不直连 UUAPI，请求走本机 Bun 服务 `127.0.0.1:18788`。密钥只在服务端 `.env`。

## 目录

```text
ledger.json
turns/<turnId>.json
observations/<observationId>.json
memory/<memoryId>.json
```

前缀：`cv_` 会话 · `tn_` 回合 · `ob_` 观察 · `mm_` 记忆。

## ledger.json

Runtime 独占维护。当前会话指针。

```json
{
  "schemaVersion": 1,
  "conversationId": "cv_01",
  "createdAt": "2026-09-05T08:00:00.000Z",
  "updatedAt": "2026-09-05T08:00:08.000Z",
  "status": "running",
  "active": {
    "turnId": "tn_01"
  },
  "pendingAsk": null,
  "turnIds": ["tn_01"],
  "userInputHistory": [],
  "observationIds": [],
  "memoryIds": {
    "turn": [],
    "conversation": [],
    "project": []
  }
}
```

| 字段 | 怎么填 |
|---|---|
| `status` | `idle` 无活动回合 / `running` 在转 / `waiting_human` 冻在追问 / `paused` / `failed` |
| `active` | 当前 `turnId`；没有就 `null` |
| `pendingAsk` | `waiting_human` 时：`{turnId, question}`；否则 `null` |
| `turnIds` | 已建的回合，按时间 |
| `userInputHistory` | 已结束回合的用户原话，按时间。新会话 `[]`。turn 结束时 Runtime 把本轮 `userInput` 追加进去 |
| `observationIds` | 工具结果写下的观察 |
| `memoryIds` | 三层记忆 ID |

## Turn

一次出网。装配 → 推理 → 工具或回复。

```json
{
  "turnId": "tn_01",
  "conversationId": "cv_01",
  "status": "completed",
  "createdAt": "2026-09-05T08:00:01.000Z",
  "completedAt": "2026-09-05T08:00:08.000Z",
  "input": {
    "text": "帮我查这款鼠标官网价",
    "submittedAt": "2026-09-05T08:00:01.000Z"
  },
  "assembled": {
    "systemIds": ["pack.agent"],
    "skillIds": ["skill.web"],
    "sopIds": ["sop.browse"],
    "baseToolsIds": ["askUser", "finishTurn", "tool.detail"],
    "toolIds": ["web.search"],
    "turnMemoryIds": [],
    "conversationMemoryIds": [],
    "projectMemoryIds": [],
    "mcpIds": [],
    "currentPage": {
      "description": "当前页面信息",
      "tab": 12,
      "url": "https://item.jd.com/100012345678.html",
      "title": "罗技 MX Master 3S 无线鼠标"
    }
  },
  "output": {
    "kind": "tool",
    "name": "web.search",
    "callId": "call_01"
  }
}
```

| 字段 | 怎么填 |
|---|---|
| `status` | `assembling` → `inferring` → `completed` / `waiting_human` / `failed` |
| `input.text` | 本轮用户原话；续问时是人审答复 |
| `assembled` | 这一轮点名的 catalog IDs + 当前页 |
| `output.kind` | `tool` / `ask` / `reply` / `error` |

`output`：

- `tool` → `{kind, name, callId}`（动态工具 / `tool.detail`）
- `ask` → `{kind, question}`（`askUser`）
- `reply` → `{kind, text}`（`finishTurn`，`text` 取 content 的 action）
- `error` → `{kind, faultCode}`

## Observation

工具跑完写下的事实。窗口里给模型看的是 `#toolIO` 对应条目的 `return`（最多 2000 字）。全文另存，`tool.detail` 按 `callId` 取。

```json
{
  "observationId": "ob_01",
  "conversationId": "cv_01",
  "turnId": "tn_01",
  "callId": "call_01",
  "source": "tool",
  "toolName": "web.search",
  "text": "罗技官网 MX Master 3S 标价 999 元",
  "stage": "complete",
  "totalChars": 22,
  "createdAt": "2026-09-05T08:00:12.000Z"
}
```

`source`：`tool` / `user` / `page`。

`stage`：`complete` 全文 ≤ 2000 字；`truncated` 超出，`text` 只留前 2000 字，`totalChars` 写全文长度。

## Memory

三层，从稳到新：project → conversation → turn。正文在 `catalog` 之外，按 ID 挂到 user 槽。

## 装配

每轮同一套：system Pack + 本会话 `skillIds` / `toolIds` / `sopIds` / `mcpIds` + user 记忆槽 + `#userInputHistory` + `#userInput` + `#currentEnvironment` + `#toolIO`。

user 文档块：

```text
#projectMemory
#conversationMemory
#turnMemory
#contextSummary
#userInputHistory
#userInput
#currentEnvironment
#toolIO
#tools
```

常驻工具 `askUser` / `finishTurn` / `tool.detail` 的用法在 Pack（system）。动态工具用法在 user `#tools`。出网 `tools[]` = `baseToolsIds` + `toolIds` 的 catalog schema。每个工具 `arguments` 都带 `reason`。

`#toolIO` 是 object，key = `callId`，value = `{name, arguments, return}`。`return.text` 最多 2000 字；超出 `return.stage=truncated`，`return.totalChars` 写全文长度。要全文调 `tool.detail`，参数 `callId`。

## 循环

1. 用户一句话 → 新 Turn。装配时从 ledger 读 `userInputHistory`（不含本轮），`#toolIO` 带上本会话已执行过的工具条目。CE 装配，LLM 交 `askUser`、`finishTurn`、`tool.detail` 或动态工具。
2. `askUser` → 本轮 `userInput` 追加进 ledger.`userInputHistory`，ledger.`status=waiting_human`，等人答，答文写进下一 Turn `input`。
3. 动态工具 / `tool.detail` → 执行，写 Observation，把 `{name, arguments, return}` 写入 `#toolIO[callId]`（窗口截到 2000 字），新 Turn 再出网。`userInputHistory` 在用户这句话第一次结束时追加一次。
4. `finishTurn` → 回复用户。Runtime 把本句 `userInput` 写入 `userInputHistory`（每句一次）。ledger.`status=idle`，`active=null`。

分阶段模拟：`docs/examples/01-normalize.md` → `02-context-engineering.md` → `03-decode.md` → `04-provider-request.md` → `05-provider-response.md` → `06-tool-execute.md`。
