# 04 Provider 入参

读 03 的写出。Provider 把插槽拼成 **Chat Completions POST body**，转发 UUAPI。传出另见 `05-provider-response.md`。

怎么看：
- 「读到的」是 03 写出的原样
- 「怎么拼」是这一次真正发出去的参数：`model` + `messages` + `tools` + `stream`
- 「写出的」累积快照追加 `provider` `model` `stream` `maxAttempts`。交口在下一份

作者是 Provider。不装配、不跑工具、不落盘。key 在请求头，不进 body。

本轮 intake 材料够，预期模型交 `continueTask`。传出字段在 05。

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

body 四个键：`model`、`messages`、`tools`、`stream`。

```json
{
  "model": "gemini-3.7-flash",
  "stream": true,
  "messages": [
    { "role": "system", "content": "<下面 system 正文>" },
    { "role": "user", "content": "<下面 user 正文>" }
  ],
  "tools": "<下面 tools 数组>"
}
```

SDK 写法：`client.chat.completions.create({ model, messages, tools, stream: true })`。不是 Responses，不是扩展直连 UUAPI。

## 流式

`stream: true`。响应是 SSE：每行 `data: {chunk}`，最后 `data: [DONE]`。Provider 把分片拼成一份交口，字段见 05。中途断了当这次失败，整单重试，不从半截续。

## 兜底重试

同一份 body 最多打 **3 次**（含第一次）。

| | |
|---|---|
| 重试 | 网络断开、超时、5xx、429 |
| 不重试 | 4xx（除 429）、key 无效、请求体不合法 |
| 间隔 | 失败后等 1s 再打；第 3 次仍失败 → `finish=error` 交给 Runtime |

已收到完整 `[DONE]` 不算失败，不重试。

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

来源：`#身份`…`#输出` `#user字段说明` ← `catalog/packs/pack.agent.md`；`#skill` ← `catalog/skills/skill.web.md`；`#sop` ← `catalog/sops/sop.browse.md`。

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

## 字段

上一份已有、本份原样带上：03 写出的全部键。

本环节新增 / 改写：

| 字段 | 类型 | 谁填 | 怎么填 |
|---|---|---|---|
| `stage` | string | 固定 | `provider-request` |
| `provider` | string | 配置 | `uuapi` |
| `model` | string | 配置 | `gemini-3.7-flash` |
| `stream` | boolean | 固定 | `true`，SSE |
| `maxAttempts` | number | 固定 | `3`（含首次） |

## 写出的（累积快照）

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

下一份 `05-provider-response.md`：UUAPI 原文 + 解析后的交口。
