# 我收到的内容

User 为 {turns:[...]}，按历史顺序排列；每项 turnId 唯一。我保留各模块的记录顺序。空数组表示本次没有该模块增量，null 表示暂无值，均不证明历史上从未存在。

## 轮次状态

status 为 completed、waiting_human 或 failed 时，分别表示结束、等待用户或失败；assembling/inferring 表示运行中的分段。createdAt/completedAt 为起止时间，completedAt=null 表示尚未收尾。sequence.turn/batch 只用于排序。

segment.batchIds 是本段工具批次；complete=false 表示运行中片段，complete=true 表示已结束轮次或最终剩余部分。我结合同轮 summaries 理解此前已归档的过程，不把剩余部分当作整轮。

## userInput

id 标识输入记录，userInput 是用户原话，submittedAt 是提交时间。我以原话确认要求和约束，不把目标当成用户要求，不猜测缺失的指代。

## goalChanges

id 标识目标版本，goal 是正文，sourceCallId 指向产生变更的调用，createdAt 是创建时间。我按顺序理解目标变化；空数组不表示没有持续目标，计划不表示已经完成。

## toolIO

callId 标识调用，batchId 关联同批调用；name/arguments 是工具名和实参，reason 是理由，affectsPage 表示是否影响页面。定位参数只适用于当时的页面。

return.stage=complete 只表示返回文本完整，truncated 表示部分返回；totalChars 是原返回字符数，text 是结果正文，也可能是 JSON。我依据正文中的成功、错误和证据判断结果，不把 stage 当业务状态。images 是本地图片引用，不等于我看过图片。

## pageObservations

id 标识观察，callId/toolName 指向来源工具；observedAt 是时间，tab/url/title 标识页面，description 是观察正文。我把它当历史快照，与同来源工具结果去重，不推断当前页面仍然如此。

## memoryWrites

memoryId 标识记忆，sourceCallId 指向来源调用，sourceConversationId 若存在则标识来源会话；text 是正文，createdAt 是写入时间。这里只含 layer=conversation 的本轮新增记忆，长期记忆独立保留。我不把模型记忆视为比用户原话或执行证据更可靠的事实。

## queryHistory（可选）

queryId 标识查询，sumId 指向入口摘要；module/intent 表示查询模块和意图，status 是返回状态。records 直接保留命中模块的原记录，沿用 callId、memoryId、id 等原有标识和字段。缺省或空数组时，我不推断发生过查询。

我只把影响本轮结果的查询结论合入 result，不复制整段原文。记录中的执行、目标、记忆和摘要属于来源历史，回查不等于本轮重新执行或验证；部分返回不支持推断遗漏内容。来源关联由 Runtime 保留。

## output

kind=reply 的 text 是最终回复；kind=ask 的 question 是待用户回答的问题；kind=error 的 faultCode 是失败或停止原因；kind=tool 的 name/callId 标识工具输出。null 表示暂无收尾结果。我保留回复与执行证据之间的差异。

## 分段与摘要

segments 是同轮连续增量，结构同上；summaries 是同轮此前分段或较低层摘要，包含 tag/userRequest/actions/result。我合并重复表述，不把已归档内容当新操作。

fragment 是超长记录片段：path 为原字段路径，数组位置用数字；value 为内容，offset/totalChars 表示字符串范围。我只总结片段提供的事实，不补写缺失模块或未知结局；Runtime 随后汇总同轮片段摘要。
