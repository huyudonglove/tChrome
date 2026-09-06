# 02 Context Engineering

读 01 的写出。本环节点名：用哪些 Pack / skill / SOP / 常驻工具 / 动态工具 / 三层记忆 / MCP，以及当前页。正文留给 03 解码展开。

怎么看：上面「读到的」是 01 写出的原样。下面「写出的」是累积快照：01 五个键 + 本环节新增的键。对照仓里 `catalog/`：这些 ID 都有对应文件。

## 读到的（01 写出的）

```json
{
  "stage": "normalize",
  "conversationId": "cv_01",
  "turnId": "tn_01",
  "userInput": "帮我查这款鼠标官网价",
  "submittedAt": "2026-09-05T08:00:01.000Z"
}
```

| 谁 | 写什么 |
|---|---|
| 01（原样带上） | `conversationId` `turnId` `userInput` `submittedAt` |
| 本环节 | `stage` 改成 `context-engineering-input`；追加下面点名键 |

## 配方（intake）

图上 CE#1：组装 system / skill / tool / memory / SOP。本环节只选出 ID。

| 选什么 | 干什么 | 本轮选中 |
|---|---|---|
| `systemIds` | 本轮 Pack | `pack.agent` → `catalog/packs/pack.agent.md` |
| `skillIds` | 索引进 system 的章节 | `skill.web` → `catalog/skills/skill.web.md` |
| `sopIds` | 索引进 system 的章节 | `sop.browse` → `catalog/sops/sop.browse.md` |
| `baseToolsIds` | 常驻工具，每轮都出网 | `continueGoal` `askUser` |
| `toolIds` | 动态工具，本轮才挂 | `web.search` |
| `turnMemoryIds` | 这一轮记忆 | 新会话空 |
| `conversationMemoryIds` | 这一次会话记忆 | 新会话空 |
| `projectMemoryIds` | 项目记忆 | 新会话空 |
| `mcpIds` | 本轮 MCP | 空 |
| `currentPage` | 当前页 | 京东商品页 |

本轮没有独立 goal。intake 只点名 catalog 和当前页。work 配方在 `continueGoal` 交了 goal 之后另开。

## 字段

上一份已有、本份原样带上：

| 字段 | 类型 | 谁填 | 怎么填 |
|---|---|---|---|
| `conversationId` | string | 01 | 原样 |
| `turnId` | string | 01 | 原样 |
| `userInput` | string | 01 | 原样 |
| `submittedAt` | string | 01 | 原样 |

本环节新增 / 改写：

| 字段 | 类型 | 谁填 | 怎么填 |
|---|---|---|---|
| `stage` | string | 固定 | `context-engineering-input` |
| `systemIds` | string[] | 装配器 | 本轮 Pack，对应 `catalog/packs/<id>.md` |
| `skillIds` | string[] | 装配器 | 本轮 skill，对应 `catalog/skills/<id>.md` |
| `sopIds` | string[] | 装配器 | 本轮 SOP，对应 `catalog/sops/<id>.md` |
| `baseToolsIds` | string[] | 装配器 | 常驻工具，对应 `catalog/tools/<id>.json`。本轮固定 `continueGoal` `askUser` |
| `toolIds` | string[] | 装配器 | 动态工具，对应 `catalog/tools/<id>.json`。没有就 `[]` |
| `turnMemoryIds` | string[] | 装配器 | 这一轮记忆；没有就 `[]` |
| `conversationMemoryIds` | string[] | 装配器 | 这一次会话记忆；没有就 `[]` |
| `projectMemoryIds` | string[] | 装配器 | 项目记忆；没有就 `[]` |
| `mcpIds` | string[] | 装配器 | 本轮 MCP；没有就 `[]` |
| `currentPage` | object \| null | 装配器 | 没有就 `null`。有则带 `description`、`tab` ≥ 1、`url`、`title` |

`currentPage` 有值时：

| 字段 | 类型 | 怎么填 |
|---|---|---|
| `description` | string | 这块环境是什么，给人/模型认 |
| `tab` | number | Chrome tabId，≥ 1 |
| `url` | string | 当前页 URL |
| `title` | string | 当前页标题 |

出网 tools[] = `baseToolsIds` + `toolIds`，按名取 `catalog/tools/<id>.json` 的 schema。

## 写出的

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
  "baseToolsIds": ["continueGoal", "askUser"],
  "toolIds": ["web.search"],
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
