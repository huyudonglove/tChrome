<conversation>
能力：【Conversation Timeline By Turn】

详细描述：
本会话过程记录。外层是会话级材料，下面按 turnId 嵌套各轮原文；被压缩覆盖的轮次整块删除，只在 <conversationHistorySummary> 留摘要。
- <conversationMemory>：会话级已确认事实，与 turn 平级，不切进各轮。
- <conversationHistorySummary>：已归档轮次或片段摘要（sumId），与原文轮互斥。金字塔结构：level=1 是单轮压缩（对应 turnId），从列出被折叠进来的子摘要 id，故 L2 = 若干 L1 合并、L3 = 若干 L2 合并，依此递推；要回原文，对任一后代 sumId 走 agent_query。折的是最老的一段、最新一条不折，所以越早的轮次层级越高。
- <reflectionStatus>：会话级反思状态（条数与最近一条 focus），只给计数不展开正文；正文仍在各轮 <reflection> 里。
- <task>：会话级持久化任务（当前活跃或最近完成的任务实体），与 turn 平级，跨轮全局唯一，直到新任务顶替。
- <tn_xx>：一轮的完整切片。二级标签有则写、无则省略：<userInput> 原话；<callRange> 本段工具调用 ID 范围（首尾即可）；<observations> 观察结果（由 observation_write 写入：页面、代码、截图等）；<notes> 本轮草稿；<reflection> 本轮反思；<query> 本轮查询；<stopReason> 本轮收口。
当前轮永远在最后。读历史时按 turnId 定位，不要把相邻轮次的工具或目标混在一起。
- 容器标签 <conversation> 自带属性：id 是会话 ID（数据层 ledger.conversationId，盘上编号可能跳号，不要据它推算会话总数）；chars / limit / used 是本次窗口 System+User 的字符数、压缩阈值与占用百分比，用来当场判断还能不能再花一次调用去捞东西。三者只有走 inlineBudget 的真实装配才有，离线渲染只有 id。
- 外层底部另有全会话公用的 <toolRange>（会话级调用范围）与 <toolIO>（跨轮滚动池：仅保留最近 10 次调用详情；更早调用按各轮 <callRange> 用 evidence_search(callId) 取回）。

内容：
{{data}}
</conversation>
