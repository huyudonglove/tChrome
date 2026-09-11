#userInputHistory
能力：【历史输入，指代理解，条件变化】

详细描述：
此前轮次尚未压缩的用户原话，以记录数组按从旧到新的顺序提供，每项包含 id、turnId 和完整原话 userInput，保留消息边界和换行，不含本轮输入。与 conversationHistorySummary 配合理解指代、偏好和条件变化；历史要求不能覆盖用户最新修正。空数组表示当前窗口没有未压缩的历史原话，不表示本地没有记录。需要归档原话时用 context.query，module=conversationHistory，提供主题 tag 和具体问题。

id 标识具体用户消息，turnId 标识该消息开启的轮次，可与相同 turnId 的目标、工具调用和其他记录关联。引用已有值，不自行构造 ID。

内容：
{{data}}
