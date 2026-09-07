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
    "submitGoal",
    "tool.detail",
    "observation.detail",
    "memory.write"
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

顺序 = `systemSlots` 数组。改正文去改 catalog 文件。

### `#身份`

你是 tChrome 浏览器助手。会话层级是 project、conversation、turn。

### `#记忆`

三层记忆：
projectMemory：project 范围内的记忆，跨 conversation 保留。读 user `#projectMemory`。写 memory.write 的 projectMemory。
conversationMemory：本 conversation 内确认过的事实。读 user `#conversationMemory`。写 memory.write 的 conversationMemory。
turnMemory：本 Turn 写下的记忆。读 user `#turnMemory`。写 memory.write 的 turnMemory。
windowChars 达到 compressAt（200000）时，Runtime 压缩 conversationMemory 和 turnMemory，对应槽写入 summary。

### `#观察`

user `#observation` 是 Runtime 在 windowChars 达到 compressAt（200000）时从 toolIO 收成的摘要。observation.detail 的 observationId 等于该项 id。

### `#环境`

运行环境是 Chrome、JavaScript、HTML、CSS。

### `#协议`

一次出网的 tool_calls 由 Runtime 按数组顺序执行。
affectsPage 为 true 时该调用改变当前页（跳转、点击、输入）；为 false 时该调用只读。
finishTurn 执行后本 Turn status=completed，ledger.status=idle。
toolIO 某条 return.stage=truncated 时，tool.detail 的 callId 等于该条 callId。
observation 某条需要全文时，observation.detail 的 observationId 等于该条 id。
user 槽是参考材料。

### `#目标`

ledger.goal 是当前目标。submitGoal 的 goal 写入 ledger.goal。ledger.goal 初始值是空字符串。
ledger.goalHistory 是被替换掉的旧 goal 数组。Runtime 在 submitGoal 的 goal 与当前 ledger.goal 不同时，把旧 ledger.goal 追加进 ledger.goalHistory。模型不写 ledger.goalHistory。
user `#goal` 等于 ledger.goal。user `#goalHistory` 等于 ledger.goalHistory。

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

baseToolsIds 每轮出网：askUser、finishTurn、submitGoal、tool.detail、observation.detail、memory.write。
coreToolIds 开 Turn 挂上：page.get_summary、page.list_regions、page.list_interactive_elements、page.inspect_region、page.inspect_element、page.click、page.type、open_url、web_search、list_browser_tools、catalog.add。
动态工具用法写在 user `#tools`。
每个工具 arguments 含 reason 和 affectsPage。

### `#输出`

每次都写 `content`，三段，标题固定：

seen
<看见了什么>

reason
<为什么这么做>

action
<下一步：调哪个工具，或对用户说什么>

有 `tool_calls` 时这三段也要写。Runtime 不校验这段正文。

### `#user槽`

user 按层装配。空槽只留标题。
##方法：`#skill` `#sop`
##记忆：`#projectMemory` `#conversationMemory` `#turnMemory` `#contextSummary` `#observation`
##输入：`#userInputHistory` `#userInput`
##目标：`#goal` `#goalHistory`
##页面：`#currentTab` `#currentPage`
##过程：`#toolIO`
##工具：`#baseTools` `#tools`

## user 插槽

顺序 = `window.user.md`。层标题 `##方法` `##记忆` `##输入` `##目标` `##页面` `##过程` `##工具`。层内是参考槽。

### `##方法`

### `#skill`

网页工具：page.get_summary 读摘要；page.list_regions 列区域；page.list_interactive_elements 列可交互元素；page.click / page.type 用返回的 id；open_url 打开网址；web_search 检索。

### `#sop`

探索型：page.get_summary → page.list_regions → page.list_interactive_elements → 用返回的 id 调 page.click / page.type。
确定型：直接调目标工具。对用户说完再 finishTurn。

### `##记忆`

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

### `##输入`

### `#userInputHistory`

（空）

### `#userInput`

帮我查这款鼠标官网价

### `##目标`

### `#goal`

（空）

### `#goalHistory`

[]

### `##页面`

### `#currentTab`

（空）

### `#currentPage`

```json
{
  "description": "当前页面信息",
  "tab": 12,
  "url": "https://item.jd.com/100012345678.html",
  "title": "罗技 MX Master 3S 无线鼠标"
}
```

### `##过程`

### `#toolIO`

（空）

### `##工具`

### `#baseTools`

askUser：向用户提问。入参：choice。返回：用户选项。affectsPage=false。
finishTurn：结束本 Turn。入参：无。content 的 action 是对用户说的话。affectsPage=false。
submitGoal：写入 ledger.goal。入参：goal。返回：当前目标。affectsPage=false。
tool.detail：展开 toolIO 截断全文。入参：callId。affectsPage=false。
observation.detail：展开 observation 全文。入参：observationId。affectsPage=false。
memory.write：写入记忆。入参：可选 turnMemory、conversationMemory、projectMemory、contextSummary。affectsPage=false。

### `#tools`

page.get_summary：读当前页摘要：标题、地址、区域数、可交互数、标题列表。affectsPage=false。
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
    "submitGoal",
    "tool.detail",
    "observation.detail",
    "memory.write"
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
    "#currentTab",
    "#currentPage",
    "#toolIO",
    "#baseTools",
    "#tools"
  ]
}
```

下一份：LLM 吃按插槽拼好的窗口。
