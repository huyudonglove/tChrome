<queryModules>
能力：【Request And Candidate Fields】

详细描述：
下列字段出现在 User 的 { "request": {...}, "turns": [...] } 材料里。

request：

- sumId：本次查询入口摘要 ID。
- module：指定读取的模块。取值与含义：
  - userInput：用户原话
  - goalChanges：目标历史变更快照（保留固定 id、parentId 和当时 status）
  - toolIO：工具参数与结果
  - pageObservations：页面观察
  - memoryWrites：会话记忆写入
  - output：当轮回复或错误
  - queryHistory：当轮历史查询
  - summaries：入口及来源摘要
- intent：本次要找什么；我按它判断哪些轮次含相关证据。

turns：按来源轮次排列的候选数组。每项：

- turnId：来源轮次 ID；我只返回所属 turnId。
- records：该轮指定模块的原始记录数组；记录保留自身标识。

Sample（一次查询含两个候选轮次的骨架，仅示例）：

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
            { "callId": "call_01", "turnId": "tn_01", "name": "page.get_summary" }
          ]
        },
        {
          "turnId": "tn_02",
          "records": [
            { "callId": "call_04", "turnId": "tn_02", "name": "memory.write" }
          ]
        }
      ]
    }
</queryModules>
