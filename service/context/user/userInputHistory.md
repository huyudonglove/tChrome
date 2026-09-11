#userInputHistory
能力：【历史输入，指代理解，条件变化】

详细描述：
此前轮次的用户输入记录，以对象数组按从旧到新的顺序提供；每项包含 id、turnId、userInput、submittedAt，保留原话中的换行和创建时的稳定 ID。空数组表示尚无历史输入。不含本轮输入，也不等于完整对话。用于理解指代、偏好和条件变化；历史要求仅作背景，不能覆盖用户最新修正。需要精确原话时用 record.query（kind=userInput，id=该项 id）回查本地记录。

内容：
{{data}}
