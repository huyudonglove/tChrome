# 03 解码

读 02 的写出。按 `catalog/` 把 ID 展开成**插槽**。JSON 里不写带换行的长字符串。

怎么看：

- 「读到的」是 02 写出的原样
- 「system 插槽」每个 `#标题` 单独一段，正文来自 catalog
- 「user 插槽」每个 `#块` 单独一段
- 「写出的」JSON 只留插槽名、短值和 `tools[]`（薄 schema，用法在 Pack）
- 出网时 Runtime 按插槽顺序拼成 `system` / `user` 字符串；文档里不写那份难读的串

## 读到的（02 写出的）

```json
{
  "stage": "context-engineering-input",
  "conversationId": "cv_01",
  "turnId": "tn_01",
  "userInput": "帮我查这款鼠标官网价",
  "submittedAt": "2026-09-05T08:00:01.000Z",
  "systemIds": ["pack.agent"],
  "skillIds": ["skill.web"],
  "sopIds": ["sop.browse"],
  "toolIds": ["continueTask", "askUser", "web.search"],
  "memoryIds": [],
  "mcpIds": [],
  "currentPage": {
    "tab": 12,
    "url": "https://item.jd.com/100012345678.html",
    "title": "罗技 MX Master 3S 无线鼠标"
  }
}
```

## catalog 取出

| ID             | 文件                              | 贡献的插槽                                                                    |
| -------------- | --------------------------------- | ----------------------------------------------------------------------------- |
| `pack.agent`   | `catalog/packs/pack.agent.md`     | `#身份`, `#记忆`, `#环境`, `#原则`, `#传入参数`, `#内置工具`, `#user字段说明` |
| `skill.web`    | `catalog/skills/skill.web.md`     | `#skill.web`                                                                  |
| `sop.browse`   | `catalog/sops/sop.browse.md`      | `#sop.browse`                                                                 |
| `continueTask` | `catalog/tools/continueTask.json` | `tools[]` 薄 schema                                                           |
| `askUser`      | `catalog/tools/askUser.json`      | `tools[]` 薄 schema                                                           |
| `web.search`   | `catalog/tools/web.search.json`   | `tools[]` 薄 schema                                                           |

`memoryIds` / `mcpIds` 空，不加插槽。`tools[]` 只留 `name`、类型、`required`。何时用写在 Pack `#原则` / `#传入参数`。

## system 插槽

顺序 = `systemSlots` 数组。改正文去改 catalog 文件。

### `#身份`

你是 tChrome 浏览器助手。当前在一个会话窗口里。层级：project → conversation → turn。

### `#记忆`

三层记忆：turnMemory、conversationMemory、projectMemory。

### `#环境`

Chrome、JavaScript、HTML、CSS。

### `#原则`

查看输入信息是否完整。完整就调用 continueTask。不完整就调用 askUser。两个方法互斥。搜集相关信息直到不影响下一步。

### `#传入参数`

task：任务；askUser 时为空。
choice：askUser 时的选项。
turnMemory：这一轮要存下的记忆。
conversationMemory：整个会话记忆。
projectMemory：项目记忆。
contextSummary：user 里带给下一轮的汇总，排除记忆。

    {
      "task": "",
      "choice": [],
      "turnMemory": [],
      "conversationMemory": [],
      "projectMemory": [],
      "contextSummary": {}
    }

### `#内置工具`

规划。
本地文件操作：读取目录。

### `#user字段说明`

记忆写在 `#projectMemory` `#conversationMemory` `#turnMemory`。
上次会话总结写在 `#contextSummary`。
当前任务写在 `#currentTask`。
当前用户输入写在 `#userInput`。
当前环境写在 `#currentEnvironment`。
`#tools` 只写本轮额外要点。常驻工具 continueTask / askUser 的用法在本 Pack。

报错说明：提示格式错误时，检查工具调用格式。

### `#skill.web`

查网页价格时，打开商品页，核对官网价和当前页标价。

### `#sop.browse`

1. 认当前页是不是目标商品
2. 打开官网或权威标价页
3. 把价格写进观察

## user 插槽

顺序 = `userSlots` 的键序。intake 还没有独立 task，`#currentTask` 空；用户原话进 `#userInput`；当前页进 `#currentEnvironment`。`#tools` 只写本轮额外要点，本轮空。

### `#projectMemory`

（空）

### `#conversationMemory`

（空）

### `#turnMemory`

（空）

### `#contextSummary`

（空）

### `#currentTask`

（空）

### `#userInput`

帮我查这款鼠标官网价

### `#currentEnvironment`

```json
{
  "tab": 12,
  "url": "https://item.jd.com/100012345678.html",
  "title": "罗技 MX Master 3S 无线鼠标"
}
```

### `#tools`

（空）

## 字段

上一份已有、本份原样带上：`conversationId` `turnId` `userInput` `submittedAt` `systemIds` `skillIds` `sopIds` `toolIds` `memoryIds` `mcpIds` `currentPage`。

本环节新增 / 改写：

| 字段          | 类型     | 谁填      | 怎么填                                         |
| ------------- | -------- | --------- | ---------------------------------------------- |
| `stage`       | string   | 固定      | `context-engineering-decode`                   |
| `systemSlots` | string[] | 装配器    | system 插槽名，按这个顺序拼                    |
| `userSlots`   | object   | 装配器    | key 是 `#块` 名；值是短字符串或对象；空块 `""` |
| `tools`       | object[] | 工具 JSON | 薄 schema，与 `toolIds` 各文件一致             |

出网拼法：`system` = 各 system 插槽「`#名` + 正文」按序拼接；`user` = 每个 `#块名` + 换行 + 正文（对象先格式化成行）。

## 写出的（累积快照）

```json
{
  "stage": "context-engineering-decode",
  "conversationId": "cv_01",
  "turnId": "tn_01",
  "userInput": "帮我查这款鼠标官网价",
  "submittedAt": "2026-09-05T08:00:01.000Z",
  "systemIds": ["pack.agent"],
  "skillIds": ["skill.web"],
  "sopIds": ["sop.browse"],
  "toolIds": ["continueTask", "askUser", "web.search"],
  "memoryIds": [],
  "mcpIds": [],
  "currentPage": {
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
    "#skill.web",
    "#sop.browse"
  ],
  "userSlots": {
    "#projectMemory": "",
    "#conversationMemory": "",
    "#turnMemory": "",
    "#contextSummary": "",
    "#currentTask": "",
    "#userInput": "帮我查这款鼠标官网价",
    "#currentEnvironment": {
      "tab": 12,
      "url": "https://item.jd.com/100012345678.html",
      "title": "罗技 MX Master 3S 无线鼠标"
    },
    "#tools": ""
  },
  "tools": [
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
          "required": ["task"]
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
          "required": ["choice"]
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
          "required": ["query"]
        }
      }
    }
  ]
}
```

下一份：LLM 吃按插槽拼好的窗口。
