#goalHistory
能力：【已结束目标】

详细描述：
completed 或 cancelled 的目标记录，保留原 id、parentId、status、goal 和来源 turnId/sourceCallId，不因修改目标另建版本。parentId 关联总目标；重新激活的目标回到 #goal。历史变更快照随所属轮次归档，可通过 context.query 的 goalChanges 回查。

内容：
{{data}}
