# 数据

会话账本 + 记录。扩展不直连 UUAPI，请求走本机 Bun 服务 `127.0.0.1:18788`。密钥只在服务端 `.env`。

## 目录

```text
ledger.json
turns/<turnId>.json
memory/<memoryId>.json
observations/<observationId>.json
```

前缀：`cv_` 会话 · `tn_` 回合 · `mm_` 记忆 · `ob_` 压缩事实。

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
  "observation": [],
  "windowChars": 0,
  "compressAt": 200000,
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
| `toolIO` | 本会话已执行、窗口里还带着的工具调用，数组。新会话 `[]`。队列里跑完一条追加一条，最新在最下面。窗口到 200K 时较早的条目收进 `observation` |
| `observation` | 压缩过的事实，数组。新会话 `[]`。每项 `{id, text, sourceCallIds}`。`text` 是摘要。全文在 `observations/<id>.json`，用 `observation.detail` 取 |
| `windowChars` | 本轮出网窗口已用字符数。Runtime 装配后写入 |
| `compressAt` | 压缩门槛，固定 `200000` |
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
    "baseToolsIds": ["askUser", "finishTurn", "tool.detail", "observation.detail", "memory.write"],
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

- `tool` → `{kind, name, callId}`（动态工具 / `tool.detail` / `observation.detail` / `memory.write`）
- `ask` → `{kind, question}`（`askUser`）
- `reply` → `{kind, text}`（`finishTurn`，`text` 取 content 的 action）
- `error` → `{kind, faultCode}`

## Memory

三层，从稳到新：project → conversation → turn。模型调 `memory.write` 提交。Runtime 落盘 `memory/<memoryId>.json`，ID 挂到 ledger.`memoryIds`。下一次出网装配进 `#projectMemory` `#conversationMemory` `#turnMemory` `#contextSummary`。

窗口到 200K 时 Runtime 压缩 `turn` 和 `conversation` 两层：槽里只留摘要，原文仍按 `memoryId` 落盘。`project` 不压。

```json
{
  "memoryId": "mm_01",
  "layer": "turn",
  "text": "当前页是罗技 MX Master 3S，京东标价待核官网。",
  "summary": "MX Master 3S，待核官网价",
  "compressed": false,
  "createdAt": "2026-09-05T08:00:12.000Z",
  "sourceCallId": "call_mem"
}
```

`compressed=true` 时窗口槽用 `summary`，原文用 `observation.detail` 对应该条挂进 `#observation` 的 id 取。

## Observation

压缩过的事实。窗口到 200K 时 Runtime 把较早的 `toolIO`（以及被压的 turn / conversation 记忆）收成这些条目。窗口只带摘要。全文另存 `observations/<observationId>.json`。

```json
{
  "observationId": "ob_01",
  "text": "web.search 查到罗技官网 MX Master 3S 标价 999 元。",
  "sourceCallIds": ["call_01"],
  "totalChars": 26,
  "createdAt": "2026-09-05T08:00:20.000Z"
}
```

## 装配

用户一条输入开一个 Turn，CE 装配一次：system Pack + 本会话 `skillIds` / `toolIds` / `sopIds` / `mcpIds` + user 记忆槽 + `#observation` + `#userInputHistory` + `#userInput` + `#currentEnvironment` + `#toolIO`。

本 Turn 内工具循环不再走 CE。Runtime 只改 `#toolIO`（以及刚落下的记忆槽 / `#observation`），用同一套插槽再出网。

user 文档块：

```text
#projectMemory
#conversationMemory
#turnMemory
#contextSummary
#observation
#userInputHistory
#userInput
#currentEnvironment
#toolIO
#tools
```

常驻工具 `askUser` / `finishTurn` / `tool.detail` / `observation.detail` / `memory.write` 的用法在 Pack（system）。动态工具用法在 user `#tools`。出网 `tools[]` = `baseToolsIds` + `toolIds` 的 catalog schema。每个工具 `arguments` 都带 `reason` 和 `affectsPage`。

`#observation` 是压缩过的事实数组，每项 `{id, text, sourceCallIds}`。要看具体事实调 `observation.detail`，参数 `observationId`。

`#toolIO` 是数组，每项 `{callId, name, arguments, return}`。队列跑完的每一次工具都进这里。同一工具可出现多次。最新的在最下面。窗口到 200K 时较早的条目收进 `#observation`，`#toolIO` 只留最近未压缩的。`return.text` 最多 2000 字；超出 `return.stage=truncated`，`return.totalChars` 写全文长度。要全文调 `tool.detail`，参数 `callId`。

`askUser` 的 `return.text` 是展示给用户的问题和选项。`finishTurn` 的 `return.text` 是回复用户的正文（取 content 的 action）。动态工具 / `tool.detail` / `observation.detail` 的 `return.text` 是工具跑出来的正文。`memory.write` 的 `return.text` 是落下的层和条数。

## 循环

1. 用户一句话 → 新 Turn。Runtime 把上一 Turn 的 `userInput` 追加进 ledger.`userInputHistory`。CE 装配一次：`#userInputHistory` 是已结束回合的原话，`#userInput` 是本轮原话，`#toolIO` 带上本会话未压缩的工具条目（最新在最下面），`#observation` 带上已压缩的事实，记忆槽带上此前 `memory.write` 落下的内容（已压缩的层用摘要）。LLM 交工具。
2. 模型一次出网可交多个 `toolCalls`。Runtime 按数组顺序写入 ledger.`toolQueue`。任务队列按这个顺序执行。
3. 队列每跑完一条，把 `{callId, name, arguments, return}` 追加到 ledger.`toolIO` 末尾，并从队列弹出。
4. `askUser` → `return.text` 是问题和选项，ledger.`status=waiting_human`，等人答。用户下一条输入开新 Turn（走步骤 1）。
5. 动态工具 / `tool.detail` / `observation.detail` → `return.text` 是工具正文（窗口截到 2000 字）。队列清空后还在本 Turn 里再出网：插槽沿用这次装配，只更新 `#toolIO`。
6. `memory.write` → Runtime 按 arguments 落盘三层记忆和 `contextSummary`，ID 挂到 ledger.`memoryIds`。队列清空后再出网时，对应 user 槽带上刚落下的内容。不重新点名 catalog。
7. `finishTurn` → `return.text` 是回复用户的正文。本 Turn `status=completed`，ledger.`status=idle`，`active=null`。本轮 `userInput` 仍在 Turn.`input`。用户下一句话开新 Turn 时写入 `userInputHistory`，走步骤 1。
8. 开 Turn 装配后、以及本 Turn 每次出网前，Runtime 计 `windowChars`。到 `compressAt`（200000）就压缩：较早的 `toolIO` 收成 `observation` 条目（摘要进窗口，全文另存）；`turn` / `conversation` 记忆槽改用 `summary`。然后用压缩后的窗口再出网。

分阶段模拟：`docs/examples/01-normalize.md` → `02-context-engineering.md` → `03-decode.md` → `04-provider-request.md` → `05-provider-response.md` → `06-tool-execute.md` → `08-finish-turn.md`。窗口到 200K 时插 `07-compress.md`。
