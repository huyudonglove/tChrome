# 数据

会话账本 + 记录。扩展不直连 UUAPI，请求走本机 Bun 服务 `127.0.0.1:18788`。密钥只在服务端 `.env`。

## 目录

```text
ledger.json
turns/<turnId>.json
memory/<memoryId>.json
```

前缀：`cv_` 会话 · `tn_` 回合 · `mm_` 记忆。

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
  "toolQueue": [],
  "toolIO": [],
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
| `userInputHistory` | 上一轮及更早的用户原话，按时间。新会话 `[]`。用户下一条输入开新 Turn 时，Runtime 把刚结束那一轮的 `userInput` 追加进去 |
| `toolQueue` | 本 Turn 待执行的工具队列。模型一次出网交的 `toolCalls` 按数组顺序入队。任务队列按这个顺序跑。跑完一条弹出，写入 `toolIO`。新会话 / 新出网前空 |
| `toolIO` | 本会话已执行的工具调用，数组。新会话 `[]`。队列里跑完一条追加一条，最新在最下面 |
| `memoryIds` | 三层记忆 ID |

## Turn

用户一轮对话。用户一条输入开一个 Turn。本 Turn 内可多次出网（工具循环还在这个 Turn 里）。

```json
{
  "turnId": "tn_01",
  "conversationId": "cv_01",
  "status": "running",
  "createdAt": "2026-09-05T08:00:01.000Z",
  "completedAt": null,
  "input": {
    "text": "帮我查这款鼠标官网价",
    "submittedAt": "2026-09-05T08:00:01.000Z"
  },
  "assembled": {
    "systemIds": ["pack.agent"],
    "skillIds": ["skill.web"],
    "sopIds": ["sop.browse"],
    "baseToolsIds": ["askUser", "finishTurn", "tool.detail", "memory.write"],
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
| `status` | `assembling` → `inferring` → `completed` / `waiting_human` / `failed`。工具循环时停在 `inferring` |
| `input.text` | 本轮用户原话。用户下一条输入才开新 Turn |
| `assembled` | 这一轮点名的 catalog IDs + 当前页 |
| `output.kind` | `tool` / `ask` / `reply` / `error` |

`output`：

- `tool` → `{kind, name, callId}`（动态工具 / `tool.detail` / `memory.write`）
- `ask` → `{kind, question}`（`askUser`）
- `reply` → `{kind, text}`（`finishTurn`，`text` 取 content 的 action）
- `error` → `{kind, faultCode}`

## Memory

三层，从稳到新：project → conversation → turn。模型调 `memory.write` 提交。Runtime 落盘 `memory/<memoryId>.json`，ID 挂到 ledger.`memoryIds`。下一次出网装配进 `#projectMemory` `#conversationMemory` `#turnMemory` `#contextSummary`。

```json
{
  "memoryId": "mm_01",
  "layer": "turn",
  "text": "当前页是罗技 MX Master 3S，京东标价待核官网。",
  "createdAt": "2026-09-05T08:00:12.000Z",
  "sourceCallId": "call_mem"
}
```

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

常驻工具 `askUser` / `finishTurn` / `tool.detail` / `memory.write` 的用法在 Pack（system）。动态工具用法在 user `#tools`。出网 `tools[]` = `baseToolsIds` + `toolIds` 的 catalog schema。每个工具 `arguments` 都带 `reason` 和 `affectsPage`。

`#toolIO` 是数组，每项 `{callId, name, arguments, return}`。队列跑完的每一次工具都进这里，含 `askUser` / `finishTurn` / `tool.detail` / `memory.write` / 动态工具。同一工具可出现多次。最新的在最下面。`return.text` 最多 2000 字；超出 `return.stage=truncated`，`return.totalChars` 写全文长度。要全文调 `tool.detail`，参数 `callId`。

`askUser` 的 `return.text` 是展示给用户的问题和选项。`finishTurn` 的 `return.text` 是回复用户的正文（取 content 的 action）。动态工具 / `tool.detail` 的 `return.text` 是工具跑出来的正文。`memory.write` 的 `return.text` 是落下的层和条数。

## 循环

1. 用户一句话 → 新 Turn。Runtime 把上一 Turn 的 `userInput` 追加进 ledger.`userInputHistory`。装配：`#userInputHistory` 是已结束回合的原话，`#userInput` 是本轮原话，`#toolIO` 带上本会话已执行过的工具条目（最新在最下面），记忆槽带上此前 `memory.write` 落下的内容。CE 装配，LLM 交工具。
2. 模型一次出网可交多个 `toolCalls`。Runtime 按数组顺序写入 ledger.`toolQueue`。任务队列按这个顺序执行。
3. 队列每跑完一条，把 `{callId, name, arguments, return}` 追加到 ledger.`toolIO` 末尾，并从队列弹出。
4. `askUser` → `return.text` 是问题和选项，ledger.`status=waiting_human`，等人答。用户下一条输入开新 Turn（走步骤 1）。
5. 动态工具 / `tool.detail` → `return.text` 是工具正文（窗口截到 2000 字）。队列清空后还在本 Turn 里再出网。
6. `memory.write` → Runtime 按 arguments 落盘三层记忆和 `contextSummary`，ID 挂到 ledger.`memoryIds`。队列清空后再出网时，对应 user 槽带上刚落下的内容。
7. `finishTurn` → `return.text` 是回复用户的正文。本 Turn `status=completed`，ledger.`status=idle`，`active=null`。本轮 `userInput` 仍在 Turn.`input`。用户下一句话开新 Turn 时写入 `userInputHistory`。记忆槽在下一次出网继续带上。

分阶段模拟：`docs/examples/01-normalize.md` → `02-context-engineering.md` → `03-decode.md` → `04-provider-request.md` → `05-provider-response.md` → `06-tool-execute.md`。
