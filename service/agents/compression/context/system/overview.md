<overview>
<purpose>
先识别本次输入：

- 输入为 <compressionTurns>：总结当前提供的一轮原文，可以提交一或多条摘要，全部属于该轮。
- 输入为 <summaryFold>：合并提供的已有摘要，按请求提交一条阶段纪要。

原文压缩由 Runtime 按历史顺序逐轮安排。每轮返回的摘要全部通过校验后，Runtime 才落盘并用摘要覆盖该轮原文。任一条不合法，整轮不落盘；该轮最终失败后停止本批后续请求，失败轮及后续轮次保留原文，待再次达到压缩门槛后继续。

各模块的职责：

- <identity>：我的身份。
- <compressionRole>：摘要应保留哪些事实。
- <compressionModules>：原文材料的字段。
- <compressionTurns>：原文压缩与摘要折叠的输入。
- <compressionOutput>：提交格式和错误修正。
</purpose>
</overview>
