# 上下文模块

modules.json 是模块顺序、用途说明及压缩材料的唯一注册表。所有 purpose 仅注入 System；User 只包含动态数据。

### System

| order | id | 文件 / 材料 |
|---|---|---|
| 1 | overview | system/overview.md |
| 2 | identity | system/identity.md |
| 3 | environment | system/environment.md |
| 4 | runtimeProtocol | system/runtimeProtocol.md |
| 5 | recordIdentity | system/recordIdentity.md |
| 6 | execution | system/execution.md |
| 7 | toolProtocol | system/toolProtocol.md |
| 8 | boundaries | system/boundaries.md |
| 9 | output | system/output.md |
| 10 | baseTools | system/baseTools.md |
| 11 | systemSkill | system/systemSkill.md |

### User

| order | id | 文件 / 材料 |
|---|---|---|
| 1 | skill | user/skill.md |
| 2 | projectMemory | user/projectMemory.md |
| 3 | tools | user/tools.md |
| 4 | conversation | user/conversation.md |
| 5 | contextUsage | user/contextUsage.md |

### Archive

| order | id | 文件 / 材料 |
|---|---|---|
| 1 | loops | loops |

## 交互与状态

conversation 依次包含 ConversationMemories、summaries、loop 历史和末尾 tasks。loop 对应一次主模型请求，runtime 在前、helm 在后；两者有独立 ID。runtime type 为 userInput、interrupt、callsResult 或 notice。helm 保留实际响应文本和工具调用。callId 关联调用及下一 loop 的执行结果。失败请求可以没有 helm。

未完成任务集中放在 tasks；创建及中间更新返回只留 task ID 指针，完成或取消返回最终完整任务并从 tasks 移出。观察、反思、查询与操作证据直接保留在产生它们的调用及结果中，不另设重复模块。

keepInCalls 在执行时解析并固定：true 保留到压缩，false 只在最近结果 loop 展示。完整历史仍落盘。大结果沿用返回门禁的索引与原文路径，不重新展开。

contextUsage 是整条 User 最末尾的模块，其 chars、compressAt、used 属性统计 System + User 的字符容量。conversation 头只有稳定 id；历史 loop 不回写，任务状态与容量读数在尾部变化。

## 压缩与回溯

最近一个 loop 完整保留；其他候选按 userInput / interrupt 分区。无分界时按条数分为前后两批，一条直接处理，loop 不拆、不递归。摘要逐批验证后覆盖入窗原文，失败停止后续批次，来源 loopIds 始终可回溯。skill 完整保留且不参与压缩。
