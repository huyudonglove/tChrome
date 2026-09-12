# ID 清单

`catalog.json` 是记录 ID 的唯一规则入口：字段名、类型前缀、范围和分配方式均在此维护。System 集中说明通用编号规则和 turnId 关联；各 User 模块只解释自身 ID 的含义。编号示例、范围和 User 数据契约的 ID 格式从同一清单生成。

- `existing`：会话和资料库使用已有持久水位分配，删除记录不回退。
- `counter`：由 `runtime/ids.ts` 的 `allocateRecordId` 先持久保留编号，再发布记录。按 catalog 的范围保存在服务数据目录或会话目录的 `id-counters.json`，失败留空号，不复用已分配编号。
- `browser-counter`：浏览器自有元素/区域编号使用扩展持久水位，页面间不复用，DOM 节点与编号稳定关联。
- 工具调用进入 Runtime 时统一分配 callId；Provider 原始 ID 映射只保存于 provider 日志。当前请求是无状态 System/User 装配，不向 Provider 回传本地 callId 充当协议调用 ID。
- 每次查询由 Runtime 分配 queryId，查询结果复用模块原记录结构，sourceCallId 关联发起调用。

当前分配器用于单个服务进程，同一进程的分配操作同步完成。仅使用新的编号格式，不提供旧 ID 兼容或迁移。图片附件同样使用会话计数器分配 `img_01`，内容哈希只保存在图片内部索引。归档来源使用 src_01，逻辑来源键仅保存在内部映射。UUID 临时文件名、校验哈希和浏览器外部业务标识不属于模型记录 ID。

各 User 模块的 JSON 结构统一见 `../context/DATA.md` 和 `../context/data-schema.json`。
