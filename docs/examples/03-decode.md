# 03 解码

读 02 的写出。按 `catalog/` 把 ID 展开成**插槽**。JSON 里只留插槽名列表，不写带换行的长字符串，也不塞 tools schema。

怎么看：

- 「读到的」是 02 写出的原样
- 「system 插槽」每个 `#标题` 单独一段，正文来自 catalog
- 「user 插槽」每个 `#块` 单独一段，正文在这一页
- 「写出的」JSON：`systemSlots` / `userSlots` 都是名数组
- 出网时 Runtime 按 `catalog/window.system.md` / `window.user.md` 的 `{{槽名}}` 插值拼 `system` / `user`；按 `baseToolsIds` + `toolIds` 取 `catalog/tools/<id>.json` 填请求的 `tools[]`

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
    "finishTurn",
    "tool.detail",
    "observation.detail",
    "memory.write"
  ],
  "toolIds": [
    "see_page",
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
  }
}
```

## catalog 取出

| ID                       | 文件                            | 贡献                                                                                   |
| ------------------------ | ------------------------------- | -------------------------------------------------------------------------------------- |
| `pack.agent`             | `catalog/packs/pack.agent.md`   | `#身份`, `#记忆`, `#观察`, `#环境`, `#协议`, `#参数说明`, `#内置工具`, `#输出`, `#user槽` |
| `skill.web`              | `catalog/skills/skill.web.md`   | user `#skill`                                                                          |
| `sop.browse`             | `catalog/sops/sop.browse.md`    | user `#sop`                                                                            |
| `askUser`                | `catalog/tools/askUser.json`    | 常驻，出网 tools[]                                                                     |
| `finishTurn`             | `catalog/tools/finishTurn.json` | 常驻，出网 tools[]                                                                     |
| `tool.detail`            | `catalog/tools/tool.detail.json` | 常驻，出网 tools[]                                                                    |
| `web_search`             | `catalog/tools/web_search.json` | 动态，出网 tools[]                                                                     |

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
写：调 memory.write。Runtime 落盘，下一次出网把落下的记忆带进对应 user 槽。
窗口到 200K 时 Runtime 压缩 turnMemory 和 conversationMemory：槽里只留压缩后的摘要。细节用 observation.detail，observationId 用 `#observation` 该项的 id。

### `#观察`

`#observation` 是压缩过的事实。窗口到 200K 时 Runtime 把较早的 `#toolIO` 收成这些条目。每项是摘要，不是全文。要看具体事实，调 observation.detail，observationId 用该项的 id。

### `#环境`

Chrome、JavaScript、HTML、CSS。

### `#协议`

一次出网可交多个工具。Runtime 按交出去的顺序执行。affectsPage 标这次会不会改当前页。finishTurn 一执行本轮就收口，同一次出网里其它工具要先跑完才轮到它。
`#toolIO` 某条 return.stage=truncated 时，调 tool.detail，callId 用那条的 callId。
`#observation` 某条要展开时，调 observation.detail，observationId 用那条的 id。
`#goalHistory` 由 Runtime 拼，模型写了也不会进这个槽。
user 里的槽是参考材料，按需取用。

### `#参数说明`

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

### `#内置工具`

常驻：askUser、finishTurn、submitGoal、tool.detail、observation.detail、memory.write。每轮都在出网 tools[] 里。用法见 #协议、#参数说明。
动态工具本轮才挂上，用法写在 user `#tools`。
每个工具的 arguments 都带 reason 和 affectsPage。

### `#输出`

每次都写 `content`，三段，标题固定：

observation
<看见了什么>

reason
<为什么这么做>

action
<下一步：调哪个工具，或对用户说什么>

有 `tool_calls` 时这三段也要写。Runtime 不校验这段正文。

### `#user槽`

user 各槽是参考。`#userInput` 是本轮用户原话。其余（记忆、目标、当前页、工具返回、skill、sop）按需取用。

## user 插槽

顺序 = `userSlots` 数组。都是参考材料，按需取用。skill / sop / 建议路径在 user，不进 system。

### `#参考`

这些槽是材料，按需取用，不是清单。`#goal` 空着时可用 submitGoal，也可先干活再立。探索型可以由大到小；确定型可以直接调对应工具。

### `#skill`

查网页：探索型可以由大到小。确定型已经知道要点哪、要打开哪，直接调对应工具。

### `#sop`

探索型可以由大到小。确定型可以直接 open_url / click / type / finishTurn。

### `#projectMemory`

（空）

### `#conversationMemory`

（空）

### `#turnMemory`

（空）

### `#contextSummary`

（空）

### `#observation`

（空）

### `#userInputHistory`

（空）

### `#userInput`

帮我查这款鼠标官网价

### `#goal`

（空）

### `#goalHistory`

[]

### `#currentPage`

（空）

### `#currentEnvironment`

```json
{
  "description": "当前页面信息",
  "tab": 12,
  "url": "https://item.jd.com/100012345678.html",
  "title": "罗技 MX Master 3S 无线鼠标"
}
```

### `#toolIO`

（空）

### `#tools`

see_page：读当前页标题、地址和可见正文。affectsPage=false。
open_url：打开指定网址并读回标题正文。affectsPage=true。
web_search：搜索公开网页。affectsPage=false。
其余动态工具见 `catalog/tools/index.json`。

## 字段

见 `docs/schema.md`「阶段快照」`context-engineering-decode` 和「窗口插槽」。

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
    "finishTurn",
    "tool.detail",
    "observation.detail",
    "memory.write"
  ],
  "toolIds": [
    "see_page",
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
    "#参数说明",
    "#内置工具",
    "#输出",
    "#user槽"
  ],
  "userSlots": [
    "#参考",
    "#skill",
    "#sop",
    "#projectMemory",
    "#conversationMemory",
    "#turnMemory",
    "#contextSummary",
    "#observation",
    "#userInputHistory",
    "#userInput",
    "#goal",
    "#goalHistory",
    "#currentPage",
    "#currentEnvironment",
    "#toolIO",
    "#tools"
  ]
}
```

下一份：LLM 吃按插槽拼好的窗口。
