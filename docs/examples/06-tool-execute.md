# 06 工具执行

读 05 的写出。Runtime 按 `toolCalls[0]` 跑工具，把调用和返回追加进 `#toolIO`。

怎么看：

- 「读到的」是 05 写出的原样
- 「执行」是 Runtime 跑 `web.search`
- 「`#toolIO`」是下一轮 user 槽里给模型看的数组，最新在最下面
- 「写出的」累积快照追加 `toolIO`

作者是 Runtime。本轮返回 26 字，`stage=complete`，不到 2000，不调 `tool.detail`。

## 读到的（05 写出的）

见上一份「写出的」。本轮交口：

```json
{
  "finish": "tool_calls",
  "toolCalls": [
    {
      "id": "call_01",
      "name": "web.search",
      "arguments": {
        "reason": "当前页已确认是目标商品，需要官网价来核对标价。",
        "query": "罗技 MX Master 3S 官网 价格"
      }
    }
  ]
}
```

## 执行

Runtime 按 `name=web.search` 跑，拿到全文：

```
罗技官网 MX Master 3S 标价 999 元
```

`totalChars=26` ≤ 2000，`stage=complete`。窗口 `return.text` = 全文。

超出 2000 时：`stage=truncated`，窗口只留前 2000 字，`totalChars` 写全文长度。模型要全文时交 `tool.detail`，`callId=call_01`。

## `#toolIO`

数组。每项一次调用。同一工具可出现多次。最新的在最下面。

```json
[
  {
    "callId": "call_01",
    "name": "web.search",
    "arguments": {
      "reason": "当前页已确认是目标商品，需要官网价来核对标价。",
      "query": "罗技 MX Master 3S 官网 价格"
    },
    "return": {
      "stage": "complete",
      "totalChars": 26,
      "text": "罗技官网 MX Master 3S 标价 999 元"
    }
  }
]
```

| 字段 | 怎么填 |
|---|---|
| `callId` | `toolCalls[].id` |
| `name` | 工具名 |
| `arguments` | 模型交的参数（已 parse） |
| `return.stage` | `complete` / `truncated` |
| `return.totalChars` | 全文长度 |
| `return.text` | 窗口正文，最多 2000 字 |

观察就是这些工具返回。Runtime 把本条追加到 ledger.`toolIO` 末尾。窗口只带 `return`（最多 2000 字）；全文按 `callId` 另存，模型要全文时交 `tool.detail`。

## 字段

上一份已有、本份原样带上：05 写出的全部键。

本环节新增 / 改写：

| 字段 | 类型 | 谁填 | 怎么填 |
|---|---|---|---|
| `stage` | string | 固定 | `tool-execute` |
| `toolIO` | array | Runtime | 每项 `{callId, name, arguments, return}`，最新在最下面 |

## 写出的（累积快照）

```json
{
  "stage": "tool-execute",
  "conversationId": "cv_01",
  "turnId": "tn_01",
  "userInput": "帮我查这款鼠标官网价",
  "userInputHistory": [],
  "submittedAt": "2026-09-05T08:00:01.000Z",
  "systemIds": [
    "pack.agent"
  ],
  "skillIds": [
    "skill.web"
  ],
  "sopIds": [
    "sop.browse"
  ],
  "baseToolsIds": [
    "askUser",
    "finishTurn",
    "tool.detail"
  ],
  "toolIds": [
    "web.search"
  ],
  "turnMemoryIds": [],
  "conversationMemoryIds": [],
  "projectMemoryIds": [],
  "mcpIds": [],
  "currentPage": {
    "description": "当前页面信息",
    "tab": 12,
    "url": "https://item.jd.com/100012345678.html",
    "title": "罗技 MX Master 3S 无线鼠标"
  },
  "systemSlots": [
    "#身份",
    "#记忆",
    "#环境",
    "#原则",
    "#参数说明",
    "#内置工具",
    "#输出",
    "#user字段说明",
    "#skill",
    "#sop"
  ],
  "userSlots": [
    "#projectMemory",
    "#conversationMemory",
    "#turnMemory",
    "#contextSummary",
    "#userInputHistory",
    "#userInput",
    "#currentEnvironment",
    "#toolIO",
    "#tools"
  ],
  "provider": "uuapi",
  "model": "gemini-3.7-flash",
  "stream": true,
  "maxAttempts": 3,
  "finish": "tool_calls",
  "content": "observation\n当前页是京东商品页，标题罗技 MX Master 3S 无线鼠标。用户要查官网价。\n\nreason\n商品和要查的价格已经明确，直接搜官网价。\n\naction\n调用 web.search，查询罗技 MX Master 3S 官网价。",
  "toolCalls": [
    {
      "id": "call_01",
      "name": "web.search",
      "arguments": {
        "reason": "当前页已确认是目标商品，需要官网价来核对标价。",
        "query": "罗技 MX Master 3S 官网 价格"
      }
    }
  ],
  "attempts": 1,
  "parseOk": true,
  "schemaOk": true,
  "faultCode": null,
  "missing": [],
  "toolIO": [
    {
      "callId": "call_01",
      "name": "web.search",
      "arguments": {
        "reason": "当前页已确认是目标商品，需要官网价来核对标价。",
        "query": "罗技 MX Master 3S 官网 价格"
      },
      "return": {
        "stage": "complete",
        "totalChars": 26,
        "text": "罗技官网 MX Master 3S 标价 999 元"
      }
    }
  ]
}
```

下一份：新 Turn 装配，`#toolIO` 带上 `call_01`，模型接着交 `finishTurn` 或下一个工具。
