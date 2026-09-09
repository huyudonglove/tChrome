# 07 压缩

读 06 的写出。Runtime 出网前计 `windowChars`。到 `compressAt`（200000）就把较早的 `#toolIO` 收成 `#observation`，并压缩 turn / conversation 记忆。

本文件是压缩能力的样例：假设窗口已经到 200K（主链 01–06 的窗口还远没到，不压）。作者是 Runtime。

怎么看：

- 「读到的」是 06 写出的原样
- 「压缩前」窗口带着完整 `toolIO` 和记忆原文
- 「压缩后」较早的 tool history 进 `#observation`（摘要）；细节用 `observation.detail`
- 「写出的」累积快照改 `observation` `toolIO` `windowChars`

## 读到的（06 写出的）

```json
{
  "stage": "tool-execute",
  "conversationId": "cv_01",
  "turnId": "tn_01",
  "userInput": "帮我查这款鼠标官网价",
  "userInputHistory": [],
  "submittedAt": "2026-09-05T08:00:01.000Z",
  "toolQueue": [],
  "toolIO": [
    {
      "callId": "call_01",
      "name": "web_search",
      "arguments": {
        "reason": "当前页已确认是目标商品，需要官网价来核对标价。",
        "affectsPage": false,
        "query": "罗技 MX Master 3S 官网 价格"
      },
      "return": {
        "stage": "complete",
        "totalChars": 26,
        "text": "罗技官网 MX Master 3S 标价 999 元"
      }
    }
  ],
  "observation": [],
  "windowChars": 0,
  "compressAt": 200000
}
```

## 门槛

| 字段 | 值 |
|---|---|
| `compressAt` | 200000 |
| `windowChars` 压缩前 | 200000（本样例假设已到） |
| 压什么 | 较早的 `#toolIO`；`turnMemory`；`conversationMemory` |
| 不压 | `projectMemory`；最近未压缩的 `#toolIO`；`#userInput` |

## 压缩后窗口

### `#observation`

```json
[
  {
    "id": "ob_01",
    "text": "web_search 查到罗技官网 MX Master 3S 标价 999 元。",
    "sourceCallIds": [
      "call_01"
    ]
  }
]
```

这是压缩过的事实。要看具体调用和返回，调 `observation.detail`，`observationId=ob_01`。

### `#toolIO`

```json
[]
```

`call_01` 已收进 `ob_01`。之后新跑的工具继续追加到 `#toolIO`。

### `#turnMemory` / `#conversationMemory`

本样例压缩前这两槽是空的。到门槛时 Runtime 先裁：`toolIds` 留下 core + 本轮已用过的；记忆窗口每层只带最近 8 条。然后再把 turn/conversation 改成 `summary`，`memory.compressed=true`。原文仍在 `memory/<id>.json`。`projectMemory` 不压。流水 `kind=compress` 带 `compressedMemoryIds` `prunedToolIds`。

### 全文另存

```json
{
  "observationId": "ob_01",
  "text": "web_search 查到罗技官网 MX Master 3S 标价 999 元。",
  "sourceCallIds": [
    "call_01"
  ],
  "totalChars": 26,
  "createdAt": "2026-09-05T08:00:20.000Z",
  "full": {
    "callId": "call_01",
    "name": "web_search",
    "arguments": {
      "reason": "当前页已确认是目标商品，需要官网价来核对标价。",
      "affectsPage": false,
      "query": "罗技 MX Master 3S 官网 价格"
    },
    "return": {
      "stage": "complete",
      "totalChars": 26,
      "text": "罗技官网 MX Master 3S 标价 999 元"
    }
  }
}
```

`observation.detail` 的 `return.text` 是这份 `full` 的正文（窗口仍截 2000 字）。

## 字段

见 `docs/schema.md`「阶段快照」`compress`。

## 写出的（累积快照）

```json
{
  "stage": "compress",
  "conversationId": "cv_01",
  "turnId": "tn_01",
  "userInput": "帮我查这款鼠标官网价",
  "userInputHistory": [],
  "submittedAt": "2026-09-05T08:00:01.000Z",
  "toolQueue": [],
  "toolIO": [],
  "observation": [
    {
      "id": "ob_01",
      "text": "web_search 查到罗技官网 MX Master 3S 标价 999 元。",
      "sourceCallIds": [
        "call_01"
      ]
    }
  ],
  "windowChars": 18420,
  "compressAt": 200000
}
```

`windowChars=18420` 是本样例压缩后的窗口，低于 200000，继续出网。实际数字由 Runtime 出网前写入。

下一份：还在 `tn_01`。窗口带上 `#observation` 的 `ob_01`，`#toolIO` 空，用这次 Turn 已有的栏目再出网。模型要看 `call_01` 全文时交 `observation.detail`。用户下一句话才开新 Turn。
