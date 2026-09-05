# 04 Provider

读 03 的写出。Provider 把插槽拼成 **Chat Completions POST body**，转发 UUAPI，把回来的 `tool_calls` 收成 Runtime 认的结构。

怎么看：
- 「读到的」是 03 写出的原样
- 「怎么拼」是这一次真正发出去的参数：`model` + `messages` 两段正文 + `tools` schema
- 「模型交口」是认过的结构
- 「写出的」累积快照只追加本环节键

作者是 Provider。不装配、不跑工具、不落盘。key 在请求头，不进 body。

本轮 intake 材料够，模拟交 `continueTask`。

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

## 怎么拼这一次请求

```
POST https://uuapi.net/v1/chat/completions
Authorization: Bearer $UUAPI_API_KEY
Content-Type: application/json
```

body 三个键：`model`、`messages`、`tools`。

```json
{
  "model": "gemini-3.7-flash",
  "messages": [
    { "role": "system", "content": "<下面 system 正文>" },
    { "role": "user", "content": "<下面 user 正文>" }
  ],
  "tools": "<下面 tools 数组>"
}
```

SDK 写法：`client.chat.completions.create({ model, messages, tools })`。不是 Responses，不是扩展直连 UUAPI。

### `messages[0]` system

按 `systemSlots` 顺序：每个名字单独一行，下面跟 catalog 里该节正文。空节只留名字。

```
#身份
你是 tChrome 浏览器助手。当前在一个会话窗口里。层级：project → conversation → turn。

#记忆
三层记忆，从稳到新：projectMemory → conversationMemory → turnMemory。
projectMemory：整个项目共用，跨会话仍在。
conversationMemory：这一次会话里确认过的事实。
turnMemory：这一轮刚记下的，下一轮并进 conversationMemory。
读：user 的 `#projectMemory` `#conversationMemory` `#turnMemory`。
写：通过 continueTask / askUser 的同名参数交回来，Runtime 落盘。

#环境
Chrome、JavaScript、HTML、CSS。

#原则
查看输入信息是否完整。完整就调用 continueTask。不完整就调用 askUser。两个方法互斥。搜集相关信息直到不影响下一步。

#参数说明
task：当前任务；askUser 时为空。
choice：askUser 时给用户的选项；continueTask 时为空。
turnMemory：这一轮要存下的记忆。
conversationMemory：要写入会话层的记忆。
projectMemory：要写入项目层的记忆。
contextSummary：user 里带给下一轮的汇总，排除三层记忆。

    {
      "task": "",
      "choice": [],
      "turnMemory": [],
      "conversationMemory": [],
      "projectMemory": [],
      "contextSummary": {}
    }

#内置工具
常驻：continueTask、askUser。每轮都在出网 tools[] 里。用法见 #原则、#参数说明。
动态工具本轮才挂上，用法写在 user `#tools`。

#user字段说明
记忆写在 `#projectMemory` `#conversationMemory` `#turnMemory`。
上次会话总结写在 `#contextSummary`。
当前任务写在 `#currentTask`。
当前用户输入写在 `#userInput`。
当前环境写在 `#currentEnvironment`。
常驻工具 continueTask / askUser 的用法写在本 Pack。动态工具的用法写在 user `#tools`。

报错说明：提示格式错误时，检查工具调用格式。

#skill
查网页价格时，打开商品页，核对官网价和当前页标价。

#sop
1. 认当前页是不是目标商品
2. 打开官网或权威标价页
3. 把价格写进观察
```

来源：`#身份`…`#user字段说明` ← `catalog/packs/pack.agent.md`；`#skill` ← `catalog/skills/skill.web.md`；`#sop` ← `catalog/sops/sop.browse.md`。

### `messages[1]` user

按 `userSlots` 顺序。空槽只留标题。`#currentEnvironment` 是 `currentPage` 格式化后的 JSON。

```
#projectMemory

#conversationMemory

#turnMemory

#contextSummary

#currentTask

#userInput
帮我查这款鼠标官网价

#currentEnvironment
{
  "description": "当前页面信息",
  "tab": 12,
  "url": "https://item.jd.com/100012345678.html",
  "title": "罗技 MX Master 3S 无线鼠标"
}

#tools
```

### `tools`

`baseToolsIds` + `toolIds` → 按名读 `catalog/tools/<id>.json`，原样放进数组。协议要完整 schema，不能只传名字。

```json
[
  {
    "type": "function",
    "function": {
      "name": "continueTask",
      "parameters": {
        "type": "object",
        "properties": {
          "task": {
            "type": "string"
          },
          "choice": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "turnMemory": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "conversationMemory": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "projectMemory": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "contextSummary": {
            "type": "object"
          }
        },
        "required": [
          "task"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "askUser",
      "parameters": {
        "type": "object",
        "properties": {
          "task": {
            "type": "string"
          },
          "choice": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "turnMemory": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "conversationMemory": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "projectMemory": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "contextSummary": {
            "type": "object"
          }
        },
        "required": [
          "choice"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "web.search",
      "parameters": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string"
          }
        },
        "required": [
          "query"
        ]
      }
    }
  }
]
```

顺序：`continueTask`、`askUser`（常驻）、`web.search`（动态）。description 不写，用法在 system Pack。

## 模型交口

UUAPI 回来是 `choices[0].message.tool_calls`。`function.arguments` 是 JSON 字符串，Provider 解析后再交给 Runtime。

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

`continueTask` 必须有 `task`。`askUser` 必须有 `choice`。本轮只交一个常驻工具。

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
