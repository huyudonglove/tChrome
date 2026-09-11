# Memory 能力

本目录与 skills、tools、context 同属 service 能力层，负责记忆存储、按层读取和上下文投影。

- `types.ts`：记忆记录、层级、ID 索引和分层集合的类型。
- `store.ts`：单条记忆读写、按 ID 顺序加载两层记忆。
- `window.ts`：输出全部可见记忆的完整文本数组，隐藏 ID 和来源元数据，保持旧到新；不取最近 8 条，不根据旧 compressed/summary 字段替换或裁短正文。投影不修改本地记录。

Runtime 处理 memory.write 的 effect，分配 ID、写入记忆、更新账本索引并记录事件；每次请求模型前读取记忆并调用投影。Context 只接收两层记录数组，模块文件保留用途说明与数据占位。工具 schema 继续由 tools/definitions/memory.write.json 唯一维护。

conversation 存储于 `<dataDir>/conversations/<conversationId>/memory/<memoryId>.json`，保持会话隔离。project 是服务级长期记忆，独立存储于 `<dataDir>/memory/project/<memoryId>.json`，同一 dataDir 下所有会话共享，删除来源会话后仍保留；新记录携带 sourceConversationId 并使用全局 lm_ 编号，不再写入会话账本的 project 索引。

首次读取/写入长期记忆或删除会话前，自动将旧会话目录中的 project 记录复制到共享目录，使用 legacy_<conversationId>_<memoryId> 避免旧ID碰撞，保留来源与原文件。完成后写入迁移标记；中断重试幂等。后续读取只使用共享目录，旧账本 project 索引仅作为历史数据保留。

会话记忆压缩由 service/compression 提供，摘要进入 conversationMemorySummary。工具证据进入 toolIOSummary，两者不混合。

读取旧会话账本时，将旧 turn 索引与 conversation 索引按 ID 去重，按记录时间及 ID 数字序合并到 conversation；旧 turn 文件原地更新为 conversation，正文、摘要和来源保持不变，迁移可重复执行。Notes 承担会话草稿用途，不再保留独立的过程记忆层。

Runtime 在请求前过滤已有摘要覆盖的会话记忆；达到总窗口阈值时，保留最近 3 条，其余交独立 LLM 压缩。长期记忆保持全部原文，不参与这四个模块的压缩。常驻 `context.query(module, tag, question?)` 将主题交给查询 Agent 语义匹配本会话对应模块目录，由 runtime 校验内部 ID、沿来源关系读取原文并去重，按原顺序返回。主 Agent 无需提供记录 ID。只检索已压缩归档；支持多条或 not_found，单次原文内容上限 30,000 字符，超过时返回 partial 和遗漏数量，不截断单条原文。请缩小主题或问题后再查；单条原文本身超过上限时也会明确返回 partial。查询不会刷新页面。
