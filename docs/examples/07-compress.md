# 07 轮次压缩与委托查询

当前实现以 `service/agents/compression/`、`service/agents/query/`、`service/context-archive/` 和 `service/runtime/context-state.ts` 为准。两个 Agent 各自管理 `context/` XML 模块、输入输出协议和专用返回工具，直接复用现有无状态 `provider.complete`。

每次发送主模型前，Runtime 检测 System + User 文本长度；达到 200,000 字符才触发压缩。按 turnId 汇集当轮输入、目标变化、工具调用与完整返回、页面观察、会话记忆写入、查询历史和最终输出，所有已结束轮次均可归档，当前轮次按完整工具批次处理。本阶段选中的较早轮次一次提交，但每轮分别生成 tag、userRequest、actions、result，追加到 conversationHistorySummary。若归档较早轮次后仍达到阈值，再归档当前轮次较早的执行片段，保留最近 2 个完整工具批次。当前输入、目标、当前页面、notes、长期记忆和 currentQuery 保持可见；currentQuery 计入总窗口但不参与压缩，queryHistory 作为取证参考，结论合入 result。每轮独立保留摘要。

模型输出校验成功、完整来源与摘要落盘后，才原子更新目录索引和覆盖关系。失败或取消不提交该批次覆盖，原文继续可用；此前成功提交的归档保留。索引是提交点，中断可能留下未被索引引用的文件。窗口按来源覆盖过滤历史输入、已结束目标、页面观察、会话记忆写入和工具记录，本地原文不删除。

归档位于 `conversations/<conversationId>/compression/conversationHistory/`：`sources/` 保存完整来源，`records/` 保存不可变摘要，`index.json` 管理目录及覆盖关系。摘要由 runtime 关联真实 turnId；各轮请求、行动与结果分别保存。当前轮次执行片段只描述归档时的事实，不声称该轮已经结束。历史结果不自动成为当前待办。

常驻 `context.query(sumId, module, intent)` 从指定摘要的来源中查询一个模块。模块为 userInput、goalChanges、toolIO、pageObservations、memoryWrites、output、queryHistory 或 summaries。Runtime 装配候选原文，Query Agent 通过 submitMatches 返回命中的 turnIds，Runtime 校验后将完整 records 放入 currentQuery；`<toolIO>` 只投影 currentQuery 指针。查询结果与其它工具返回共用统一内联门禁（默认 4000 字符），超出时注入 externalized 摘要（preview+path+totalLines/lineWidth）；本地全文按默认 100 字/行拆行，可用 evidence.search 按 keyword 或只传 startLine（约 400 字窗口）检索。查询不会刷新页面。

发送前达到 200000 字符触发压缩，达到 250000 字符时将 notes 正文保存到本地并替换为文件路径；处理后仍达到硬门槛才返回 context_limit。压缩外层保留 history/current 阶段，各阶段选中的材料完整请求一次，不在 Agent 内分批或递归压缩。查询候选同样完整请求一次，返回分页不拆分模型请求。验证覆盖运行时发送前触发、近期记录保留、批量逐轮结果、取消和归档回查；模拟模型测试不能证明真实模型的摘要与匹配质量。
