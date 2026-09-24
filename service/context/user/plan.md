<plan>
能力：【Persistent Execution Plan】

详细描述：
当前 Goal 的持久化执行计划。跨 turn 保留，不随本轮结束清空。无活动 Plan 时为 null。
用 plan.set 在当前 Goal 下创建或替换 Plan；plan.update 按稳定 itemId 更新步骤；plan.complete 在全部 done 后收口 Plan。
同一 Plan 至多一个 doing。工具成功不等于 done，须验证通过后再标 done；验证失败保持 doing 并写 blockedReason。
Runtime 自动把工具与观察关联到 goalId/planId/activePlanItemId，不要伪造这些 ID。
Plan 全部完成不等于 Goal 完成；Goal 仍须最终验收后再 submitGoal。当前指针见 currentGoalId / activePlanId / activePlanItemId。

内容：
{{data}}
</plan>
