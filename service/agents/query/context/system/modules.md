<queryModules>
能力：【Request And Candidate Fields】

详细描述：
下列字段出现在 User 的 { "request": {...}, "turns": [...] } 材料里。

request：

- sumId：本次查询入口摘要 ID。
- module：指定读取的模块。取值与含义：
  - userInput：用户原话
  - goalChanges：目标历史变更快照（保留固定 id、parentId 和当时 status）
  - toolIO：工具参数与结果（归档形态，含 return.text）
  - pageObservations：页面观察
  - memoryWrites：会话记忆写入
  - output：当轮收尾。kind=reply 时字段为 text（最终回复正文）；ask/error/tool 同前；kind=tool 表示停在该调用、还没收口
  - queryHistory：当轮历史查询
  - summaries：入口及来源摘要对象 {sumId, turnId, tag, userRequest, actions, result}，不是原文
- intent：本次要找什么；我按它判断哪些轮次含相关证据。

turns：按来源轮次排列的候选数组。每项：

- turnId：来源轮次 ID；提交时原样复制这里的值。
- records：该轮指定模块的原始记录数组；记录保留自身标识。空数组表示该轮该模块没有记录。

Sample（一次查询含两个候选轮次，仅示例）：

    {
      "request": {
        "sumId": "sum_01",
        "module": "toolIO",
        "intent": "保存后的状态"
      },
      "turns": [
        {
          "turnId": "tn_01",
          "records": [
            {
              "callId": "call_02",
              "turnId": "tn_01",
              "name": "page.get_summary",
              "arguments": { "tabId": 12, "reason": "读概况", "affectsPage": false },
              "return": { "stage": "complete", "totalChars": 18, "text": "{\"ok\":true}" }
            }
          ]
        },
        {
          "turnId": "tn_02",
          "records": [
            {
              "callId": "call_04",
              "turnId": "tn_02",
              "name": "memory.write",
              "arguments": { "layer": "conversation", "text": "用户偏好 CSV" },
              "return": { "stage": "complete", "totalChars": 12, "text": "{\"ok\":true}" }
            }
          ]
        }
      ]
    }

无候选 Sample：

    { "request": { "sumId": "sum_01", "module": "userInput", "intent": "最初要求" }, "turns": [] }
</queryModules>
