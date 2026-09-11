#userInputHistory
能力：【历史输入，指代理解，条件变化】

详细描述：
此前轮次尚未压缩的用户原话，以字符串数组按从旧到新的顺序提供，保留消息边界和换行，不含本轮输入。与 conversationHistorySummary 配合理解指代、偏好和条件变化；历史要求不能覆盖用户最新修正。空数组表示当前窗口没有未压缩的历史原话，不表示本地没有记录。需要归档原话时用 context.query，module=conversationHistory，提供主题 tag 和具体问题。

内容：
{{data}}
