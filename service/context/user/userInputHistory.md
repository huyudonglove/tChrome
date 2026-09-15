#userInputHistory
能力：【Input History, Reference Resolution】

详细描述：
按旧到新排列的历史用户输入，不含当前请求。id 标识消息，userInput 是原话。结合 #conversationHistorySummary 理解指代和条件变化；更早原话可通过 context.query 回查。

Sample（仅示例，不是当前记录）：

    [
      {
        "id": "input_01",
        "turnId": "tn_01",
        "userInput": "检查这个页面的提交结果"
      }
    ]

内容：
{{data}}
