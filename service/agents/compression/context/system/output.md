<compressionOutput>
<purpose>只通过 submitLoopSummaries 提交 {userRequest, state, constraints, pending, decisions}，五项全部必填。userRequest 与 state 是非空字符串；constraints、pending、decisions 是字符串数组，每个元素非空，没有内容时填 []。userRequest 归纳用户要求与目标，保留不同要求；材料无法确定目标时明确说明未提供，不猜测；state 归纳实际执行、已验证结果、重要失败与当前进展，区分计划、执行证据和模型声明；constraints 逐条保留仍有效的用户约束；pending 逐条保留尚未解决、完成或确认的事项；decisions 保留关键决策及原因和明确的自我纠正。所有字段由模型依据材料归纳，不逐字拼接或截断原文。原文压缩一次回复可提交多条摘要，所有条目均覆盖本批 loop；折叠只能提交一条。不要提交 loopIds，也不要在正文罗列来源编号，Runtime 根据来源填写准确 loopIds。无格式修复轮次，任一提交不合法则整批失败。</purpose>
</compressionOutput>
