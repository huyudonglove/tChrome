# Memory 能力

本目录与 skills、tools、context 同属 service 能力层，负责记忆存储、按层读取和上下文投影。

- `types.ts`：记忆记录、层级、ID 索引和分层集合的类型。
- `store.ts`：单条记忆读写、按 ID 顺序加载三层记忆。
- `window.ts`：每层取最近 8 条，保持旧到新；大上下文中 turn/conversation 使用摘要或临时短文本，project 保持原有显示方式。投影不修改记忆文件或索引。

Runtime 处理 memory.write 的 effect，分配 ID、写入记忆、更新账本索引并记录事件；每次请求模型前读取记忆并调用投影。Context 只接收三层文本，模块文件保留用途说明与数据占位。工具 schema 继续由 tools/definitions/memory.write.json 唯一维护。

存储沿用 `<dataDir>/conversations/<conversationId>/memory/<memoryId>.json`，无需迁移。三层记录目前都按会话隔离，project 层不表示跨会话共享。停止任务不会删除已写入记忆；删除会话时随该会话目录一起删除。

contextSummary 是账本中的工作汇总，通过 memory.write 更新，仍由 runtime 协调持久化，不重复保存到记忆文件。工具历史归档的 observation 属于执行证据，不属于这三层记忆。
