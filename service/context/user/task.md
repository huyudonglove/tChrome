<task>
能力：【Persistent Execution Task】

详细描述：
当前 Goal 的持久化执行任务。跨 turn 保留，不随本轮结束清空。无活动 Task 时为 null。
用 task.set 在当前 Goal 下创建或替换 Task；task.update 按稳定 itemId 更新步骤；task.complete 在全部 done 后收口 Task。
同一 Task 至多一个 doing。工具成功不等于 done，须验证通过后再标 done；验证失败保持 doing 并写 blockedReason。
Runtime 自动把工具与观察关联到 goalId/taskId/activeTaskItemId，不要伪造这些 ID。
Task 全部完成不等于 Goal 完成；Goal 仍须最终验收后再 submitGoal。当前指针见 currentGoalId / activeTaskId / activeTaskItemId。

内容：
{{data}}
</task>
