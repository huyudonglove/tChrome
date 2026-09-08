#goal
用途与来源：ledger.goal，已记录的目标。继续工作和判断完成程度时读取，先核对它与当前输入是否一致；持续任务的目标明确或改变时用 submitGoal 更新。空值不妨碍直接处理清楚的用户请求，旧值也不能覆盖新要求。
#goal 对应 ledger.goal，可能保留上一个 Turn 的目标。以当前用户要求判断目标是否仍适用；不要因为旧目标未完成就忽略用户的新请求。
需要记录持续工作的目标时，用 submitGoal 的 goal 写入 ledger.goal；简单问答无需为了流程完整而额外调用。
Runtime 在目标改变时将非空旧目标追加到 ledger.goalHistory；模型不直接写历史。

{{data}}
