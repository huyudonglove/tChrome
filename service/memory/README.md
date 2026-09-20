# Memory 能力

本目录与 skills、tools、context 同属 service 能力层，负责记忆存储、按层读取和上下文投影。

- `types.ts`：记忆记录、层级、ID 索引和分层集合的类型。
- `store.ts`：单条记忆读写、按会话索引加载会话记忆和按时间加载共享长期记忆。
- `window.ts`：输出全部可见记忆的对象数组，保留 memoryId、turnId、sourceCallId、sourceConversationId（存在时）和完整 text，保持旧到新。投影不修改本地记录。

Runtime 处理 memory.write / memory.update / memory.delete 的 effect，分配或按 mm_/lm_ 修改删除记忆、更新账本索引并记录事件；每次请求模型前读取记忆并调用投影。Context 只接收两层记录数组，模块文件保留用途说明与数据占位。工具 schema 由 tools/definitions/memory.*.json 维护。memory.write/update/delete 与 memory.write 同属常驻 baseTools，不是动态 catalog 工具。

conversation 存储于 `<dataDir>/conversations/<conversationId>/memory/<memoryId>.json`，保持会话隔离。project 是服务级长期记忆，独立存储于 `<dataDir>/memory/project/<memoryId>.json`，同一 dataDir 下所有会话共享，删除来源会话后仍保留；新记录携带 sourceConversationId 并使用全局 lm_ 编号，不写入会话账本的 project 索引。

Runtime 在请求前按压缩覆盖关系过滤会话记忆；总窗口达到 200,000 字符触发压缩。长期记忆保持全部原文，不参与轮次压缩。会话记忆写入记录来源 turnId，与当轮材料一并进入 compression，摘要出现在 conversationHistorySummary；原记忆独立落盘。

常驻 `context.query(sumId, module, intent)` 从指定摘要的来源查询模块（userInput、goalChanges、toolIO、pageObservations、memoryWrites、output、queryHistory 或 summaries）。Query Agent 用 submitMatches 返回命中的 turnId，Runtime 校验后把完整 records 放入 currentQuery；`<toolIO>` 只投影 currentQuery 指针。查询结果与其它工具返回共用统一内联门禁。

新记忆记录由 runtime 在 memory.write 时填写来源 turnId 与 sourceCallId，用于轮次归档关联。User 投影只展示正文。
