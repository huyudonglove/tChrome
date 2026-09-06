# tChrome 数据

会话是一个项目入口。会话内记忆共享。每个会话一份账本，只存 ID 和时间；正文在 records 里。出网窗口每轮现装，不把 `messages[]` 当账本。

磁盘：`~/Library/Application Support/tChrome/conversations/<conversationId>/`

```text
ledger.json              会话账本
turns/<turnId>.json
goals/<goalId>.json
observations/<observationId>.json
memory/<memoryId>.json
```

Pack / skill / sop / tool / mcp 的定义在仓里 `catalog/`，会话只引用 ID。

样例按环节拆开。每份 md：**读到的** = 上一份「写出的」原样；**写出的** = 累积快照（上一份全部键 + 本环节新键，`stage` 改成本环节名）。解码按 catalog 展开成插槽：`systemSlots` / `userSlots` 都是名数组，正文在 md 分段和 catalog 文件里。`tools[]` 薄 schema。出网时 Runtime 按名列表拼 `system` / `user`。

| 文件 | 环节 | 本份新增 / 改写 |
|---|---|---|
| `docs/examples/01-normalize.md` | 归一化 | `stage` `conversationId` `turnId` `userInput` `submittedAt` |
| `docs/examples/02-context-engineering.md` | intake 点名 | 带上 01；改 `stage`；追加 `systemIds` `skillIds` `sopIds` `baseToolsIds` `toolIds` `turnMemoryIds` `conversationMemoryIds` `projectMemoryIds` `mcpIds` `currentPage` |
| `docs/examples/03-decode.md` | 解码 | 带上 02；改 `stage`；追加 `systemSlots` `userSlots`。出网 `tools[]` 由 Runtime 按 `baseToolsIds` + `toolIds` 取 schema |
| `docs/examples/04-provider-request.md` | Provider 入参 | 带上 03；改 `stage` 为 `provider-request`；追加 `provider` `model` `stream` `maxAttempts`。`stream: true` SSE，同一 body 最多 3 次 |
| `docs/examples/05-provider-response.md` | Provider 传出 | 带上 04；改 `stage` 为 `provider-response`；追加 `finish` `content` `toolCalls` `attempts` `parseOk` `schemaOk` `missing`。SSE 原文 + 解析查缺；落地 Ajv 对 catalog schema |
| `docs/examples/session-snapshot.json` | 全貌对照 | 多环节摊在一份里 |

## 作者

| 对象 | 谁写 |
|---|---|
| ledger 的 ID 列表、status、active、pendingAsk | Runtime |
| Goal `{goal, reason, action}` | 模型交，Runtime 落盘赋 id |
| Observation | 工具执行完由 Runtime 写；模型也可以交一句话观察，仍由 Runtime 落盘 |
| Turn.input | 面板提交的用户原话 / 人审答复 |
| Turn.assembled | Context 装配器，出网前写，给人回放 |
| catalog 条目 | 人改仓文件 |

## 会话账本 `ledger.json`

图上便利贴的字段，补了跑 LOOP 必需的指针。

```json
{
  "schemaVersion": 1,
  "conversationId": "cv_01",
  "createdAt": "2026-09-05T08:00:00.000Z",
  "updatedAt": "2026-09-05T08:02:00.000Z",
  "status": "running",
  "active": {
    "turnId": "tn_02",
    "goalId": "gl_01"
  },
  "pendingAsk": null,
  "turnIds": ["tn_01", "tn_02"],
  "goalIds": ["gl_01"],
  "observationIds": ["ob_01"],
  "memoryIds": ["mm_01"],
  "toolIds": ["web.search"],
  "sopIds": ["sop.browse"],
  "skillIds": ["skill.web"],
  "mcpIds": []
}
```

| 字段 | 内容 |
|---|---|
| `status` | `idle` 无活动 goal / `running` 在转 / `waiting_human` 冻在追问 / `paused` / `failed` |
| `active` | 当前 turn / goal；没有就 `null` |
| `pendingAsk` | `waiting_human` 时：`{turnId, question}`；否则 `null` |
| `turnIds` | 本会话所有回合，含闲聊 |
| `goalIds` | 已建的 goal |
| `observationIds` | 已写入的观察 |
| `memoryIds` | 会话共享记忆 |
| `toolIds` `sopIds` `skillIds` `mcpIds` | 本会话启用的 catalog ID，装配时按这个选 |

ID 前缀：`cv_` 会话 / `tn_` 回合 / `gl_` goal / `ob_` 观察 / `mm_` 记忆。catalog 用点号名，如 `skill.web`。

## Turn

一次出网 + 收口。图上两个 LLM 框是两种 `mode`，同一套记录。

```json
{
  "turnId": "tn_01",
  "conversationId": "cv_01",
  "mode": "intake",
  "status": "completed",
  "createdAt": "2026-09-05T08:00:01.000Z",
  "completedAt": "2026-09-05T08:00:08.000Z",
  "goalId": null,
  "input": { "text": "帮我查这款鼠标官网价" },
  "assembled": {
    "packIds": ["pack.agent"],
    "skillIds": ["skill.web"],
    "toolIds": ["web.search"],
    "sopIds": ["sop.browse"],
    "memoryIds": ["mm_01"],
    "blocks": ["#用户", "#上下文"]
  },
  "delivery": {
    "kind": "goal",
    "goalId": "gl_01"
  }
}
```

| 字段 | 内容 |
|---|---|
| `mode` | `intake`：够不够建 goal / `work`：对着 `#currentGoal` 干活 |
| `status` | `assembling` → `inferring` → `completed` / `waiting_human` / `failed` |
| `input.text` | 本轮用户原话；续问时是人审答复 |
| `assembled` | 这一步实际塞进窗口的 ID 和块名，回放用，不出网原文 |
| `delivery.kind` | 模型这一交：`reply` 说完 / `ask` 追问 / `goal` 产出 goal / `tool` 点名工具 |

`delivery` 按 kind 带指针：

- `reply` → `{kind, text}`
- `ask` → `{kind, question}`，同时 ledger.`pendingAsk` 写同一份
- `goal` → `{kind, goalId}`
- `tool` → `{kind, name, arguments, observationId}`（工具跑完才有 observationId）

## Goal

干活的单位。`continueGoal` 交来的 `goal` 字符串，Runtime 落盘赋 `gl_`。`action` 是打算做的下一步，还没执行。

```json
{
  "goalId": "gl_01",
  "conversationId": "cv_01",
  "turnId": "tn_01",
  "goal": "拿到该型号官网标价",
  "reason": "用户要和电商页对比",
  "action": "打开官网商品页并读取价格",
  "status": "active"
}
```

`status`：`active` / `done` / `abandoned`。同一时刻最多一个 `active.goalId`。闲聊不建 goal。

## Observation

图上菱形的 observe、CE#2 的 `#observation`。工具跑完或本轮看见世界之后才有。

```json
{
  "observationId": "ob_01",
  "conversationId": "cv_01",
  "goalId": "gl_01",
  "turnId": "tn_02",
  "source": "tool",
  "toolName": "web.search",
  "content": "官网标价 199",
  "createdAt": "2026-09-05T08:01:20.000Z"
}
```

`source`：`tool` / `page` / `user` / `model`。

## Memory

会话共享，intake 和 work 都能装进 `#上下文`。

```json
{
  "memoryId": "mm_01",
  "conversationId": "cv_01",
  "text": "用户在对比两款鼠标，只要官网价",
  "createdAt": "2026-09-05T08:00:00.000Z"
}
```

## 窗口（现装，不落成聊天数组）

两段 Context Engineering 共用 records，配方不同。

**intake（CE#1）** 装：system Pack + 本会话 `skillIds` / `toolIds` / `sopIds` / `mcpIds` + `#用户` + `#上下文`（memory）。

**work** 装：同一 Pack + `#currentGoal` + `#observation`。

user 文档块：

```text
#用户
#currentGoal
#observation
#上下文
```

system 仍是冻结 Pack（身份 / 工位 / 作业法）。skill / sop / tool schema 按 ledger 的 ID 选进本轮。

Provider 电线：`{system, user, tools}` 由装配器现渲染，用完即扔。回放看 `turn.assembled`。

## LOOP 时数据怎么走

1. 用户一句话 → 新 Turn `mode=intake`，CE 装配，LLM 交 `ask` 或 `continueGoal`。
2. `ask` → ledger.`status=waiting_human`，等人答，答文写进下一 Turn `input`，还是 `intake`。
3. `continueGoal` → 新建 Goal，ledger.`active.goalId` 指向它。
4. 新 Turn `mode=work`，装 `#currentGoal` `#observation`，LLM 交动态工具 / `reply` / `ask`。
5. 动态工具 → Runtime 执行 → 写 Observation → 再开 `work` Turn（LOOP）。
6. `reply` 且 goal 收口 → Goal `done`，ledger.`status=idle`，`active.goalId=null`。

回流画到哪还没钉：数据上 LOOP 就是再写一条 `work` Turn，读同一批 records。

## 未钉（图上还空着，字段先不发明）

- LLM#1 左边空框：不新增 kind，等你补字。
- CE#3 在 LOOP 前再装一次：work 配方暂兼这一步；要分列再加 `mode`。
- 两圈 LLM 是否换 Pack：现在同一 `pack.agent`，只换 `assembled.blocks`。
