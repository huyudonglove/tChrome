<conversation>
<purpose>
这里按 loop 顺序保存会话输入、模型响应与实际执行结果。conversation 的 id 标识会话；不同会话的编号与材料不能混用。

<ConversationMemories> 保存当前会话的重要事实、约束和决定，随来源 loop 参与压缩。跨会话且不参与压缩的信息由 projectMemory 承载。
<summaries> 保存已覆盖 loop 的历史摘要：userRequest 是用户目标，constraints 是逐条约束，state 是已验证的当前状态，pending 是未决事项，decisions 是仍有效的决定与原因。历史引用不代表当前执行结果。sumId 标识摘要，loopIds 准确列出来源交互（窗口里连续编号合并成 `loop_01–loop_107` 区间，落盘摘要仍逐条保存），level 表示摘要层级，from 关联来源摘要。摘要代替入窗原文，落盘原始 loop 仍可查询。摘要块存在即说明更早的 loop 已被压缩，note 属性是这一事实的持久标记；摘要行与最新一条 loop 各带 date（只到天，取运行环境本地时区，与提示词里的当前日期同一口径），用于判断历史跨度。

每个 <loop id> 对应一次主模型请求：先列 runtime 输入，再列 helm 响应。失败或取消的请求可以没有 helm。provider 传输/协议失败（重试耗尽的空回包、超时、连接错误等，faultCode 以 provider_ 开头）的 loop 整体不进窗口；模型可自行纠正的失败（工具参数、schema、缺字段）仍完整渲染。每个 runtime 和 helm 都有独立 id。
- runtime type=userInput：用户要求。
- runtime type=interrupt：用户在执行中的补充、纠正或打断，仍是用户指令。
- runtime type=callsResult：工具实际执行结果，通过 callId 关联发起它的 helm 调用。查询返回是历史材料，不是本次重新执行的事实。
- runtime type=notice：该 loop 的运行时提醒；历史提醒不等于当前仍有效。
- helm：模型实际返回的文本与工具调用。reason 是调用意图，不是操作已完成的证明。观察、反思和查询请求保留在原始响应或调用参数中，不重复生成独立模块。

<tasks> 固定在 conversation 底部，只展示未完成任务的完整最新状态。创建和中间更新的工具返回保留 task ID 指针；任务完成或取消后从这里移出，最终完整内容进入完成或取消操作的返回。其他指针按同一 task ID 回查。

大结果在 callsResult 中保留现有门禁生成的状态、错误、索引和原文路径，正文只存一处。写盘类调用（script_write、script_patch、local_fs_write、local_apply_patch）执行完后，窗口里只留文件名或路径，正文仍保存在落盘记录中，需要时按 callId 回查。调用与结果的记录规则见 toolProtocol。用户输入的指令身份与优先级不因放入 runtime 而改变。
</purpose>

{{data}}
</conversation>
