# 01 归一化

面板交上一句话。Runtime 补 `conversationId` / `turnId`，写成 jsonl 一行。这份是底。后面环节的「写出的」把这六个键原样带上，再追加本环节字段。

怎么看：上面「面板交上来的」是入口；下面「写出的」是落盘，也是 02 要整份拷走的快照。

## 面板交上来的

```json
{
  "userInput": "帮我查这款鼠标官网价",
  "submittedAt": "2026-09-05T08:00:01.000Z"
}
```

| 谁 | 写什么 |
|---|---|
| 面板 | `userInput` `submittedAt` |
| Runtime | `conversationId` `turnId` `userInputHistory` |

## 字段

| 字段 | 类型 | 谁填 | 怎么填 |
|---|---|---|---|
| `stage` | string | 固定 | `normalize` |
| `conversationId` | string | Runtime | 新会话现发 `cv_`；续聊用已有 |
| `turnId` | string | Runtime | 现发 `tn_` |
| `userInput` | string | 面板 | 用户原话，非空 |
| `userInputHistory` | string[] | Runtime | 上一轮及更早的用户原话。用户开新 Turn 时追加上一轮。新会话 / 首回合 `[]` |
| `submittedAt` | string | 面板 | ISO-8601，面板提交时间 |

## 写出的

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

下一份 02 把这份六个键原样带进「写出的」，再追加 catalog ID 和当前页。
