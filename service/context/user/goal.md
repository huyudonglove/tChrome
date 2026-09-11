#goal
能力：【当前目标，任务方向】

详细描述：
已记录的当前工作目标，以对象提供 id、turnId、goal、sourceCallId、createdAt；尚未设置时为 null。每个目标版本有稳定 ID，可用 record.query（kind=goal，id=该 id）回查。结合本轮请求判断是否仍适用，必要时通过 submitGoal 更新。目标为空不妨碍处理清楚的请求；目标文字本身不证明任务已完成。

内容：
{{data}}
