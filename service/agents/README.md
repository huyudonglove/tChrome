# 工具类 Agent

`compression/` 和 `query/` 各自拥有独立目录：

- `index.ts`：业务入口与流程；压缩生成分层摘要，查询匹配模块目录并返回原文。
- `protocol.ts`：提示词加载与输入组装、专用返回工具装配、参数校验与业务校验。
- `prompts/`：本 Agent 的 System、User 提示词。
- `index.test.ts`：业务及协议行为验证。

两个 Agent 直接复用现有无状态 `provider.complete`，使用同一套模型配置、协议适配、传输重试和响应解析。Provider 不处理摘要结构、查询候选或其他 Agent 业务规则；这里不另建公共 LLM 请求封装。

`service/context-archive/` 负责不可变原文与摘要存储、目录索引、覆盖关系和来源展开。运行数据继续保存在 `conversations/<conversationId>/compression/<module>/`。Runtime 在发送主请求前触发压缩，`context.query` 工具触发查询；主 Agent 的窗口投影与提示词组装仍由 `service/context/` 管理。

每个 Agent 的 `tools/` 是本 Agent 专用工具 schema 的唯一来源：压缩通过 `submitSummary` 提交 tag 和 summary；查询通过 `submitMatches` 提交 ids（未找到时为空数组）。这些工具仅装配到对应 Agent 请求，不进入主 Agent 工具目录。每次必须恰好调用一次本 Agent 的返回工具，正文不作为业务结果；协议层读取工具文件并按同一 schema 校验参数，目录 ID 范围等语义约束另行校验。

查询请求明确区分两种数据：`request` 仅含主 Agent 的 module、tag、question；`catalog` 由 runtime 从本地目录组装，提供候选 id 和语义描述。查询 Agent 根据前者匹配后者，通过 submitMatches 输出 ID。校验范围直接从同一 catalog 派生，不单独接受另一份 allowedIds，避免目录与校验列表不一致。主 Agent 的 context.query 不接受 ID。
