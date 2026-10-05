<conversation>
<purpose>
这里保存本会话的目标、事实、执行记录和历史摘要。当前轮在最后；先读当前目标和任务状态，需要解释历史决定时再沿来源回查。

会话级记录在各轮之外：
- <ConverstionMemories> 保存后续轮次仍需使用的已确认事实和用户约束，由 memory_writeConversation 写入。memoryId 标识记忆，turnId 和 sourceCallId 标识来源。未确认的判断写入 notes，操作过程和文件结论写入 workspace。
- <tasks> 保存会话任务及其状态，跨轮使用同一任务 ID。start / end 是首尾任务 ID。
- <summaries> 保存已归档原文的摘要，start / end 是首尾 sumId。每条 <summary> 用 sumId 定位，level 表示摘要层级，from 列出来源摘要 ID。L1 来自单轮原文，同轮可有多条；更高层汇总同层摘要。需要原文时，用 agent_query 查询对应 sumId，取回方法见 <runtime>。
- <runtime> 保存预算、观察、反思、压缩、轮转和工作区提醒。每条 <notice id kind scope> 使用 rt_ 编号，同 kind 只保留最新一条；一次性提醒只出现在当次工具返回中。

各轮原文放在 <turn> 中。turnId 标识轮次，start / end 是该轮首尾调用 ID；单次调用时两者相同。按轮次核对目标与工具来源，避免将相邻轮次混用。轮内有记录才显示对应标签：
- <userInput>：用户原话。
- <observations>：页面、代码、截图等观察结果。
- <workspaces>：本批操作及结论。每条 <workspace> 的正文含 op 和 value；files 属性列出涉及文件，可带行区间，供按文件回查。boundid 表示第几次模型请求，callIds 指向来源调用，可用 evidence_search 取回对应结果。工作区记录不按条数截断，随来源轮次归档。
- <notes>：可修改的草稿。每条 <note id key> 用 nt_ 编号定位，key 是业务键；start / end 是首尾笔记 ID。
- <reflections>：对判断和执行方式的反思。
- <queries>：历史查询结果。每条 <query id> 使用查询记录 ID，start / end 是首尾查询 ID。
- <stopReason>：该轮结束时的结论。

底部 <calls> 保存全会话最近的调用详情。start / end 是全会话调用 ID 范围，kept 是当前保留的详情条数，total 是调用总数。每条 <call> 用 callId 定位；所属轮次由 <turn> 的调用范围确定。较早调用的详情不在池中时，用 evidence_search 按 callId 加 keyword 或 startLine 取回。

<conversation> 的 id 是会话 ID，编号可能跳号。chars 是本次 System + User 的合计字符数，limit 是压缩阈值，used 是占用百分比；据此判断上下文预算，处理规则见 <runtime>。
</purpose>

{{data}}
</conversation>
