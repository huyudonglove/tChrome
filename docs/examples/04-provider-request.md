# 04 Provider 入参

读 03 的写出。Provider 把插槽拼成 **Chat Completions POST body**，转发 UUAPI。传出另见 `05-provider-response.md`。

怎么看：

- 「读到的」是 03 写出的原样
- 「怎么拼」是这一次真正发出去的参数：`model` + `messages` + `tools` + `stream`
- 「写出的」累积快照追加 `provider` `model` `stream` `maxAttempts`。交口在下一份

作者是 Provider。不装配、不跑工具、不落盘。key 在请求头，不进 body。

本轮材料够，预期模型交 `web_search`。传出字段在 05。

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
  "baseToolsIds": [
    "askUser",
    "finishTurn",
    "submitGoal",
    "tool.detail",
    "observation.detail",
    "memory.write",
    "notes.write",
    "notes.delete"
  ],
  "toolIds": [
    "page.get_summary",
    "open_url",
    "web_search"
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
    "#协议",
    "#目标",
    "#参数说明",
    "#内置工具",
    "#输出",
    "#user槽"
  ],
  "userSlots": [
    "#skill",
    "#projectMemory",
    "#conversationMemory",
    "#turnMemory",
    "#contextSummary",
    "#observation",
    "#notes",
    "#userInputHistory",
    "#userInput",
    "#goal",
    "#goalHistory",
    "#currentTab",
    "#currentPage",
    "#toolIO",
    "#baseTools",
    "#tools"
  ]
}
```

## 怎么拼这一次请求

```
POST https://uuapi.net/v1/chat/completions
Authorization: Bearer ***
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
你是 tChrome 浏览器助手。会话层级是 project、conversation、turn。

#记忆
三层记忆：projectMemory、conversationMemory、turnMemory。windowChars 达到 compressAt（200000）时 Runtime 压缩 conversationMemory 和 turnMemory。

#观察
user `#observation` 是 Runtime 在 windowChars 达到 compressAt（200000）时从 toolIO 收成的摘要。

#环境
运行环境是 Chrome、JavaScript、HTML、CSS。

#协议
一次出网的 tool_calls 由 Runtime 按数组顺序执行。finishTurn 执行后本 Turn status=completed。
user 槽是参考材料。

#目标
ledger.goal 是当前目标。submitGoal 的 goal 写入 ledger.goal。ledger.goalHistory 是被替换掉的旧 goal 数组。模型不写 ledger.goalHistory。

#参数说明
每个工具调用带 reason。affectsPage 为 true 时该调用改变当前页；为 false 时该调用只读。

#内置工具
baseToolsIds：askUser、finishTurn、submitGoal、tool.detail、observation.detail、memory.write。coreToolIds 开 Turn 挂上。user `#baseTools` 写 baseToolsIds 的用法。user `#tools` 写 toolIds 的用法。

#输出
content 三段：seen / reason / action。

#user槽
user 按层装配。空槽只留标题。
##方法：`#skill`
##记忆：`#projectMemory` `#conversationMemory` `#turnMemory` `#contextSummary` `#observation` `#notes`
##输入：`#userInputHistory` `#userInput`
##目标：`#goal` `#goalHistory`
##页面：`#currentTab` `#currentPage`
##过程：`#toolIO`
##工具：`#baseTools` `#tools`
```

正文以 `catalog/packs/pack.agent.md` 为准。skill / 建议路径不进 system。

### `messages[1]` user

按 `window.user.md` 层顺序。层内是参考槽。空槽只留标题。

```
##方法
#skill
网页工具：page.get_summary 读摘要；page.list_regions 列区域；page.list_interactive_elements 列可交互元素；page.click / page.type 用返回的 id；open_url 打开网址；web_search 检索。

##记忆
#projectMemory

#conversationMemory

#turnMemory

#contextSummary

#observation
[]

#notes
{}

##输入
#userInputHistory

#userInput
帮我查这款鼠标官网价

##目标
#goal

#goalHistory
[]

##页面
#currentTab

#currentPage

##过程
#toolIO
[]

##工具
#baseTools
askUser：向用户提问。入参：choice。返回：用户选项。affectsPage=false。
finishTurn：结束本 Turn。入参：无。content 的 action 是对用户说的话。affectsPage=false。
submitGoal：写入 ledger.goal。入参：goal。返回：当前目标。affectsPage=false。
tool.detail：展开 toolIO 截断全文。入参：callId。affectsPage=false。
observation.detail：展开 observation 全文。入参：observationId。affectsPage=false。
memory.write：写入记忆。入参：可选 turnMemory、conversationMemory、projectMemory、contextSummary。affectsPage=false。
notes.write：写入或覆盖 ledger.notes[key]。入参：key、value。affectsPage=false。
notes.delete：删除 ledger.notes[key]。入参：key。affectsPage=false。

#tools
page.get_summary：读当前页摘要：标题、地址、区域数、可交互数、标题列表。affectsPage=false。
open_url：打开指定网址并读回标题正文。affectsPage=true。
web_search：搜索公开网页。affectsPage=false。
其余动态工具见 `catalog/tools/index.json`。
```

### `tools`

出网 `tools[]` = `baseToolsIds` + `toolIds` 的 catalog schema。Chat Completions 要完整 schema。每个工具 `arguments` 都带 `reason` 和 `affectsPage`。本轮动态工具全表在 `catalog/tools/index.json`，下面只列本样例用到的 `page.get_summary` `open_url` `web_search`。

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
      "name": "page.get_summary",
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
      "name": "open_url",
      "parameters": {
        "type": "object",
        "properties": {
          "reason": {
            "type": "string"
          },
          "affectsPage": {
            "type": "boolean"
          },
          "url": {
            "type": "string"
          }
        },
        "required": [
          "reason",
          "affectsPage",
          "url"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "web_search",
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
  "baseToolsIds": [
    "askUser",
    "finishTurn",
    "submitGoal",
    "tool.detail",
    "observation.detail",
    "memory.write",
    "notes.write",
    "notes.delete"
  ],
  "toolIds": [
    "page.get_summary",
    "open_url",
    "web_search"
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
    "#协议",
    "#目标",
    "#参数说明",
    "#内置工具",
    "#输出",
    "#user槽"
  ],
  "userSlots": [
    "#skill",
    "#projectMemory",
    "#conversationMemory",
    "#turnMemory",
    "#contextSummary",
    "#observation",
    "#notes",
    "#userInputHistory",
    "#userInput",
    "#goal",
    "#goalHistory",
    "#currentTab",
    "#currentPage",
    "#toolIO",
    "#baseTools",
    "#tools"
  ],
  "provider": "uuapi",
  "model": "gemini-3.7-flash",
  "stream": true,
  "maxAttempts": 3
}
```

下一份 `05-provider-response.md`：UUAPI 原文 + 解析后的交口。
