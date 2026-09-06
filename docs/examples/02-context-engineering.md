# 02 Context Engineering

读 01 的写出。本环节点名：用哪些 Pack / skill / SOP / 常驻工具 / 动态工具 / 三层记忆 / MCP，以及当前页。正文留给 03 解码展开。

怎么看：上面「读到的」是 01 写出的原样。下面「写出的」是累积快照：01 六个键 + 本环节新增的键。对照仓里 `catalog/`：这些 ID 都有对应文件。

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

组装 system / skill / tool / memory / SOP。本环节只选出 ID。

| 选什么 | 干什么 | 本轮选中 |
|---|---|---|
| `systemIds` | 本轮 Pack | `pack.agent` → `catalog/packs/pack.agent.md` |
| `skillIds` | 索引进 system 的章节 | `skill.web` → `catalog/skills/skill.web.md` |
| `sopIds` | 索引进 system 的章节 | `sop.browse` → `catalog/sops/sop.browse.md` |
| `baseToolsIds` | 常驻工具，每轮都出网 | `askUser` `finishTurn` `tool.detail` `observation.detail` `memory.write` |
| `toolIds` | 动态工具，本轮才挂 | telance 浏览器 + 服务端全表，见 `catalog/tools/index.json`。本样例用 `see_page` `open_url` `web_search` |
| `turnMemoryIds` | 这一轮记忆 | 新会话空 |
| `conversationMemoryIds` | 这一次会话记忆 | 新会话空 |
| `projectMemoryIds` | 项目记忆 | 新会话空 |
| `mcpIds` | 本轮 MCP | 空 |
| `currentPage` | 当前页 | 京东商品页 |

本轮只点名 catalog 和当前页。材料够就调动态工具。

## 字段

见 `docs/schema.md`「阶段快照」`context-engineering-input` 和「assembled」。

出网 `tools[]` = `baseToolsIds` + `toolIds`，按名取 `catalog/tools/<id>.json`。

## 写出的

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

下一份 03 把这份整份带上，再按 `catalog/` 展开成插槽（`systemSlots` / `userSlots`）。出网 tools[] 由 Runtime 按 `baseToolsIds` + `toolIds` 取 schema。
