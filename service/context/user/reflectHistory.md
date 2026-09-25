<reflectHistory>
能力：【Ended Turn Reflections】

详细描述：
已结束 turn 的反思历史（按 turnId 追加）。turn 收口时把该轮 <reflection> 原文写入；当前轮反思仍看 <reflection>，不重复写入本栏。
与 turn 一起参与压缩覆盖：该轮进入 <conversationHistorySummary> 后，本栏对应行从窗口滤掉，原文仍可经 agent.query 按 sumId 回查。
activeContext.handoverIntent 取本栏最近一条的末项文本；没有历史时回退当前步骤 text。

内容：
{{data}}
</reflectHistory>
