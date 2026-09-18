# 06 工具执行

读 05 的写出。Runtime 把 `toolCalls` 按数组顺序写入 `toolQueue`，任务队列按这个顺序跑。跑完追加进 `#toolIO`。

怎么看：

- 「读到的」是 05 写出的原样
- 「队列」是本次出网入队的工具，顺序 = `toolCalls` 数组
- 「执行」是 Runtime 按队列跑 `web_search`
- 「`#toolIO`」是本 Turn 下一轮出网时 user 槽里给模型看的数组，最新在最下面
- 「写出的」累积快照追加 `toolQueue` `toolIO`

作者是 Runtime。本轮返回 26 字，`stage=complete`，完整写入执行记录。

## 读到的（05 写出的）

见上一份「写出的」。本轮交口：

```json
{
  "finish": "tool_calls",
  "toolCalls": [
    {
      "id": "call_01",
      "name": "web_search",
      "arguments": {
        "reason": "当前页已确认是目标商品，需要官网价来核对标价。",
        "affectsPage": false,
        "query": "罗技 MX Master 3S 官网 价格"
      }
    }
  ]
}
```

## 执行

本次出网 `toolCalls` 一条，入队后队列是：

```json
[
  {
    "callId": "call_01",
    "name": "web_search",
    "arguments": {
      "reason": "当前页已确认是目标商品，需要官网价来核对标价。",
      "affectsPage": false,
      "query": "罗技 MX Master 3S 官网 价格"
    }
  }
]
```

`affectsPage=false`，不改当前页。Runtime 按队列第一条 `name=web_search` 跑，拿到全文：

```
罗技官网 MX Master 3S 标价 999 元
```

`totalChars=26`，`stage=complete`。执行记录的 `return.text` 保存全文。

工具返回保留全文。总窗口达到 200K 字符时，由 Runtime 按 Turn 归档压缩，流程见 [07 压缩与查询](07-compress.md)。

## `#toolIO`

数组。每项一次调用。同一工具可出现多次。最新的在最下面。

```json
[
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
]
```

项字段见 `docs/schema.md`「toolIO 项」。

`totalChars=26`，`stage=complete`。执行记录的 `return.text` 保存全文。

Runtime 把本条追加到 ledger.`toolIO` 末尾。主模型看到投影后的工具名称、参数和结果；已归档记录通过 `context.query` 按 sumId、module 和 intent 委托查询。页面观察由有效页面返回单独更新。

askUser / finishTurn 也是工具调用，同样追加。形状如下（本轮主链是 `web_search`，这两条不进本轮写出的）。

`askUser`：`return.text` 是展示给用户的问题和选项。ledger.`status=waiting_human`。

```json
{
  "callId": "call_ask",
  "name": "askUser",
  "arguments": {
    "reason": "当前页型号看不清，要用户确认查哪一款。",
    "affectsPage": false,
    "choice": [
      "MX Master 3S",
      "MX Master 3"
    ],
    "question": "当前页型号看不清，要查哪一款？"
  },
  "return": {
    "stage": "complete",
    "totalChars": 45,
    "text": "当前页型号看不清，要查哪一款？\n选项：MX Master 3S / MX Master 3"
  }
}
```

`finishTurn`：`return.text` 是回复用户的正文（取 `arguments.text`）。本 Turn `status=completed`。

```json
{
  "callId": "call_fin",
  "name": "finishTurn",
  "arguments": {
    "reason": "官网价已核对，回复用户。",
    "affectsPage": false,
    "text": "罗技官网 MX Master 3S 标价 999 元，和当前页一致。"
  },
  "return": {
    "stage": "complete",
    "totalChars": 34,
    "text": "罗技官网 MX Master 3S 标价 999 元，和当前页一致。"
  }
}
```

本轮样例两层记忆为空，直到模型交 `memory.write`。形状如下（本轮主链是 `web_search`，这条不进本轮写出的）。Runtime 落盘后，下一次出网把正文带进 `#conversationMemory` / `#projectMemory`。

```json
{
  "callId": "call_mem",
  "name": "memory.write",
  "arguments": {
    "reason": "记下当前页型号，下一轮核对官网价时用。",
    "affectsPage": false,
    "conversationMemory": [
      "当前页是罗技 MX Master 3S，京东标价待核官网。"
    ]
  },
  "return": {
    "stage": "complete",
    "totalChars": 27,
    "text": "已写入 conversationMemory 1 条。"
  }
}
```

## 字段

见 `docs/schema.md`「阶段快照」`tool-execute` 和「toolIO 项」。

## 写出的（累积快照）

```json
{
  "stage": "tool-execute",
  "conversationId": "cv_01",
  "turnId": "tn_01",
  "userInput": "帮我查这款鼠标官网价",
  "userInputHistory": [],
  "submittedAt": "2026-09-05T08:00:01.000Z",
  "baseToolsIds": [
    "askUser",
    "finishTurn",
    "submitGoal",
    "context.query",
    "memory.write",
    "notes.write",
    "notes.delete",
    "page.clear_result",
    "evidence.search",
    "catalog.add",
    "list_browser_tools",
    "open_url",
    "page.get_summary",
    "page.list_interactive_elements",
    "page.click",
    "page.type",
    "checklist.set",
    "checklist.update",
    "page.recheck",
    "page.assert",
    "tab.context"
  ],
  "toolIds": [
    "page.get_summary",
    "open_url",
    "web_search"
  ],
  "conversationMemoryIds": [],
  "projectMemoryIds": [],
  "mcpIds": [],
  "currentPage": {
    "tabId": 12,
    "url": "https://item.jd.com/100012345678.html",
    "title": "罗技 MX Master 3S 无线鼠标",
    "description": "用户发话时的标签信息，尚未读取页面内容"
  },
  "systemSlots": [
    "#identity",
    "#environment",
    "#runtime",
    "#recordIdentity",
    "#execution",
    "#toolProtocol",
    "#boundaries",
    "#output",
    "#baseTools"
  ],
  "userSlots": [
    "#skill",
    "#userInput",
    "#conversationHistorySummary",
    "#userInputHistory",
    "#goal",
    "#goalHistory",
    "#openTabs",
    "#pageObservedHistory",
    "#projectMemory",
    "#conversationMemory",
    "#notes",
    "#toolIO",
    "#lastAction",
    "#checklist",
    "#queryHistory",
    "#currentQuery",
    "#tools"
  ],
  "provider": "uuapi",
  "model": "gemini-3.7-flash",
  "stream": true,
  "maxAttempts": 3,
  "finish": "tool_calls",
  "content": "",
  "toolCalls": [
    {
      "id": "call_01",
      "name": "web_search",
      "arguments": {
        "reason": "当前页已确认是目标商品，需要官网价来核对标价。",
        "affectsPage": false,
        "query": "罗技 MX Master 3S 官网 价格"
      }
    }
  ],
  "attempts": 1,
  "parseOk": true,
  "schemaOk": true,
  "faultCode": null,
  "missing": [],
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
  "compressAt": 200000,
  "pageObservedHistory": [],
  "openTabs": {
    "ok": true,
    "windows": [
      {
        "windowId": 1,
        "focused": true,
        "tabs": [
          {
            "tabId": 12,
            "url": "https://item.jd.com/100012345678.html",
            "title": "罗技 MX Master 3S 无线鼠标",
            "active": true
          }
        ]
      }
    ]
  }
}
```

下一份：还在 `tn_01`。队列已空。本 Turn 用这次装配的栏目再出网，`#toolIO` 带上 `call_01`，见 `08-finish-turn.md`。窗口到 200K 时走 `07-compress.md`。用户下一句话才开新 Turn，那时才把本轮 `userInput` 写入 `userInputHistory`，走 01。
