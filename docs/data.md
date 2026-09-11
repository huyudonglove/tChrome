# 数据存储与执行循环

运行时数据保存在 `~/Library/Application Support/tChrome/`。`session.json` 指向当前会话；会话账本、轮次、会话记忆和归档按会话保存，项目长期记忆独立保存。完整目录与字段统一见 [schema](schema.md)。

用户输入创建新 Turn。本轮内模型可以多次调用工具；Runtime 持久化工具结果、目标变更、页面观察和记忆写入，再组装下一次请求。增量记录通过 `turnId` 关联到所属轮次，当前目标、当前页面和 notes 保存当前工作状态。

每次发送主模型前，Runtime 统计 System + User 文本字符数，达到 200000 时启动模型压缩。历史记录按 Turn 分组并批量压缩，保留最近 3 个已结束轮次和当前轮次。当前轮次仍过长时，归档较早的完整工具批次并保留最近 2 个批次；必要时在同一触发流程中继续压缩已有摘要。

摘要通过专用工具返回并校验，原文和摘要写入本地归档后才更新覆盖索引。窗口使用 `#conversationHistorySummary` 展示摘要，原始记录保留；压缩失败或取消不推进覆盖状态。仍然超限时返回 `context_limit`，不裁剪正文。

主模型通过 `context.query` 提交 `module: "conversationHistory"` 和 tag。查询 Agent 匹配目录中的归档 ID，Runtime 展开对应原文。单次查询最多返回 30000 字符的完整记录，超出时明确返回 `partial`。

当前流程示例见 [上下文装配](examples/02-context-engineering.md)、[模型请求](examples/04-provider-request.md)、[压缩与查询](examples/07-compress.md)和[结束轮次](examples/08-finish-turn.md)。
