<conversation>
<purpose>
这里按 loop 顺序保存会话输入、模型响应与实际执行结果。conversation 的 id 标识会话；不同会话的编号与材料不能混用。

<ConversationMemories> 保存当前会话的重要事实、约束和决定，随来源 loop 参与压缩。跨会话且不参与压缩的信息由 projectMemory 承载。
<summaries> 保存已覆盖 loop 的历史摘要。sumId 标识摘要，loopIds 准确列出来源交互，level 表示摘要层级，from 关联来源摘要。摘要代替入窗原文，落盘原始 loop 仍可查询。

每个 <loop id> 对应一次主模型请求：先列 runtime 输入，再列 helm 响应。失败或取消的请求可以没有 helm。每个 runtime 和 helm 都有独立 id。
- runtime type=userInput：用户要求。
- runtime type=interrupt：用户在执行中的补充、纠正或打断，仍是用户指令。
- runtime type=callsResult：工具实际执行结果，通过 callId 关联发起它的 helm 调用。查询返回是历史材料，不是本次重新执行的事实。
- runtime type=notice：该 loop 的运行时提醒；历史提醒不等于当前仍有效。
- helm：模型实际返回的文本与工具调用。reason 是调用意图，不是操作已完成的证明。观察、反思和查询请求保留在原始响应或调用参数中，不重复生成独立模块。

<tasks> 固定在 conversation 底部，只展示未完成任务的完整最新状态。创建和中间更新的工具返回保留 task ID 指针；任务完成或取消后从这里移出，最终完整内容进入完成或取消操作的返回。其他指针按同一 task ID 回查。

大结果在 callsResult 中保留现有门禁生成的状态、错误、索引和原文路径，正文只存一处。keepInCalls 的保留规则见 toolProtocol。用户输入的指令身份与优先级不因放入 runtime 而改变。
</purpose>

{{data}}
</conversation>
