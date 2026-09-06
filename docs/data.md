# 数据

会话账本 + 记录。字段声明在 `docs/schema.md`。扩展不直连 UUAPI，请求走本机 Bun 服务 `127.0.0.1:18788`。密钥只在服务端 `.env`。运行时数据在 `~/Library/Application Support/tChrome/`。

## 目录

```text
session.json
conversations/<cvId>/ledger.json
conversations/<cvId>/turns/<turnId>.json
conversations/<cvId>/memory/<memoryId>.json
conversations/<cvId>/observations/<observationId>.json
```

前缀见 schema。HTTP 见 schema「本机 HTTP」。

## session.json

当前打开的会话。字段见 schema「session.json」。

```json
{
  "conversationId": "cv_01"
}
```

## ledger.json

Runtime 独占维护。当前会话指针。字段见 schema「ledger.json」。

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

## Turn

用户一轮对话。用户一条输入开一个 Turn。本 Turn 内可多次出网。字段见 schema「turns/<turnId>.json」。

```json
{
  "turnId": "tn_01",
  "conversationId": "cv_01",
  "status": "inferring",
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

## Memory

三层，从稳到新：project → conversation → turn。模型调 `memory.write` 提交。字段见 schema「memory/<memoryId>.json」。

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

## Observation

压缩过的事实。全文另存。字段见 schema「observations/<observationId>.json」。

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

用户一条输入开一个 Turn，CE 装配一次。本 Turn 内工具循环不再走 CE。Runtime 只改 `#toolIO`（以及刚落下的记忆槽 / `#observation`），用同一套插槽再出网。

插槽顺序和正文来源见 schema「窗口插槽」。

## 循环

1. 用户一句话 → `POST /turn` `{userInput, submittedAt}`。Runtime 读 `session.json`，没有 `conversationId` 就建 `cv_` 并写入。新 Turn。Runtime 把上一 Turn 的 `userInput` 追加进 ledger.`userInputHistory`。CE 装配一次。有浏览器桥就调 `page.current` 填 `currentPage`。LLM 交工具。
2. 模型一次出网可交多个 `toolCalls`。Runtime 按数组顺序写入 ledger.`toolQueue`。任务队列按这个顺序执行。
3. 队列每跑完一条，把 `{callId, name, arguments, return}` 追加到 ledger.`toolIO` 末尾，并从队列弹出。
4. `askUser` → ledger.`status=waiting_human`。用户下一条输入开新 Turn（走步骤 1）。
5. 动态工具 / `tool.detail` / `observation.detail` → 队列清空后还在本 Turn 里再出网：插槽沿用这次装配，只更新 `#toolIO`。
6. `memory.write` → Runtime 落盘，ID 挂到 ledger.`memoryIds`。队列清空后再出网时，对应 user 槽带上刚落下的内容。
7. `finishTurn` → 本 Turn `status=completed`，ledger.`status=idle`，`active=null`。用户下一句话开新 Turn 时写入 `userInputHistory`，走步骤 1。
8. 开 Turn 装配后、以及本 Turn 每次出网前，Runtime 计 `windowChars`。到 `compressAt`（200000）就压缩，然后用压缩后的窗口再出网。

分阶段模拟：`docs/examples/01-normalize.md` → `02-context-engineering.md` → `03-decode.md` → `04-provider-request.md` → `05-provider-response.md` → `06-tool-execute.md` → `08-finish-turn.md`。窗口到 200K 时插 `07-compress.md`。
