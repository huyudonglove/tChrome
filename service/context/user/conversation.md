<conversation>
<purpose>
本模块是本会话过程记录——按 turn 嵌套原文、摘要、任务与底部跨轮 calls 池。
外层是会话级材料，下面按 turnId 嵌套各轮原文；被压缩覆盖的轮次只在 <summary> 留摘要。
- <ConverstionMemories>：会话级已确认事实（记忆编号在 memoryId 属性上），与 turn 平级，不切进各轮。
- <summaries>：容器 start / end 是首尾 sumId；内部 <summary> 为历史轮次或片段摘要，逐条一个元素（sumId 写在属性上），与原文轮互斥。金字塔结构：level=1 是单轮压缩（对应 turnId），from 列出被折叠进来的子摘要 id，L2 = 若干 L1 合并、L3 = 若干 L2 合并，依此递推；要回原文，对任一后代 sumId 走 agent_query。
- <tasks>：容器 start / end 是任务 ID；内部 <task> 为会话级持久化任务（当前活跃或最近完成的实体），与 turn 平级，跨轮全局唯一。
- <turn>：一轮的完整切片。标签属性：turnId 是轮次 ID；start / end 是本段工具调用 ID 首尾（单次调用时两者相同）。二级标签分组存放，有则写、无则省略：
  - <userInput> 原话；
  - <observations> 观察结果（页面、代码、截图等，一组包一个容器）；
  - <workspaces> 因果工作区（op=这批做了什么、value=得到什么结论、files[]=涉及的文件路径可带行区间，窗口不限量；boundid=第几次出网，callIds=来源调用，可凭 callIds 用 evidence_search 跟进原文，凭 files 按文件回查因果，一组包一个容器）；
  - <notes> 本轮草稿，每条 <note id key> 的 id 使用 nt_ 编号，key 为业务键，容器 start / end 是首尾笔记 ID；
  - <reflections> 本轮反思（一组包一个容器）；
  - <queries> 本轮查询，每条 <query id> 的 id 使用查询记录的 queryId，容器 start / end 是首尾查询 ID；
  - <stopReason> 本轮收口。
- <runtime>：Runtime 运行时提醒（预算、观察、反思、压缩、轮转、工作区建议），与 turn 平级，每条 <notice id kind scope> 的 id 使用 rt_ 编号，同 kind 只保留最新一条；一次性提醒只出现在当次返回里，不进这里。
- 当前轮永远在最后。读历史时按 turnId 定位，不要把相邻轮次的工具或目标混在一起。
- 容器标签 <conversation> 自带属性：id 是会话 ID（编号可能跳号，不要据它推算会话总数）；chars / limit / used 是本次窗口 System+User 的字符数、压缩阈值与占用百分比，用来当场判断还能不能再花一次调用去捞东西。
- 底部 <calls> 是全会话公用的跨轮滚动池，自带属性：start / end 是全会话调用 ID 范围，kept 是池内保留的详情条数，total 是全会话调用总数；池内只列最近 kept 条调用详情，更早的按各轮 <turn> 的 start / end 属性用 evidence_search(callId) 取回。
</purpose>

{{data}}
</conversation>
