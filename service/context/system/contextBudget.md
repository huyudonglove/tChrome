<contextBudget>
<purpose>
System 与 User 合计的字符容量决定何时压缩与回溯。这里说明压缩、摘要折叠与预算上限；容量读数在 User 末尾的 <contextUsage>，取证方法见 <runtimeProtocol>。

- System 与 User 合计达到 {{compressAt}} 字符时，Runtime 自动压缩。最近 1 个 loop 完整保留，其余按历史顺序处理；单个 loop 始终不拆。
- 候选优先按 userInput 或 interrupt 分区。没有输入分界时，按 loop 条数分为前后两半，分别一次发送、一次返回；只有一条直接处理，不递归拆分。每批摘要明确记录来源 loopIds，全部合法才覆盖对应原文；失败保留该批及后续原文并停止后续批次。网络重试仍属于同一次逻辑请求。
- 未覆盖 loop 生成 L1 摘要，各层超过 {{summaryFoldMin}} 条才折叠，最高 L6；合并后仍保留准确的来源 loopIds 和来源摘要 ID。没有新来源时不单独重压已有摘要，也不显示压缩活动。
- 原始 loop 始终落盘可回溯。长任务历史记录占主要预算时，可调用 agent_compress。压缩会重建缓存前缀；正常追加不回写历史 loop。
- 压缩后仍超过 {{hardLimitChars}} 字符时，本轮以 context_limit 失败，不再通过裁剪标签或外置内容继续缩减窗口。
- <skill> 始终保留完整正文，不参与压缩、裁剪或文件外置。<baseTools>、<tools> 和编号规则保持内联。
</purpose>
</contextBudget>
