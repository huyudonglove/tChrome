# 03 解码

读 02 的写出。按 `catalog/` 把 ID 展开成**插槽**。JSON 里只留插槽名列表，不写带换行的长字符串，也不塞 tools schema。

怎么看：

- 「读到的」是 02 写出的原样
- 「system 插槽」每个 `#标题` 单独一段，正文来自 catalog
- 「user 插槽」每个 `#块` 单独一段，正文在这一页
- 「写出的」JSON：`systemSlots` / `userSlots` 都是名数组
- 出网时 Runtime 按名列表拼 `system` / `user`；按 `baseToolsIds` + `toolIds` 取 `catalog/tools/<id>.json` 填请求的 `tools[]`

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
  "baseToolsIds": ["continueTask", "askUser"],
  "toolIds": ["web.search"],
  "turnMemoryIds": [],
  "conversationMemoryIds": [],
  "projectMemoryIds": [],
  "mcpIds": [],
  "currentPage": {
    "tab": 12,
    "url": "https://item.jd.com/100012345678.html",
    "title": "罗技 MX Master 3S 无线鼠标"
  }
}
```

## catalog 取出

| ID                       | 文件                            | 贡献                                                                          |
| ------------------------ | ------------------------------- | ----------------------------------------------------------------------------- |
| `pack.agent`             | `catalog/packs/pack.agent.md`   | `#身份`, `#记忆`, `#环境`, `#原则`, `#参数说明`, `#内置工具`, `#user字段说明` |
| `skill.web`              | `catalog/skills/skill.web.md`   | `#skill`                                                                      |
| `sop.browse`             | `catalog/sops/sop.browse.md`    | `#sop`                                                                        |
| `continueTask` `askUser` | `catalog/tools/`                | 常驻，出网 tools[]                                                            |
| `web.search`             | `catalog/tools/web.search.json` | 动态，出网 tools[]                                                            |

三层记忆 ID 空，对应 user 三个记忆槽空。schema 不写进这份 JSON。

## system 插槽

顺序 = `systemSlots` 数组。改正文去改 catalog 文件。常驻工具用法在 Pack。

### `#身份`

你是 tChrome 浏览器助手。当前在一个会话窗口里。层级：project → conversation → turn。

### `#记忆`

三层记忆，从稳到新：projectMemory → conversationMemory → turnMemory。
projectMemory：整个项目共用，跨会话仍在。
conversationMemory：这一次会话里确认过的事实。
turnMemory：这一轮刚记下的，下一轮并进 conversationMemory。
读：user 的 `#projectMemory` `#conversationMemory` `#turnMemory`。
写：通过 continueTask / askUser 的同名参数交回来，Runtime 落盘。

### `#环境`

Chrome、JavaScript、HTML、CSS。

### `#原则`

查看输入信息是否完整。完整就调用 continueTask。不完整就调用 askUser。两个方法互斥。搜集相关信息直到不影响下一步。

### `#参数说明`

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

### `#内置工具`

常驻：continueTask、askUser。每轮都在出网 tools[] 里。用法见 #原则、#参数说明。
动态工具本轮才挂上，用法写在 user `#tools`。

### `#user字段说明`

记忆写在 `#projectMemory` `#conversationMemory` `#turnMemory`。
上次会话总结写在 `#contextSummary`。
当前任务写在 `#currentTask`。
当前用户输入写在 `#userInput`。
当前环境写在 `#currentEnvironment`。
常驻工具 continueTask / askUser 的用法写在本 Pack。动态工具的用法写在 user `#tools`。

报错说明：提示格式错误时，检查工具调用格式。

### `#skill`

查网页价格时，打开商品页，核对官网价和当前页标价。

### `#sop`

1. 认当前页是不是目标商品
2. 打开官网或权威标价页
3. 把价格写进观察

## user 插槽

顺序 = `userSlots` 数组。intake 还没有独立 task，`#currentTask` 空；用户原话进 `#userInput`；当前页进 `#currentEnvironment`。

常驻工具用法在 system（Pack）。动态工具用法在 `#tools`。本轮 `web.search` 的用法在 `#skill` / `#sop`，`#tools` 空。

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
  "description": "当前网页信息",
  "tab": 12,
  "url": "https://item.jd.com/100012345678.html",
  "title": "罗技 MX Master 3S 无线鼠标"
}
```

### `#tools`

（空）

## 字段

上一份已有、本份原样带上：`conversationId` `turnId` `userInput` `submittedAt` `systemIds` `skillIds` `sopIds` `baseToolsIds` `toolIds` `turnMemoryIds` `conversationMemoryIds` `projectMemoryIds` `mcpIds` `currentPage`。

本环节新增 / 改写：

| 字段          | 类型     | 谁填   | 怎么填                       |
| ------------- | -------- | ------ | ---------------------------- |
| `stage`       | string   | 固定   | `context-engineering-decode` |
| `systemSlots` | string[] | 装配器 | system 插槽名，按这个顺序拼  |
| `userSlots`   | string[] | 装配器 | user 插槽名，按这个顺序拼    |

出网拼法：按名列表取各插槽正文，拼成 `system` / `user`。出网 `tools[]` = `baseToolsIds` + `toolIds` 对应的 catalog schema。

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
  "baseToolsIds": ["continueTask", "askUser"],
  "toolIds": ["web.search"],
  "turnMemoryIds": [],
  "conversationMemoryIds": [],
  "projectMemoryIds": [],
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

下一份：LLM 吃按插槽拼好的窗口。
