# 04 Provider 入参

读 03 的写出。Provider 把插槽拼成 **Chat Completions POST body**，转发 UUAPI。传出另见 `05-provider-response.md`。

怎么看：

- 「读到的」是 03 写出的原样
- 「怎么拼」是这一次真正发出去的参数：`model` + `messages` + `tools` + `stream`
- 「写出的」累积快照追加 `provider` `model` `stream` `maxAttempts`。交口在下一份

作者是 Provider。不装配、不跑工具、不落盘。key 在请求头，不进 body。

本轮材料够，预期模型交 `web.search`。传出字段在 05。

## 读到的（03 写出的）

```json
{
  "stage": "context-engineering-decode",
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
    "tool.detail",
    "observation.detail",
    "memory.write"
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
    "#观察",
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
    "#observation",
    "#userInputHistory",
    "#userInput",
    "#currentEnvironment",
    "#toolIO",
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

body 四个键：`model`、`messages`、`tools`、`stream`。

```json
{
  "model": "gemini-3.7-flash",
  "stream": true,
  "messages": [
    {
      "role": "system",
      "content": "<下面 system 正文>"
    },
    {
      "role": "user",
      "content": "<下面 user 正文>"
    }
  ],
  "tools": "<下面 tools 数组>"
}
```

SDK 写法：`client.chat.completions.create({ model, messages, tools, stream: true })`。不是 Responses，不是扩展直连 UUAPI。

## 流式

`stream: true`。响应是 SSE：每行 `data: {chunk}`，最后 `data: [DONE]`。Provider 把分片拼成一份交口，字段见 05。中途断了当这次失败，整单重试，不从半截续。

## 兜底重试

同一份 body 最多打 **3 次**（含第一次）。

|        |                                                               |
| ------ | ------------------------------------------------------------- |
| 重试   | 网络断开、超时、5xx、429                                      |
| 不重试 | 4xx（除 429）、key 无效、请求体不合法                         |
| 间隔   | 失败后等 1s 再打；第 3 次仍失败 → `finish=error` 交给 Runtime |

已收到完整 `[DONE]` 不算失败，不重试。

### `messages[0]` system

按 `systemSlots` 顺序：每个名字单独一行，下面跟 catalog 里该节正文。空节只留名字。

```
#身份
你是 tChrome 浏览器助手。当前在一个会话窗口里。层级：project → conversation → turn。结合内容和记忆，判断工具调用。

#记忆
三层记忆，从稳到新：projectMemory → conversationMemory → turnMemory。
projectMemory：整个项目共用，跨会话仍在。
conversationMemory：这一次会话里确认过的事实。
turnMemory：这一轮刚记下的，下一轮并进 conversationMemory。
读：user 的 `#projectMemory` `#conversationMemory` `#turnMemory`。
写：调 memory.write。Runtime 落盘，下一次出网把落下的记忆带进对应 user 槽。
窗口到 200K 时 Runtime 压缩 turnMemory 和 conversationMemory：槽里只留压缩后的摘要。细节用 observation.detail，observationId 用 `#observation` 该项的 id。

#观察
`#observation` 是压缩过的事实。窗口到 200K 时 Runtime 把较早的 `#toolIO` 收成这些条目。每项是摘要，不是全文。要看具体事实，调 observation.detail，observationId 用该项的 id。

#环境
Chrome、JavaScript、HTML、CSS。

#原则
查看输入信息是否能支持后续判断。无意义就 finishTurn。信息不完整就 askUser。材料够就调动态工具干活。要存记忆就调 memory.write。
一次出网可交多个工具。交出去的顺序就是执行顺序，进任务队列按这个顺序跑。每个工具都标 affectsPage：这次会不会改当前页（跳转、点击、输入）。会改当前页的排在不会改的后面，避免后面的调用还对着旧页。finishTurn 放在本次出网最后一条。
`#toolIO` 某条 return.stage=truncated 时，调 tool.detail，callId 用那条的 callId，拿全文。
`#observation` 某条要展开时，调 observation.detail，observationId 用那条的 id。

#参数说明
每个工具调用必须带 reason：这次为什么调这个工具。
affectsPage：这次会不会改当前页。true 会改（跳转、点击、输入）；false 只读。按这个排执行顺序。
choice：askUser 时给用户的选项。
callId：tool.detail 时，要展开全文的那次工具调用 id，对应 `#toolIO` 该项的 callId。
observationId：observation.detail 时，要展开的那条压缩事实 id，对应 `#observation` 该项的 id。
turnMemory：memory.write 时，这一轮要存下的记忆。
conversationMemory：memory.write 时，要写入会话层的记忆。
projectMemory：memory.write 时，要写入项目层的记忆。
contextSummary：memory.write 时，user 里带给下一轮的汇总，排除三层记忆。

    {
      "reason": "",
      "affectsPage": false,
      "choice": [],
      "callId": "",
      "observationId": "",
      "turnMemory": [],
      "conversationMemory": [],
      "projectMemory": [],
      "contextSummary": {}
    }

#内置工具
常驻：askUser、finishTurn、tool.detail、observation.detail、memory.write。每轮都在出网 tools[] 里。用法见 #原则、#参数说明。
动态工具本轮才挂上，用法写在 user `#tools`。
每个工具的 arguments 都带 reason 和 affectsPage。

#输出
每次都写 `content`，三段，标题固定：

observation
<看见了什么>

reason
<为什么这么做>

action
<下一步：调哪个工具，或对用户说什么>

有 `tool_calls` 时这三段也要写。Runtime 不校验这段正文。

#user字段说明
记忆写在 `#projectMemory` `#conversationMemory` `#turnMemory`。这些槽来自此前 memory.write 落下的内容。下一次出网带上。窗口到 200K 时 Runtime 压缩 turnMemory 和 conversationMemory，槽里只留摘要。
上次会话总结写在 `#contextSummary`。
当前用户输入写在 `#userInput`。
历史用户输入写在 `#userInputHistory`。
当前环境写在 `#currentEnvironment`。
压缩过的事实写在 `#observation`：数组，每项 `{id, text, sourceCallIds}`。这是 Runtime 把较早的 tool history 收成的摘要。要看具体事实，调 observation.detail，observationId 用该项的 id。
工具调用和返回写在 `#toolIO`：数组，每项是一次调用的 callId、name、arguments、return。askUser、finishTurn、tool.detail、observation.detail、memory.write、动态工具都进这里。同一工具可出现多次。最新的在最下面。窗口到 200K 时较早的条目收进 `#observation`，`#toolIO` 只留最近未压缩的。
return.text 最多 2000 字。超出时 stage=truncated，只留前 2000 字，totalChars 写全文长度。要全文时调 tool.detail，参数 callId。
常驻工具 askUser / finishTurn / tool.detail / observation.detail / memory.write 的用法写在本 Pack。动态工具的用法写在 user `#tools`。

报错说明：提示格式错误时，检查工具调用格式。

#skill
查网页价格时，打开商品页，核对官网价和当前页标价。

#sop
1. 认当前页是不是目标商品
2. 打开官网或权威标价页
3. 把价格写入 #toolIO
```

### `messages[1]` user

按 `userSlots` 顺序。空槽只留标题。`#currentEnvironment` 是 `currentPage` 格式化后的 JSON。`#toolIO` 本轮还没有执行过的工具，写 `[]`。

```
#projectMemory

#conversationMemory

#turnMemory

#contextSummary

#observation
[]

#userInputHistory

#userInput
帮我查这款鼠标官网价

#currentEnvironment
{
  "description": "当前页面信息",
  "tab": 12,
  "url": "https://item.jd.com/100012345678.html",
  "title": "罗技 MX Master 3S 无线鼠标"
}

#toolIO
[]

#tools
```

### `tools`

出网 `tools[]` = `baseToolsIds` + `toolIds` 的 catalog schema。Chat Completions 要完整 schema。每个工具 `arguments` 都带 `reason` 和 `affectsPage`。

```json
[
  {
    "type": "function",
    "function": {
      "name": "askUser",
      "parameters": {
        "type": "object",
        "properties": {
          "reason": {
            "type": "string"
          },
          "affectsPage": {
            "type": "boolean"
          },
          "choice": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "required": [
          "reason",
          "affectsPage",
          "choice"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "finishTurn",
      "parameters": {
        "type": "object",
        "properties": {
          "reason": {
            "type": "string"
          },
          "affectsPage": {
            "type": "boolean"
          }
        },
        "required": [
          "reason",
          "affectsPage"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "tool.detail",
      "parameters": {
        "type": "object",
        "properties": {
          "reason": {
            "type": "string"
          },
          "affectsPage": {
            "type": "boolean"
          },
          "callId": {
            "type": "string"
          }
        },
        "required": [
          "reason",
          "affectsPage",
          "callId"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "observation.detail",
      "parameters": {
        "type": "object",
        "properties": {
          "reason": {
            "type": "string"
          },
          "affectsPage": {
            "type": "boolean"
          },
          "observationId": {
            "type": "string"
          }
        },
        "required": [
          "reason",
          "affectsPage",
          "observationId"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "memory.write",
      "parameters": {
        "type": "object",
        "properties": {
          "reason": {
            "type": "string"
          },
          "affectsPage": {
            "type": "boolean"
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
          "reason",
          "affectsPage"
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
          "reason": {
            "type": "string"
          },
          "affectsPage": {
            "type": "boolean"
          },
          "query": {
            "type": "string"
          }
        },
        "required": [
          "reason",
          "affectsPage",
          "query"
        ]
      }
    }
  }
]
```

## 字段

见 `docs/schema.md`「阶段快照」`provider-request`。

## 写出的（累积快照）

```json
{
  "stage": "provider-request",
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
    "tool.detail",
    "observation.detail",
    "memory.write"
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
    "#观察",
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
    "#observation",
    "#userInputHistory",
    "#userInput",
    "#currentEnvironment",
    "#toolIO",
    "#tools"
  ],
  "provider": "uuapi",
  "model": "gemini-3.7-flash",
  "stream": true,
  "maxAttempts": 3
}
```

下一份 `05-provider-response.md`：UUAPI 原文 + 解析后的交口。
