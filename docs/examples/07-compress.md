# 07 压缩

以 06 的写出为起点，假设本 Turn 又完成两次工具调用。Runtime 出网前计 `windowChars`；到 `compressAt`（200000）且 toolIO 多于两条时，将较早记录归档为可回查的 observation，保留最近两条。Context 负责记忆窗口的纯投影。

本文件是压缩能力的样例：假设窗口已经到 200K（主链 01–06 的窗口还远没到，不压）。归档作者是 Runtime，窗口投影由 Context 完成。

怎么看：

- 「读到的」在 06 的基础上追加两条工具记录，以展示保留最近两条的归档规则
- 「压缩前」窗口带着当前 toolIO 和每层最近 8 条记忆
- 「压缩后」较早的 tool history 进 `#observation`（摘要）；细节用 `observation.detail`
- 「写出的」累积快照改 `observation` `toolIO` `windowChars`

## 读到的（沿用 06 并追加两次调用）

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
    },
    {
      "callId": "call_02",
      "name": "page.get_summary",
      "arguments": {
        "reason": "确认当前仍是目标商品页面。",
        "affectsPage": false
      },
      "return": {
        "stage": "complete",
        "totalChars": 10,
        "text": "当前页是目标商品详情"
      }
    },
    {
      "callId": "call_03",
      "name": "web_search",
      "arguments": {
        "reason": "核对官网价格来源。",
        "affectsPage": false,
        "query": "MX Master 3S 罗技 官网 999"
      },
      "return": {
        "stage": "complete",
        "totalChars": 11,
        "text": "官网价格来源已完成核对"
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
| 归档什么 | 除最近两条以外的 toolIO，全文写 observation |
| 仅展示摘要 | 超阈值时的 conversationMemory |
| 保留什么 | projectMemory 原文展示；最近两条 toolIO；完整 memoryIds 与 toolIds |

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
[
  {
    "callId": "call_02",
    "name": "page.get_summary",
    "arguments": {
      "reason": "确认当前仍是目标商品页面。",
      "affectsPage": false
    },
    "return": {
      "stage": "complete",
      "totalChars": 10,
      "text": "当前页是目标商品详情"
    }
  },
  {
    "callId": "call_03",
    "name": "web_search",
    "arguments": {
      "reason": "核对官网价格来源。",
      "affectsPage": false,
      "query": "MX Master 3S 罗技 官网 999"
    },
    "return": {
      "stage": "complete",
      "totalChars": 11,
      "text": "官网价格来源已完成核对"
    }
  }
]
```

`call_01` 已归档到 `ob_01`，call_02 和 call_03 留在 toolIO。之后新跑的工具继续追加。只有一条或两条记录时不归档。

### `#conversationMemory`

本样例此槽为空。存在记忆时，Memory 能力层每层仅投影最近 8 条；超阈值时 conversation 优先展示 summary，没有摘要时展示归一空白后的前 80 字。project 不做摘要压缩。磁盘记忆的 text、summary、compressed 和完整 memoryIds 都保持不变，已加载 toolIds 也不卸载。流水 kind=compress 的 compressedMemoryIds / prunedToolIds 保留为空数组，仅兼容事件形状。

### 全文另存

```json
{
  "observationId": "ob_01",
  "text": "web_search 查到罗技官网 MX Master 3S 标价 999 元。",
  "sourceCallIds": [
    "call_01"
  ],
  "totalChars": 223,
  "createdAt": "2026-09-05T08:00:20.000Z",
  "full": "{\"callId\":\"call_01\",\"name\":\"web_search\",\"arguments\":{\"reason\":\"当前页已确认是目标商品，需要官网价来核对标价。\",\"affectsPage\":false,\"query\":\"罗技 MX Master 3S 官网 价格\"},\"return\":{\"stage\":\"complete\",\"totalChars\":26,\"text\":\"罗技官网 MX Master 3S 标价 999 元\"}}"
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
  "toolIO": [
    {
      "callId": "call_02",
      "name": "page.get_summary",
      "arguments": {
        "reason": "确认当前仍是目标商品页面。",
        "affectsPage": false
      },
      "return": {
        "stage": "complete",
        "totalChars": 10,
        "text": "当前页是目标商品详情"
      }
    },
    {
      "callId": "call_03",
      "name": "web_search",
      "arguments": {
        "reason": "核对官网价格来源。",
        "affectsPage": false,
        "query": "MX Master 3S 罗技 官网 999"
      },
      "return": {
        "stage": "complete",
        "totalChars": 11,
        "text": "官网价格来源已完成核对"
      }
    }
  ],
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

下一份：还在 `tn_01`。窗口带上 `#observation` 的 `ob_01`，`#toolIO` 保留 call_02 和 call_03，用这次 Turn 已有的栏目再出网。模型要看 `call_01` 全文时交 `observation.detail`。用户下一句话才开新 Turn。
