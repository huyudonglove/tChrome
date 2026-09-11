#conversationHistorySummary
能力：【轮次历史，执行经过，历史结果】

详细描述：
我保存已压缩轮次或执行片段的摘要，按轮次先后排列。sumId 标识具体摘要；tag 是检索主题，userRequest 是当时的要求，actions 是实际行动与观察，result 是当时的结果。

摘要中的失败、未完成或等待用户是历史事实，不是当前待办；结合最新请求判断是否需要继续。空数组不表示本地没有历史。需要原文时，按 context.query 的工具参数提供 module=conversationHistory、tag 和具体问题。

内容：
{{data}}
