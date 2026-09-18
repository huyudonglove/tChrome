# 输入语义

User 为 {turns:[...]}，按历史顺序排列；每项 turnId 唯一，模块内保持原顺序。空数组或 null 只表示本次未提供内容，不证明历史上从未存在。

## 轮次与分段

status 的 completed、waiting_human、failed 分别表示结束、等待用户、失败；assembling/inferring 表示运行中。createdAt/completedAt 是起止时间，completedAt=null 表示未提供收尾时间。conversationId 标识所属会话。sequence.turn/batch 用于排序。

segment.batchIds 标识本段工具批次；complete=false 为增量，complete=true 为已结束轮次或最终剩余部分。增量也可能只补入历史查询，不能据此认定原轮次未结束。segments 是同轮连续增量；summaries 是同轮此前摘要。结合它们理解此前过程、合并重复表述，不把剩余片段当作整轮或把已有摘要当成新操作。

本次待处理的 turns 一次性提供，每个轮次独立返回一份摘要。只总结已有内容，不补写缺失模块或未知结局。

## 模块

下列模块是 Runtime 选中的归档材料，不是主模型当前窗口投影。toolIO 与 pageObservations 都会提供，彼此不做指针去重。

- userInput：id 标识消息，userInput 是原话，submittedAt 是提交时间。补入查询的片段可省略此模块，不表示用户没有输入。
- goalChanges：目标更新时的快照；id 固定，parentId 关联总目标，status 表示当时状态，goal 是正文，sourceCallId 关联本次变更。同一目标可多次出现；空数组不表示没有持续目标。
- toolIO：callId 标识调用，batchId 关联批次，turnId 所属轮次，name/arguments 是工具与实参；reason 是理由，affectsPage 声明页面影响，定位参数只适用于当时页面。return.stage=complete 仅表示文本完整，truncated 表示部分返回；totalChars 是原长度，text 是写入账本的返回正文（可能为 JSON）。超量时 text 可能是 externalized 摘要（含 preview、path、totalLines、lineWidth，不是全文）；只按已提供的 text 判断业务结果，不补写未给出的内容。images 引用不等于看过图片。
- pageObservations：id 标识观察，turnId/callId 关联轮次与来源调用，batchId 关联批次，observedAt 是时间，tabId 是目标标签，type 是产生观察的工具名，result 是该次观察记录的返回值（对象，可能含 ok、页面字段或错误信息）。超量时 result 可能是 externalized 摘要（含 totalLines、lineWidth）；被 page.clear_result 清空后为 {ok:true,cleared:true}。与同 callId 的 toolIO 可能描述同一操作，两份都读；不推断页面当前状态。
- memoryWrites：本轮会话记忆写入，memoryId 标识条目，sourceCallId/sourceConversationId 关联来源，text 是正文，createdAt 是时间。记忆不能覆盖用户原话或执行证据。
- output：kind 区分收尾形态：reply.text 是最终回复，ask.question 是待回答问题，error.faultCode 是失败或停止原因，tool.name/callId 标识工具输出；null 表示暂无收尾结果。保留回复与执行证据的差异。

## queryHistory（可选）

queryId 标识查询，sumId 指向入口摘要，module/intent 是查询条件，status 是返回状态；records 保留原模块字段和 ID。查询顶层 turnId 是发起轮次，records 内 turnId 是来源轮次。

只把影响本轮结果的查询结论合入 result，不复制原文；回查不等于本轮重新执行或验证历史操作。错误、部分返回或空值不支持推断未返回的证据。
