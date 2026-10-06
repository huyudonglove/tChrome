<conversation>
<purpose>
这里保存本会话的目标、事实、执行记录和历史摘要。当前轮在最后；先读当前目标和任务状态，需要解释历史决定时再沿来源回查。

会话级记录在各轮之外：
- <ConversationMemories> 保存当前会话的重要事实、约束和决定，由 memory_writeConversation 写入。它随来源轮次参与压缩；对应原文被覆盖后，窗口中由摘要承接这些信息，不再展示该条记忆全文，落盘原记录仍保留。需要跨会话使用且不参与压缩的信息写入 projectMemory，被注入时保留全文。memoryId 标识记忆，turnId 和 sourceCallId 标识来源。未确认的想法写入 notes，显式设置 keepInCalls=true 的工具操作及结果内容由 Runtime 自动记录到 workspace；观察判断与方案取舍分别写入 observations 和 reflections。
- <tasks> 保存会话任务及其执行进度，跨轮使用同一任务 ID。start / end 是首尾任务 ID；completed 表示任务步骤已完成。执行进度与结果交付的关系见 <overview>。
- <summaries> 保存已归档原文的摘要，start / end 是首尾 sumId。每条 <summary> 用 sumId 定位，level 表示摘要层级，from 列出来源摘要 ID。L1 来自单轮原文，同轮可有多条；更高层汇总同层摘要。需要原文时，用 agent_query 查询对应 sumId，取回方法见 <runtimeProtocol>。
- <workspaces> 保存显式设置 keepInCalls=true 时由 Runtime 自动记录的工具操作及结果内容；false 或省略不写入。工作区按 target 对象在会话级归组展示。对象种类为 file、browser、script、process 和 tool；同文件内容合并，shell 命令不推断文件路径。每项操作证据保存 op、args、result、content、range、mutation 及来源 id、turnId、callId、boundId。归组不改变来源：每项证据仍归属来源 turn，随该轮压缩归档，calls 保留 workspace 引用。这里保存执行事实，观察判断与方案取舍保存在 observations 和 reflections。

各轮原文放在 <turn> 中。turnId 标识轮次，start / end 是该轮首尾调用 ID；单次调用时两者相同。按轮次核对目标与工具来源，避免将相邻轮次混用。轮内有记录才显示对应标签：
- <userInput>：用户原话。
- <observations>：页面、代码、截图等观察结果。
- <notes>：可修改的草稿。每条 <note id key> 用 nt_ 编号定位，key 是业务键；start / end 是首尾笔记 ID。
- <reflections>：对判断和执行方式的反思。
- <queries>：历史查询结果。每条 <query id> 使用查询记录 ID，start / end 是首尾查询 ID。
- <stopReason>：该轮结束时的结论。

每轮的 <calls> 保存该轮当前可见的调用详情。start / end 是该轮调用 ID 范围，kept 是本次可见条数，total 是该轮调用总数。每条 <call> 用全会话唯一的 callId 定位。保留规则和 keepInCalls 用法见 <toolProtocol>。

窗口中未展示的调用仍完整保存，按所属轮次参与压缩；可凭 callId 按 <runtimeProtocol> 的方法取回原文。

<conversation> 的 id 是会话 ID，编号可能跳号。chars 是本次 System + User 的合计字符数，limit 是压缩阈值，used 是占用百分比；据此判断上下文预算，处理规则见 <runtimeProtocol>。
</purpose>

{{data}}
</conversation>
