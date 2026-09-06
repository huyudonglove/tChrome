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
    "finishTurn"
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
  }
}
```

## catalog 取出

| ID                       | 文件                            | 贡献                                                                                   |
| ------------------------ | ------------------------------- | -------------------------------------------------------------------------------------- |
| `pack.agent`             | `catalog/packs/pack.agent.md`   | `#身份`, `#记忆`, `#环境`, `#原则`, `#参数说明`, `#内置工具`, `#输出`, `#user字段说明` |
| `skill.web`              | `catalog/skills/skill.web.md`   | `#skill`                                                                               |
| `sop.browse`             | `catalog/sops/sop.browse.md`    | `#sop`                                                                                 |
| `askUser`                | `catalog/tools/askUser.json`    | 常驻，出网 tools[]                                                                     |
| `web.search`             | `catalog/tools/web.search.json` | 动态，出网 tools[]                                                                     |

三层记忆 ID 空，对应 user 三个记忆槽空。schema 不写进这份 JSON。

## system 插槽

顺序 = `systemSlots` 数组。改正文去改 catalog 文件。常驻工具用法在 Pack。

### `#身份`
你是 tChrome 浏览器助手。当前在一个会话窗口里。层级：project → conversation → turn。结合内容和记忆，判断工具调用。

### `#记忆`
三层记忆，从稳到新：projectMemory → conversationMemory → turnMemory。
projectMemory：整个项目共用，跨会话仍在。
conversationMemory：这一次会话里确认过的事实。
turnMemory：这一轮刚记下的，下一轮并进 conversationMemory。
读：user 的 `#projectMemory` `#conversationMemory` `#turnMemory`。
写：通过工具同名参数交回来，Runtime 落盘。

### `#环境`
Chrome、JavaScript、HTML、CSS。

### `#原则`
查看输入信息是否能支持后续判断。无意义就 finishTurn。信息不完整就 askUser。材料够就调动态工具干活。askUser、finishTurn、动态工具本轮只交一类。搜集相关信息直到不影响下一步。

### `#参数说明`
每个工具调用必须带 reason：这次为什么调这个工具。
choice：askUser 时给用户的选项。
turnMemory：这一轮要存下的记忆。
conversationMemory：要写入会话层的记忆。
projectMemory：要写入项目层的记忆。
contextSummary：user 里带给下一轮的汇总，排除三层记忆。

    {
      "reason": "",
      "choice": [],
      "turnMemory": [],
      "conversationMemory": [],
      "projectMemory": [],
      "contextSummary": {}
    }

### `#内置工具`
常驻：askUser、finishTurn。每轮都在出网 tools[] 里。用法见 #原则、#参数说明。
动态工具本轮才挂上，用法写在 user `#tools`。
每个工具的 arguments 都带 reason。

### `#输出`
每次都写 `content`，三段，标题固定：

observation
<看见了什么>

reason
<为什么这么做>

action
<下一步：调哪个工具，或对用户说什么>

有 `tool_calls` 时这三段也要写。Runtime 不校验这段正文。

### `#user字段说明`
记忆写在 `#projectMemory` `#conversationMemory` `#turnMemory`。
上次会话总结写在 `#contextSummary`。
当前用户输入写在 `#userInput`。
历史用户输入写在 `#userInputHistory`。
当前环境写在 `#currentEnvironment`。
常驻工具 askUser / finishTurn 的用法写在本 Pack。动态工具的用法写在 user `#tools`。

报错说明：提示格式错误时，检查工具调用格式。

### `#skill`

查网页价格时，打开商品页，核对官网价和当前页标价。

### `#sop`

1. 认当前页是不是目标商品
2. 打开官网或权威标价页
3. 把价格写进观察


## user 插槽

顺序 = `userSlots` 数组。历史用户输入进 `#userInputHistory`；本轮原话进 `#userInput`；当前页进 `#currentEnvironment`。

常驻工具用法在 system（Pack）。动态工具用法在 `#tools`。本轮 `web.search` 的用法在 `#skill` / `#sop`，`#tools` 空。

### `#projectMemory`

（空）

### `#conversationMemory`

（空）

### `#turnMemory`

（空）

### `#contextSummary`

（空）

### `#userInputHistory`

（空）

### `#userInput`

帮我查这款鼠标官网价

### `#currentEnvironment`

```json
{
  "description": "当前页面信息",
  "tab": 12,
  "url": "https://item.jd.com/100012345678.html",
  "title": "罗技 MX Master 3S 无线鼠标"
}
```

### `#tools`

（空）

## 字段

上一份已有、本份原样带上：`conversationId` `turnId` `userInput` `userInputHistory` `submittedAt` `systemIds` `skillIds` `sopIds` `baseToolsIds` `toolIds` `turnMemoryIds` `conversationMemoryIds` `projectMemoryIds` `mcpIds` `currentPage`。

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
    "finishTurn"
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
    "#userInputHistory",
    "#userInput",
    "#currentEnvironment",
    "#tools"
  ]
}
```

下一份：LLM 吃按插槽拼好的窗口。
