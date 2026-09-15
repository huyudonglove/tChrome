#goalHistory
能力：【Closed Goals】

详细描述：
completed 或 cancelled 的目标记录，保留原 id、parentId、status、goal 和来源 turnId/sourceCallId，不因修改目标另建版本。parentId 关联总目标；重新激活的目标回到 #goal。历史变更快照随所属轮次归档，可通过 context.query 的 goalChanges 回查。

Sample（仅示例，不是当前记录）：

    [
      {"id":"subgoal_02","parentId":"goal_01","status":"completed","turnId":"tn_02","sourceCallId":"call_06","goal":"确认导出格式"}
    ]

内容：
{{data}}
