# 05 Provider 传出

读 04 的写出。记录这一次 UUAPI **传出**：先 SSE 原文，再收成 Runtime 认的交口。

怎么看：
- 「读到的」是 04 写出的原样（`stream=true`，最多 3 次）
- 「SSE 原文」是 `stream: true` 时一行行 `data:`
- 「模型交口」是 Provider 把分片拼完、JSON.parse 参数之后，Runtime 只认这份
- 「写出的」累积快照追加 `finish` `content` `toolCalls` `attempts` `parseOk` `schemaOk` `faultCode` `missing`

作者是 Provider。不跑工具、不落盘。`usage` / 响应 `id` / `object` 不进交口。

本轮第 1 次就收到完整 `[DONE]`，交 `continueTask`，不交 `askUser`。

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
  "model": "gemini-3.7-flash",
  "stream": true,
  "maxAttempts": 3
}
```

## SSE 原文

`stream: true` 时没有整份 JSON body，是：

```
data: {chunk}

data: {chunk}

data: [DONE]
```

本轮三次分片（工具名 → 参数字符串 → finish），然后 DONE：

```
data: {"id":"chatcmpl_01","object":"chat.completion.chunk","model":"gemini-3.7-flash","choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_01","type":"function","function":{"name":"continueTask","arguments":""}}]},"finish_reason":null}]}

data: {"id":"chatcmpl_01","object":"chat.completion.chunk","model":"gemini-3.7-flash","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"task\":\"查当前页这款罗技 MX Master 3S 的官网价，并和当前页标价核对。\",\"choice\":[],\"turnMemory\":[\"用户要查当前页鼠标的官网价\"],\"conversationMemory\":[],\"projectMemory\":[],\"contextSummary\":{\"page\":\"罗技 MX Master 3S 无线鼠标\",\"url\":\"https://item.jd.com/100012345678.html\"}}"}}]},"finish_reason":null}]}

data: {"id":"chatcmpl_01","object":"chat.completion.chunk","model":"gemini-3.7-flash","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}

data: [DONE]
```

| 分片 | 带来什么 |
|---|---|
| 第 1 片 | `delta.tool_calls[0].id` = `call_01`，`function.name` = `continueTask` |
| 第 2 片 | `delta.tool_calls[0].function.arguments` 追加 JSON **字符串** |
| 第 3 片 | `finish_reason` = `tool_calls` |
| `[DONE]` | 流结束。没收到这一行 = 这次失败，整单重试 |

中途断开不当半截成功。拼起来的 `arguments` 字符串再 `JSON.parse` 成对象。

## 容错

分两条线。Provider **不替模型改 JSON**（不是代码补全）。

### A. 线路失败（同一 body 再打，最多 3 次）

网络 / 超时 / 5xx / 429 / 流被掐 / SSE 某条 `data:` 不是 JSON。不经过模型。

### B. 交口失败（把错误类型回给模型再交，同一 turn 最多 3 次）

`arguments` 不是 JSON、缺 required、未知工具、常驻互斥。判定之后写成一条 **tool 结果** 再出网，让模型按 `faultCode` 重交。3 次仍坏才 `finish=error`。

`faultCode`：

| `faultCode` | 何时 |
|---|---|
| `arguments_not_json` | 拼好的 `function.arguments` 字符串 `JSON.parse` 失败 |
| `unknown_tool` | `name` 不在 `baseToolsIds` + `toolIds` |
| `missing_required` | catalog `required` 缺或空；`missing` 列出字段名 |
| `wrong_type` | Ajv：类型对不上 schema |
| `exclusive_resident` | `continueTask` 和 `askUser` 同时交 |

回给模型的 tool 结果（`role=tool`，`tool_call_id` 用这次的 `call_01`）：

```json
{
  "ok": false,
  "faultCode": "missing_required",
  "missing": ["task"],
  "toolName": "continueTask"
}
```

`arguments_not_json` 时没有对象可查缺，`missing` 为 `[]`，`detail` 写 parse 报错原文。

落地查缺用 **Ajv** 对 `catalog/tools/<name>.json` 的 `function.parameters`。解析用 Bun `JSON.parse`。

本轮一次过：

```json
{
  "parseOk": true,
  "schemaOk": true,
  "faultCode": null,
  "toolName": "continueTask",
  "required": ["task"],
  "missing": []
}
```


## 模型交口（解析后）

| SSE | → 交口 |
|---|---|
| 最后一片 `finish_reason` | `finish` |
| 各片 `delta.content` 拼起来；本轮没有 | `content` = `null` |
| 第 1 片 `tool_calls[].id` | `toolCalls[].id` |
| 第 1 片 `function.name` | `toolCalls[].name` |
| 各片 `function.arguments` 字符串拼接后 JSON.parse | `toolCalls[].arguments` 对象 |

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

3 次都失败时交口是 `finish=error`，`content` 写失败原因，`toolCalls=[]`。本轮不是这种情况。

## 字段

上一份已有、本份原样带上：04 写出的全部键（含 `stream` `maxAttempts`）。

本环节新增 / 改写：

| 字段 | 类型 | 谁填 | 怎么填 |
|---|---|---|---|
| `stage` | string | 固定 | `provider-response` |
| `finish` | string | Provider | 见上 |
| `content` | string \| null | 模型 | 见上 |
| `toolCalls` | object[] | Provider | 见上 |
| `attempts` | number | Provider | 实际打了几次，本轮 `1` |
| `parseOk` | boolean | Provider | SSE chunk 和 `arguments` 字符串是否都 parse 成功 |
| `schemaOk` | boolean | Provider | required / 白名单 / 互斥 / 类型是否过 |
| `faultCode` | string \| null | Provider | 交口失败的精确类型；本轮 `null` |
| `missing` | string[] | Provider | `missing_required` 时的字段名；本轮 `[]` |

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
  "stream": true,
  "maxAttempts": 3,
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
  ],
  "attempts": 1,
  "parseOk": true,
  "schemaOk": true,
  "faultCode": null,
  "missing": []
}
```

下一份：Runtime 按 `toolCalls[0].name` 执行。本轮是 `continueTask`，落 goal/task，进 LOOP。
