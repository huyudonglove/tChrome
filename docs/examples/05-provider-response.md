# 05 Provider 传出

读 04 的写出。记录这一次 UUAPI **传出**：先原文，再收成 Runtime 认的交口。

怎么看：
- 「读到的」是 04 写出的原样（已经拼好要发给谁）
- 「UUAPI 原文」是 `POST /v1/chat/completions` 的响应 body
- 「模型交口」是 Provider 解析后、Runtime 只认的那份
- 「写出的」累积快照追加 `finish` `content` `toolCalls`

作者是 Provider。不跑工具、不落盘。`usage` / 响应 `id` / `object` 不进交口。

本轮 intake 材料够，交 `continueTask`，不交 `askUser`。

## 读到的（04 写出的）

```json
{
  "stage": "provider-request",
  "conversationId": "cv_01",
  "turnId": "tn_01",
  "userInput": "帮我查这款鼠标官网价",
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
    "continueTask",
    "askUser"
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
    "#user字段说明",
    "#skill",
    "#sop"
  ],
  "userSlots": [
    "#projectMemory",
    "#conversationMemory",
    "#turnMemory",
    "#contextSummary",
    "#currentTask",
    "#userInput",
    "#currentEnvironment",
    "#tools"
  ],
  "provider": "uuapi",
  "model": "gemini-3.7-flash"
}
```

## UUAPI 原文

`function.arguments` 在电线上是 **JSON 字符串**，还没 parse。

```json
{
  "id": "chatcmpl_01",
  "object": "chat.completion",
  "model": "gemini-3.7-flash",
  "choices": [
    {
      "index": 0,
      "finish_reason": "tool_calls",
      "message": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "call_01",
            "type": "function",
            "function": {
              "name": "continueTask",
              "arguments": "{\"task\":\"查当前页这款罗技 MX Master 3S 的官网价，并和当前页标价核对。\",\"choice\":[],\"turnMemory\":[\"用户要查当前页鼠标的官网价\"],\"conversationMemory\":[],\"projectMemory\":[],\"contextSummary\":{\"page\":\"罗技 MX Master 3S 无线鼠标\",\"url\":\"https://item.jd.com/100012345678.html\"}}"
            }
          }
        ]
      }
    }
  ]
}
```

| 电线字段 | 值（本轮） |
|---|---|
| `choices[0].finish_reason` | `tool_calls`（纯正文是 `stop`） |
| `choices[0].message.content` | `null`（有 tool_calls 时） |
| `choices[0].message.tool_calls[0].id` | `call_01` |
| `choices[0].message.tool_calls[0].function.name` | `continueTask` |
| `choices[0].message.tool_calls[0].function.arguments` | JSON **字符串** |

## 模型交口（解析后）

| 电线 | → 交口 |
|---|---|
| `choices[0].finish_reason` | `finish` |
| `choices[0].message.content` | `content` |
| `tool_calls[].id` | `toolCalls[].id` |
| `tool_calls[].function.name` | `toolCalls[].name` |
| `tool_calls[].function.arguments` 字符串 JSON.parse | `toolCalls[].arguments` 对象 |

```json
{
  "stage": "provider-response",
  "conversationId": "cv_01",
  "turnId": "tn_01",
  "provider": "uuapi",
  "model": "gemini-3.7-flash",
  "finish": "tool_calls",
  "content": null,
  "toolCalls": [
    {
      "id": "call_01",
      "name": "continueTask",
      "arguments": {
        "task": "查当前页这款罗技 MX Master 3S 的官网价，并和当前页标价核对。",
        "choice": [],
        "turnMemory": [
          "用户要查当前页鼠标的官网价"
        ],
        "conversationMemory": [],
        "projectMemory": [],
        "contextSummary": {
          "page": "罗技 MX Master 3S 无线鼠标",
          "url": "https://item.jd.com/100012345678.html"
        }
      }
    }
  ]
}
```

| 字段 | 类型 | 谁填 | 怎么填 |
|---|---|---|---|
| `stage` | string | 固定 | `provider-response` |
| `finish` | string | Provider | `tool_calls` / `stop` / `error` |
| `content` | string \| null | 模型 | 有 tool_calls 时为 `null` |
| `toolCalls` | object[] | Provider | `id` `name` `arguments`（已 parse） |

`continueTask.arguments` 必须有 `task`。`askUser.arguments` 必须有 `choice`。本轮只交一个常驻工具。

`toolCalls[0].arguments` 本轮字段：

| 字段 | 类型 | 本轮 |
|---|---|---|
| `task` | string | 查当前页这款罗技 MX Master 3S 的官网价，并和当前页标价核对。 |
| `choice` | string[] | `[]`（continueTask 时空） |
| `turnMemory` | string[] | 这一轮要记下的 |
| `conversationMemory` | string[] | `[]` |
| `projectMemory` | string[] | `[]` |
| `contextSummary` | object | 排除三层记忆的汇总 |

## 字段

上一份已有、本份原样带上：04 写出的全部键。

本环节新增 / 改写：

| 字段 | 类型 | 谁填 | 怎么填 |
|---|---|---|---|
| `stage` | string | 固定 | `provider-response` |
| `finish` | string | Provider | 见上 |
| `content` | string \| null | 模型 | 见上 |
| `toolCalls` | object[] | Provider | 见上 |

## 写出的（累积快照）

```json
{
  "stage": "provider-response",
  "conversationId": "cv_01",
  "turnId": "tn_01",
  "userInput": "帮我查这款鼠标官网价",
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
    "continueTask",
    "askUser"
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
    "#user字段说明",
    "#skill",
    "#sop"
  ],
  "userSlots": [
    "#projectMemory",
    "#conversationMemory",
    "#turnMemory",
    "#contextSummary",
    "#currentTask",
    "#userInput",
    "#currentEnvironment",
    "#tools"
  ],
  "provider": "uuapi",
  "model": "gemini-3.7-flash",
  "finish": "tool_calls",
  "content": null,
  "toolCalls": [
    {
      "id": "call_01",
      "name": "continueTask",
      "arguments": {
        "task": "查当前页这款罗技 MX Master 3S 的官网价，并和当前页标价核对。",
        "choice": [],
        "turnMemory": [
          "用户要查当前页鼠标的官网价"
        ],
        "conversationMemory": [],
        "projectMemory": [],
        "contextSummary": {
          "page": "罗技 MX Master 3S 无线鼠标",
          "url": "https://item.jd.com/100012345678.html"
        }
      }
    }
  ]
}
```

下一份：Runtime 按 `toolCalls[0].name` 执行。本轮是 `continueTask`，落 goal/task，进 LOOP。
