# 02 Context Engineering

读 01 的写出。本环节点名：常驻工具 / 动态工具 / 两层记忆 / MCP，以及发话时标签。system / user 模块按 `service/context/modules.json` 加载，能力导航从模块元数据生成，网页方法来自 `service/skills/web-observation/SKILL.md`，由 runtime 注入 `<skill>`。正文留给 03 解码展开。

怎么看：上面「读到的」是 01 写出的原样。下面「写出的」是累积快照：01 六个键 + 本环节新增的键。栏目和 skill 对应 `service/context/` 中的文件，工具 ID 对应 `service/tools/definitions/`，记忆 ID 对应运行数据目录中的记录。

## 读到的（01 写出的）

```json
{
  "stage": "normalize",
  "conversationId": "cv_01",
  "turnId": "tn_01",
  "userInput": "帮我查这款鼠标官网价",
  "userInputHistory": [],
  "submittedAt": "2026-09-05T08:00:01.000Z"
}
```

| 谁 | 写什么 |
|---|---|
| 01（原样带上） | `conversationId` `turnId` `userInput` `userInputHistory` `submittedAt` |
| 本环节 | `stage` 改成 `context-engineering-input`；追加下面点名键 |

## 配方

组装 system / skill / tool / memory。本环节只选出 ID。

| 选什么 | 干什么 | 本轮选中 |
|---|---|---|
| `baseToolsIds` | 常驻工具，每轮都出网 | `askUser` `finishTurn` `submitGoal` `context.query` `memory.write` `notes.write` `notes.delete` |
| `toolIds` | 动态工具，本轮才挂 | 开 Turn 先挂 core。本样例：`page.get_summary` `open_url` `web_search`。全表见 `service/tools/definitions/index.json`，缺了 `catalog.add` |
| `conversationMemoryIds` | 这一次会话记忆 | 新会话空 |
| `projectMemoryIds` | 项目记忆 | 新会话空 |
| `mcpIds` | 本轮 MCP | 空 |
| `currentPage` | 当前页 | 京东商品页 |

本轮只点名 catalog 和当前页。材料够就调动态工具。

## 字段

见 `docs/schema.md`「阶段快照」`context-engineering-input` 和「assembled」。

出网 `tools[]` = `baseToolsIds` + `toolIds`，按名取 `service/tools/definitions/<id>.json`。

## 写出的

```json
{
  "stage": "context-engineering-input",
  "conversationId": "cv_01",
  "turnId": "tn_01",
  "userInput": "帮我查这款鼠标官网价",
  "userInputHistory": [],
  "submittedAt": "2026-09-05T08:00:01.000Z",
  "baseToolsIds": [
    "askUser",
    "finishTurn",
    "submitGoal",
    "context.query",
    "memory.write",
    "notes.write",
    "notes.delete",
    "page.clear_result",
    "evidence.search",
    "catalog.add",
    "list_browser_tools",
    "open_url",
    "page.get_summary",
    "page.list_interactive_elements",
    "page.click",
    "page.type",
    "checklist.set",
    "checklist.update",
    "page.recheck",
    "page.assert",
    "tab.context"
  ],
  "toolIds": [
    "page.get_summary",
    "open_url",
    "web_search"
  ],
  "conversationMemoryIds": [],
  "projectMemoryIds": [],
  "mcpIds": [],
  "currentPage": {
    "tabId": 12,
    "url": "https://item.jd.com/100012345678.html",
    "title": "罗技 MX Master 3S 无线鼠标",
    "description": "用户发话时的标签信息，尚未读取页面内容"
  },
  "pageObservedHistory": [],
  "openTabs": {
    "ok": true,
    "windows": [
      {
        "windowId": 1,
        "focused": true,
        "tabs": [
          {
            "tabId": 12,
            "url": "https://item.jd.com/100012345678.html",
            "title": "罗技 MX Master 3S 无线鼠标",
            "active": true
          }
        ]
      }
    ]
  }
}
```

下一份 03 把这份整份带上，再按 `service/context/` 展开成栏目（`systemSlots` / `userSlots` 为内部 `#id` 数组）。出网 tools[] 由 Runtime 按 `baseToolsIds` + `toolIds` 取 schema。
