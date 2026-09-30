<conversation>
能力：【Conversation Timeline By Turn】

详细描述：
本会话过程记录。外层是会话级材料，下面按 turnId 嵌套各轮原文；被压缩覆盖的轮次整块删除，只在 <conversationHistorySummary> 留摘要。
- <conversationMemory>：会话级已确认事实，与 turn 平级，不切进各轮。
- <conversationHistorySummary>：已归档轮次或片段摘要（sumId），与原文轮互斥。
- <tn_xx>：一轮的完整切片。二级标签有则写、无则省略：<userInput> 原话；<task> 任务与事件；<toolRange> 本段工具调用 ID 范围；<toolIO> 工具调用与返回（仅最近 10 次详情）；<actions> 本轮工具调用流水（actions.write 维护）；<observations> 观察结果（由 observation.write 写入：页面、代码、截图等）；<notes> 本轮草稿；<reflection> 本轮反思；<query> 本轮查询；<stopReason> 本轮收口。
当前轮永远在最后。读历史时按 turnId 定位，不要把相邻轮次的工具或目标混在一起。

内容：
{{data}}
</conversation>
