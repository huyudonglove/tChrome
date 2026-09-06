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

见 `docs/schema.md`「阶段快照」`normalize`。

面板写 `userInput` `submittedAt`。Runtime 写 `conversationId` `turnId` `userInputHistory`。

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
