<taskHistory>
能力：【Task Event History】

详细描述：
任务事件历史（只追加、不可改删）。由 task.set / task.update / task.complete 及 Goal 收口自动写入；每条带产生它的 turnId，随该轮进入压缩，覆盖后从本栏滤出，原文仍可经 agent.query 回查。
事件类型：task_created / item_started / item_updated / item_completed / task_completed / task_cancelled / goal_completed / goal_cancelled。
当前活动任务看 <task>；本栏只读审计，不提供更新或删除工具。

内容：
{{data}}
</taskHistory>
