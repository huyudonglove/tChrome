<queryHistory>
能力：【Query History, Retrieved Evidence】

详细描述：
按旧到新排列的历史查询，字段语义同 <currentQuery>。用于了解当时查了什么、返回了哪些原文；回查不等于重新执行或验证历史操作。

Sample（仅示例，不是当前记录）：

    [
      {
        "queryId": "query_01", "turnId": "tn_02", "sumId": "sum_01",
        "module": "userInput", "intent": "回查用户最初要求",
        "sourceCallId": "call_09", "status": "complete",
        "records": [{"id":"input_01","turnId":"tn_01","userInput":"查找导出方法"}]
      }
    ]

内容：
{{data}}
</queryHistory>
