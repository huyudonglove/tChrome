# ID 清单

`catalog.json` 是记录 ID 的唯一规则入口：字段名、类型前缀、范围和分配方式均在此维护。System 集中说明通用编号规则和 turnId 关联；各 User 模块只解释自身 ID 的含义。编号示例、范围和 User 数据契约的 ID 格式从同一清单生成。

- `existing`：按对应记录索引递增，已有会话、轮次和记忆沿用此分配路径。
- `counter`：由 `runtime/ids.ts` 的 `allocateRecordId` 先持久保留编号，再发布记录。计数保存在会话的 `id-counters.json`，失败留空号，重试不复用。
- 工具调用进入 Runtime 时统一分配 callId；Provider 原始 ID 映射只保存于 provider 日志。当前请求是无状态 System/User 装配，不向 Provider 回传本地 callId 充当协议调用 ID。
- 每次查询由 Runtime 分配 queryId，查询结果复用模块原记录结构，sourceCallId 关联发起调用。

当前分配器用于单个服务进程，同一进程的分配操作同步完成。旧数据不迁移。UUID 临时文件名、附件标识、内部归档来源键和浏览器业务标识不属于模型记录 ID。

各 User 模块的 JSON 结构统一见 `../context/DATA.md` 和 `../context/data-schema.json`。
