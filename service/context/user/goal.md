#goal
能力：【当前目标，任务方向】

详细描述：
已记录的当前工作目标，包含 id、turnId、sourceCallId 和目标文本 goal；尚未设置时为 null。结合本轮请求判断是否仍适用，必要时通过 submitGoal 更新。目标为空不妨碍处理清楚的请求；目标文字本身不证明任务已完成。

id 标识一个目标版本，目标更新后产生新的版本 ID；turnId 是创建该版本的轮次，sourceCallId 对应产生它的工具调用 callId。目标可以沿用到后续轮次，其 turnId 仍指向创建轮次；目标版本 ID 不等于页面上的业务目标 ID。

内容：
{{data}}
