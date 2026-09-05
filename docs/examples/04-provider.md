# 04 Provider

读 03 的写出。Provider 是电线：把插槽拼成 Chat Completions 请求，转发 UUAPI，把模型交口收成 `ModelResponse`。

怎么看：
- 「读到的」是 03 写出的原样
- 「出网请求」是 Runtime 拼好、Provider 发出的 body（`messages` 正文在插槽里，这份 JSON 只标从哪取）
- 「模型交口」是 UUAPI 回来之后、Runtime 认过的结构
- 「写出的」累积快照只追加本环节键，不把 schema / 长字符串再塞一遍

作者是 Provider。不装配、不跑工具、不落盘。key 在服务 `.env` 的 `UUAPI_API_KEY`。

本轮 intake 材料够（当前页 + 用户要查官网价），模拟交 `continueTask`，不交 `askUser`。

## 读到的（03 写出的）

```json
{
  "stage": "context-engineering-decode",
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
  ]
}
```

## 出网

| 项 | 值 |
|---|---|
| 协议 | OpenAI Chat Completions |
| 地址 | `https://uuapi.net/v1/chat/completions` |
| SDK | 官方 `openai` 的 `chat.completions` |
| 模型 | `gemini-3.7-flash` |
| `messages` | `system` = 按 `systemSlots` 拼；`user` = 按 `userSlots` 拼 |
| `tools` | `baseToolsIds` + `toolIds` 对应的 `catalog/tools/<id>.json` |

`tools[]` 必须带完整 schema，只传名字协议不认。用法仍在 Pack / user `#tools`，不写进 schema 的 description。

### ProviderRequest（文档层）

```json
{
  "stage": "provider-request",
  "provider": "uuapi",
  "baseURL": "https://uuapi.net/v1",
  "path": "/chat/completions",
  "model": "gemini-3.7-flash",
  "conversationId": "cv_01",
  "turnId": "tn_01",
  "messages": [
    {
      "role": "system",
      "from": "systemSlots"
    },
    {
      "role": "user",
      "from": "userSlots"
    }
  ],
  "toolNames": [
    "continueTask",
    "askUser",
    "web.search"
  ]
}
```

`from` 表示正文从 03 的名列表取，不在这份 JSON 里重复长字符串。

### 出网 tools 名

`continueTask / askUser / web.search`，schema 见 `catalog/tools/`。

## 模型交口

Chat Completions 回来是 `choices[0].message.tool_calls`。Provider 收成下面这份，Runtime 只认这个。

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
| `toolCalls` | object[] | Provider 从 wire 解析 | `id` `name` `arguments`（arguments 已 JSON.parse） |

`continueTask` 的 `arguments` 必须含 `task`。`askUser` 必须含 `choice`。本轮互斥：只交一个常驻工具。

## 字段

上一份已有、本份原样带上：03 写出的全部键。

本环节新增 / 改写：

| 字段 | 类型 | 谁填 | 怎么填 |
|---|---|---|---|
| `stage` | string | 固定 | `provider` |
| `provider` | string | 配置 | `uuapi` |
| `model` | string | 配置 | `gemini-3.7-flash` |
| `finish` | string | Provider | 见上 |
| `content` | string \| null | 模型 | 见上 |
| `toolCalls` | object[] | Provider | 见上 |

## 写出的（累积快照）

```json
{
  "stage": "provider",
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
