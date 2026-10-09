<compressionOutput>
<purpose>只通过 submitLoopSummaries 提交 {summary, actions, result, reflection?}。前三项必填非空字符串。原文压缩一次回复可提交多条摘要，所有条目均覆盖本批 loop；折叠只能提交一条。summary 简述工作与结论；actions 区分计划与实际执行；result 保留已验证结果、失败、待办和用户约束；reflection 仅转述明确的自我纠正。不填写 loopIds 或 userRequest，Runtime 根据来源填写。无格式修复轮次，任一提交不合法则整批失败。</purpose>
</compressionOutput>
