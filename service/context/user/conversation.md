<conversation>
能力：【Conversation Timeline By Turn】

详细描述：
本会话过程记录。外层是会话级材料，下面按 turnId 嵌套各轮原文；被压缩覆盖的轮次整块删除，只在 <summary> 留摘要。
- <memory>：会话级已确认事实，逐条一个元素，记忆编号写在 memoryId 属性上，与 turn 平级，不切进各轮。
- <summary>：已归档轮次或片段摘要，逐条一个元素（sumId 写在属性上），与原文轮互斥。金字塔结构：level=1 是单轮压缩（对应 turnId），从列出被折叠进来的子摘要 id，故 L2 = 若干 L1 合并、L3 = 若干 L2 合并，依此递推；要回原文，对任一后代 sumId 走 agent_query。折的是最老的一段、最新一条不折，所以越早的轮次层级越高。
- <task>：会话级持久化任务（当前活跃或最近完成的任务实体），与 turn 平级，跨轮全局唯一，直到新任务顶替。
- <turn>：一轮的完整切片，标签属性 turnId 是轮次 ID，from / to 是本段工具调用 ID 首尾（单次调用时两者相同）。二级标签有则写、无则省略：<userInput> 原话；<observations> 观察结果（由 observation_write 写入：页面、代码、截图等）；<notes> 本轮草稿；<reflection> 本轮反思；<query> 本轮查询；<stopReason> 本轮收口。
当前轮永远在最后。读历史时按 turnId 定位，不要把相邻轮次的工具或目标混在一起。
- 容器标签 <conversation> 自带属性：id 是会话 ID（数据层 ledger.conversationId，盘上编号可能跳号，不要据它推算会话总数）；chars / limit / used 是本次窗口 System+User 的字符数、压缩阈值与占用百分比，用来当场判断还能不能再花一次调用去捞东西。三者只有走 inlineBudget 的真实装配才有，离线渲染只有 id。
- 底部 <toolIO> 是全会话公用的跨轮滚动池，自带属性：from / to 是全会话调用 ID 范围，kept 是池内保留的详情条数，total 是全会话调用总数（容量取自 runtimeConfig.context.toolioRingSize，不在本文写死）；池内只列最近 kept 条调用详情，更早的按各轮 <turn> 的 from / to 属性用 evidence_search(callId) 取回。

内容：
{{data}}
</conversation>
