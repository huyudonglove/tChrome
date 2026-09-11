#goalHistory
能力：【目标历史，方向变化】

详细描述：
被替换掉的旧目标记录数组，每项保留 id、turnId、goal、sourceCallId、createdAt；目标进入历史时沿用原 ID，可用 record.query（kind=goal，id=该项 id）回查。供理解方向变化，历史目标不是当前待办，不自动恢复执行；以当前请求和仍适用的目标为准。

按目标被替换的先后顺序由旧到新排列，新记录追加到末尾。

内容：
{{data}}
