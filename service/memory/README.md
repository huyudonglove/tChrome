# Memory 能力

本目录与 skills、tools、context 同属 service 能力层，负责记忆存储、按层读取和上下文投影。

- `types.ts`：记忆记录、层级、ID 索引和分层集合的类型。
- `store.ts`：单条记忆读写、按会话索引加载会话记忆和按时间加载共享长期记忆。
- `window.ts`：输出全部可见记忆的对象数组，保留 memoryId、turnId、sourceCallId、sourceConversationId（存在时）和完整 text，保持旧到新。投影不修改本地记录。

Runtime 处理 memory.write 的 effect，分配 ID、写入记忆、更新账本索引并记录事件；每次请求模型前读取记忆并调用投影。Context 只接收两层记录数组，模块文件保留用途说明与数据占位。工具 schema 继续由 tools/definitions/memory.write.json 唯一维护。

conversation 存储于 `<dataDir>/conversations/<conversationId>/memory/<memoryId>.json`，保持会话隔离。project 是服务级长期记忆，独立存储于 `<dataDir>/memory/project/<memoryId>.json`，同一 dataDir 下所有会话共享，删除来源会话后仍保留；新记录携带 sourceConversationId 并使用全局 lm_ 编号，不再写入会话账本的 project 索引。

会话记忆写入记录来源 turnId，与当轮要求、执行过程和结果一起交给 service/agents/compression，摘要进入 conversationHistorySummary。原记忆独立落盘，窗口按归档来源覆盖过滤。

Runtime 在请求前过滤已有轮次摘要覆盖的会话记忆；总窗口达到 200,000 字符才触发压缩，不再固定保留最近三轮原文。长期记忆保持全部原文，不参与轮次压缩。常驻 `context.query(sumId, module, intent, cursor?)` 从指定摘要的来源中查询一个模块。模块为 userInput、goalChanges、toolIO、pageObservations、memoryWrites、output、queryHistory 或 summaries。Runtime 装配候选原文，查询 Agent 通过 submitMatches 返回命中的 turnIds，Runtime 校验后将对应记录放入 currentQuery；工具返回只含状态和引用。每次 records 的紧凑 JSON 最多 2000 字符；超出返回 partial 与 nextCursor，可带原查询参数和 cursor 继续读取，无需再次调用查询 Agent。超大单条保留身份字段及 fragment:{offset,totalChars,text}，text 是原记录 JSON 的连续片段，不是摘要。查询不会刷新页面。

新记忆记录持久保存来源 turnId，由 runtime 在 memory.write 执行时填写，与 sourceCallId 一同用于轮次归档关联。两层记忆沿用相同的来源记录结构；记忆层级与有效期不因此改变。User 投影只展示正文。
