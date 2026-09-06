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
    "baseToolsIds": ["askUser"],
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

- `tool` → `{kind, name, callId}`
- `ask` → `{kind, question}`
- `reply` → `{kind, text}`
- `error` → `{kind, faultCode}`

## Observation

工具跑完写下的事实。

```json
{
  "observationId": "ob_01",
  "conversationId": "cv_01",
  "turnId": "tn_01",
  "source": "tool",
  "toolName": "web.search",
  "text": "罗技官网 MX Master 3S 标价 999 元",
  "createdAt": "2026-09-05T08:00:12.000Z"
}
```

`source`：`tool` / `user` / `page`。

## Memory

三层，从稳到新：project → conversation → turn。正文在 `catalog` 之外，按 ID 挂到 user 槽。

## 装配

每轮同一套：system Pack + 本会话 `skillIds` / `toolIds` / `sopIds` / `mcpIds` + user 记忆槽 + `#userInput` + `#currentEnvironment`。

user 文档块：

```text
#projectMemory
#conversationMemory
#turnMemory
#contextSummary
#userInput
#currentEnvironment
#tools
```

常驻工具 `askUser` 的用法在 Pack（system）。动态工具用法在 user `#tools`。出网 `tools[]` = `baseToolsIds` + `toolIds` 的 catalog schema。每个工具 `arguments` 都带 `reason`。

## 循环

1. 用户一句话 → 新 Turn，CE 装配，LLM 交 `askUser` 或动态工具，或 `finish=stop` 直接回复。
2. `askUser` → ledger.`status=waiting_human`，等人答，答文写进下一 Turn `input`。
3. 动态工具 → 执行，写 Observation，新 Turn 把观察带进窗口再出网。
4. `finish=stop` 无 `tool_calls` → 回复用户，ledger.`status=idle`，`active=null`。

分阶段模拟：`docs/examples/01-normalize.md` → `02-context-engineering.md` → `03-decode.md` → `04-provider-request.md` → `05-provider-response.md`。
