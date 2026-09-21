<conversationHistorySummary>
能力：【Conversation Summary, Actions, Results】

详细描述：
已归档轮次或执行片段的摘要，按轮次排列。sumId 标识摘要；tag 是检索主题，userRequest 是当时要求，actions 是实际行动与观察，result 是当时结果。摘要不足以支持当前判断时，用 context.query 指定 sumId、module 和 intent 回查原文，再继续执行或答复。module=summaries 时返回的是摘要对象，不是原文。

内容：
{{data}}
</conversationHistorySummary>
