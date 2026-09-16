# 05 Provider 传出

读 04 的写出。记录这一次 UUAPI **传出**：先完整 JSON 响应，再转成 Runtime 认的交口。

怎么看：
- 「读到的」是 04 写出的原样（`stream=false`，最多 3 次）
- 「JSON 响应」是 `stream: false` 返回的完整 Chat Completions 对象
- 「模型交口」是 Provider 读取 message、解析工具参数之后，Runtime 只认这份
- 「写出的」累积快照追加 `finish` `content` `toolCalls` `attempts` `parseOk` `schemaOk` `faultCode` `missing`

作者是 Provider。不跑工具、不落盘。`usage` / 响应 `id` / `object` 不进交口。

本轮第 1 次就收到完整 JSON 响应，交 `web_search`，不交 `askUser`。

## 读到的（04 写出的）

```json
{
  "stage": "provider-request",
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
    "page.clear_result"
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
    "#queryHistory",
    "#currentQuery",
    "#tools"
  ],
  "provider": "uuapi",
  "model": "gemini-3.7-flash",
  "stream": false,
  "maxAttempts": 3,
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

## JSON 响应

`stream: false` 返回完整 JSON，Provider 读取第一项 `choices[0]`：

```json
{
  "id": "chatcmpl_01",
  "object": "chat.completion",
  "model": "gemini-3.7-flash",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "",
        "tool_calls": [
          {
            "id": "call_01",
            "type": "function",
            "function": {
              "name": "web_search",
              "arguments": "{\"reason\": \"当前页已确认是目标商品，需要官网价来核对标价。\", \"affectsPage\": false, \"query\": \"罗技 MX Master 3S 官网 价格\"}"
            }
          }
        ]
      },
      "finish_reason": "tool_calls"
    }
  ]
}
```

`message.content` 保留模型正文，`message.tool_calls` 提供完整调用数组。`function.arguments` 是 JSON 字符串，Provider 使用参数解析器转成对象；正文不进入 Ajv。缺少 choices 或无法解析响应属于协议错误，不自动重试。

## 容错

分两条线。Provider **不替模型改 JSON**（不是代码补全）。

校验对象只有 **`tool_calls[].function.arguments`**（工具提交）。`content` 是给人看的正文，不 parse、不进 Ajv。`finish=stop` 且没有 `tool_calls` 时，跳过 B，直接把 `content` 交给 Runtime。

### A. 线路失败（同一 body 再打，最多 3 次）

网络 / 空闲超时 / 5xx / 429。响应 JSON 无法解析或缺少 choices 不重试。4xx（除 429）不重试；可重试失败间隔 1 秒，最多 3 次。

### B. 工具提交失败（把错误类型回给模型再交，同一 turn 最多 3 次）

只在有 `tool_calls` 时走。`arguments` 不是 JSON、缺 required、未知工具、常驻互斥。判定之后写成一条 **tool 结果** 再出网，让模型按 `faultCode` 重交。3 次仍坏才 `finish=error`。

`faultCode`：

| `faultCode` | 何时 |
|---|---|
| `arguments_not_json` | `function.arguments` 解析失败。对象原样用；字符串 `JSON.parse`；不修复围栏、尾逗号或单引号。不补字段 |
| `unknown_tool` | `name` 不在 `baseToolsIds` + `toolIds` |
| `missing_required` | catalog `required` 缺或空；`missing` 列出字段名 |
| `wrong_type` | Ajv：类型对不上 schema |
| `exclusive_resident` | 同一次出网里 `finishTurn` 不在最后一条 |

回给模型的 tool 结果（`role=tool`，`tool_call_id` 用这次的 `call_01`）：

```json
{
  "ok": false,
  "faultCode": "missing_required",
  "missing": [
    "reason"
  ],
  "toolName": "web_search"
}
```

`arguments_not_json` 时没有对象可查缺，`missing` 为 `[]`，`detail` 写 parse 报错原文。

所有 provider 返回均经过 `service/runtime/loop.ts` 的 `validateCompletion`，由它调用 `service/tools/schema.ts` 完成统一策略校验，不因接入方式不同而绕过检查。落地查缺用 **Ajv** 对 `service/tools/definitions/<name>.json` 的 `function.parameters`。解析在 `service/tools/arguments.ts`：对象原样用，字符串 `JSON.parse`，不修复围栏 / 尾逗号 / 单引号。缺字段、类型错不补，faultCode 回给模型再交。

本轮一次过：

```json
{
  "parseOk": true,
  "schemaOk": true,
  "faultCode": null,
  "toolName": "web_search",
  "required": [
    "reason",
    "query"
  ],
  "missing": []
}
```


## 模型交口（解析后）

| JSON 响应 | → 交口 |
|---|---|
| `choices[0].finish_reason` | `finish` |
| `choices[0].message.content` | `content` 原文 |
| `message.tool_calls[].id` | `toolCalls[].id` |
| `message.tool_calls[].function.name` | `toolCalls[].name` |
| `message.tool_calls[].function.arguments` 经参数解析器解析 | `toolCalls[].arguments` 对象 |

```json
{
  "stage": "provider-response",
  "conversationId": "cv_01",
  "turnId": "tn_01",
  "provider": "uuapi",
  "model": "gemini-3.7-flash",
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
  ]
}
```

`toolCalls[0].arguments` 本轮字段：

| 字段 | 类型 | 本轮 |
|---|---|---|
| `reason` | string | 当前页已确认是目标商品，需要官网价来核对标价。 |
| `affectsPage` | boolean | false，这次不改当前页 |
| `query` | string | 罗技 MX Master 3S 官网 价格 |

3 次都失败时交口是 `finish=error`，`content` 写失败原因，`toolCalls=[]`。本轮不是这种情况。

## 字段

见 `docs/schema.md`「阶段快照」`provider-response` 和 `faultCode`。本轮交口值见上面那张本轮表。

## 写出的（累积快照）

```json
{
  "stage": "provider-response",
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
    "page.clear_result"
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
    "#queryHistory",
    "#currentQuery",
    "#tools"
  ],
  "provider": "uuapi",
  "model": "gemini-3.7-flash",
  "stream": false,
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

下一份 `06-tool-execute.md`：Runtime 执行 `web_search`，写入 `#toolIO`，进 LOOP。
