# 08 收口

读 06 的写出。还在 `tn_01`。不再走 CE。Runtime 用这次装配的栏目再出网，`<toolIO>` 带上 `call_01`。模型交 `finishTurn`，回合结束。

怎么看：

- 「读到的」是 06 写出的原样
- 「再出网」是同一套 `systemSlots` / `userSlots`，只更新 `<toolIO>`
- 「交口」是模型交 `finishTurn`
- 「执行」是 Runtime 跑队列，把 `finishTurn` 追加进 `<toolIO>`，Turn `completed`

作者是 Runtime。07 是压缩能力样例，本轮窗口没到 200K，不走 07。

## 读到的（06 写出的）

见上一份「写出的」。本轮窗口 `<toolIO>`：

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

栏目沿用 03 的 `systemSlots` / `userSlots`。`<userInput>` 仍是「帮我查这款鼠标官网价」。`userInputHistory` 仍是 `[]`。

## 再出网

Provider 用同一套 messages，user `<toolIO>` 写成上面数组。模型交：

```json
{
  "finish": "tool_calls",
  "content": "",
  "toolCalls": [
    {
      "id": "call_02",
      "name": "finishTurn",
      "arguments": {
        "reason": "官网价已经查到，和当前页标价核对完，可以回复用户。",
        "affectsPage": false,
        "text": "罗技官网 MX Master 3S 标价 999 元，和当前页一致。"
      }
    }
  ]
}
```

`finishTurn` 是本次出网唯一一条，排在最后。`affectsPage=false`，不改当前页。

## 执行

入队后队列一条。Runtime 跑完，`return.text` 取 `arguments.text`：

```json
{
  "callId": "call_02",
  "name": "finishTurn",
  "arguments": {
    "reason": "官网价已经查到，和当前页标价核对完，可以回复用户。",
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

`totalChars=34`。Turn `status=completed`。ledger.`status=idle`，`active=null`。`userInputHistory` 仍是 `[]`：用户下一句话开新 Turn 时才追加上这一句。

## 字段

见 `docs/schema.md`「阶段快照」`finish-turn`。

## 写出的（累积快照）

```json
{
  "stage": "finish-turn",
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
    "memory.update",
    "memory.delete",
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
    "page.click_role",
    "page.fill_role",
    "page.submit_wait",
    "page.select_role",
    "page.click_text",
    "page.fill_submit",
    "checklist.set",
    "checklist.update",
    "page.recheck",
    "page.assert",
    "tab.context",
    "job.status",
    "job.stop"
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
    "#overview",
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
      "id": "call_02",
      "name": "finishTurn",
      "arguments": {
        "reason": "官网价已经查到，和当前页标价核对完，可以回复用户。",
        "affectsPage": false,
        "text": "罗技官网 MX Master 3S 标价 999 元，和当前页一致。"
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
    },
    {
      "callId": "call_02",
      "name": "finishTurn",
      "arguments": {
        "reason": "官网价已经查到，和当前页标价核对完，可以回复用户。",
        "affectsPage": false,
        "text": "罗技官网 MX Master 3S 标价 999 元，和当前页一致。"
      },
      "return": {
        "stage": "complete",
        "totalChars": 34,
        "text": "罗技官网 MX Master 3S 标价 999 元，和当前页一致。"
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

用户下一句话开 `tn_02`，走 01。那时 Runtime 把「帮我查这款鼠标官网价」写入 `userInputHistory`。
