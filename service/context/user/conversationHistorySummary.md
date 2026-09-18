<conversationHistorySummary>
能力：【Conversation Summary, Actions, Results】

详细描述：
已归档轮次或执行片段的摘要，按轮次排列。sumId 标识摘要；tag 是检索主题，userRequest 是当时要求，actions 是实际行动与观察，result 是当时结果。需要原文时，用 context.query 指定 sumId、module 和 intent。module=summaries 时返回的是摘要对象，不是原文。

Sample（仅示例，不是当前记录）：

    [
      {"sumId":"sum_01","turnId":"tn_01","tag":"文档查阅","userRequest":"查找导出方法","actions":"阅读帮助页，找到导出入口","result":"已确认支持导出 CSV"}
    ]

内容：
{{data}}
</conversationHistorySummary>
