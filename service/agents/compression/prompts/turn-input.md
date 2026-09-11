# 输入结构与字段

User 是 JSON 对象 {turns:[...]}。turns 按历史顺序排列，每项有唯一 turnId；数组内保留各模块原始顺序，空数组表示本次没有该模块的增量，null 表示暂无值。每轮分别处理，不跨轮推断或合并。

## 轮次元数据
- turnId：本次摘要必须原样返回的轮次标识，不是业务任务号。
- conversationId：所属会话，turnId 仅在该会话内唯一。
- status：completed 已结束、waiting_human 等用户、failed 失败；assembling/inferring 表示尚未结束的长轮次分段，不能宣布整轮结束。
- createdAt、completedAt：轮次起止时间；completedAt 为 null 表示还没有收尾时间。
- sequence.turn、sequence.batch：runtime 的轮次和批次排序位置，仅用于归档先后，不是成功证据。
- segment（可选）：batchIds 是本段已完成工具批次；complete=false 表示仍在运行的轮次片段；complete=true 表示已结束轮次或此前分段后剩余的最终部分。此前已归档部分可通过同轮 summaries 提供，不能把剩余部分误认为全部过程。分段不代表新一轮。

## userInput：用户原话对象
id 是记录标识，turnId 是来源轮次，userInput 是原话，submittedAt 是提交时间。用户要求与约束以原话为准；“继续”等指代缺少背景时不猜测。目标是模型计划，不能冒充用户原话。

## goalChanges：本轮目标版本数组
每项 id 为版本标识，turnId 为创建轮次，goal 为目标正文，sourceCallId 为产生变更的工具调用，createdAt 为创建时间。空数组只表示本轮没改目标，不表示没有持续目标。多个版本保留变更顺序；计划不是完成证据。

## toolIO：工具执行数组
每项 turnId 表示来源，batchId 表示同批次，callId 标识调用，name 是工具名，arguments 是实际参数。arguments.reason 是调用理由，affectsPage 表示影响页面；定位参数只在相应执行时有意义。
return 是执行结果：stage=complete 表示返回文本完整，truncated 表示只有部分；totalChars 是原返回字符数；text 是具体工具返回内容（可能自身为 JSON）。理解 text 的 ok、错误与实际证据，不把 return.stage=complete 当作业务成功。images 若存在是本地图片引用，并不代表已读到了图片内容。没有证据支持的结果不能补写。

## pageObservations：页面观察数组
每项 id 为观察标识，turnId 为所属轮次，callId/toolName 为工具来源，observedAt 为时间，tab/url/title 为页面身份，description 为观察内容。它们是历史快照，和同来源工具结果可能重复。观察差异表示当时状态变化，不代表当前页面仍如此。

## memoryWrites：本轮新增记忆数组
这里只归集本轮新增会话记忆，长期记忆作为独立状态保留。memoryId 为记录标识，layer=conversation 表示会话层级，turnId 为写入轮次，text 为正文，sourceCallId 为来源工具，createdAt 为写入时间，sourceConversationId（存在时）为来源会话。summary 是记忆条目已有的简述，compressed 标识记忆存储状态，不代表本轮工具事实已被验证。只含本轮增量，不是全部记忆。模型写入的认识不天然比用户原话或执行证据可靠，冲突要保留。

## output：本轮对外结果或 null
kind=reply 的 text 是最终回复；kind=ask 的 question 是等待用户的问题；kind=error 的 faultCode 是失败或停止原因；kind=tool 的 name/callId 仅标识工具输出。null 表示暂无收尾结果。最终回复声称成功但工具失败时，必须明确差异。

## 长轮次与多层输入
segments 数组存在时，各项是同一 turnId 的连续增量记录，结构同上；结合 summaries 中此前本轮摘要理解，不把已归档部分当作新操作。summaries 是同一轮较早分段或较低层摘要，每项含 tag/userRequest/actions/result，可含 turnId；它们保持当时含义，禁止混入另一轮。
fragment 用于超长记录的临时拆分：path 为原模块字段路径（数组位置是数字），value 为该字段内容；字符串过长时 offset/totalChars 标识连续字符范围。只概括该片段提供的事实，其余模块缺失不等于不存在。后续 runtime 会汇总同轮片段摘要。不要把片段当完整轮次，不凭片段补写未知结局。
