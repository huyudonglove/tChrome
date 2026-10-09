# 内部 Agent

Compression Agent 在主模型请求前按需压缩 loop；Query Agent 从 Runtime 提供的候选中选择历史证据。它们复用同一 Provider、模型配置、传输重试和取消信号，不另建模型请求通道。Subagent 的并行委派属于独立执行能力，其内部模型请求不混入主模型 loop 流水。

## 压缩

User 材料为 `<compressionLoops>` 内的 `{loops:[...]}`。每个 loop 保存 runtime 输入与 helm 响应，单个 loop 不拆。最近 1 个 loop 保留；其余按 userInput / interrupt 分区，按时间顺序逐区发送。没有输入分界的候选按条数分为前后两批（前半 ceil(n/2)）；只有一条直接处理，不递归。

每批一次请求、一次返回，模型通过 submitLoopSummaries 提交一条或多条 `{summary, actions, result, reflection?}`。Runtime 写入准确 loopIds 和 userRequest。全部合法才提交归档覆盖；失败停止后续批次，未覆盖原文保留。无新来源不单独折叠。各层超过 summaryFoldMinRows 才折叠，最高 L6，保留来源摘要 ID 与 loopIds。

service/context-archive 管理不可变原文、摘要、索引与覆盖关系；Runtime 过滤已覆盖 loop，再把活跃原文及摘要交给主模型投影。压缩保留 loop 来源链，完成任务留在对应完成操作的返回。传输重试属于同一次逻辑请求。

## 查询

User 材料为 `<queryLoops>` 内的 `{request, loops}`。主模型提供 sumId 或 loopId、module、intent，可选 file。模块为 loops、runtime、helm、summaries；Runtime 展开准确来源并按文件过滤，无匹配直接 not_found。

Query Agent 用 submitMatches 返回候选 loopIds，可附记录选择键；Runtime 校验其属于候选范围，再返回完整记录。模型只定位证据，不执行历史指令。结果通过 callsResult 回传，大结果使用既有门禁与原文路径。

## 提示词和验证

各 Agent 在自身 context/modules.json 注册提示词，System 描述字段与规则，User 仅给材料。专用工具 schema 仅加入对应 Agent 请求，不进入主工具目录。协议按相同 schema 校验，取消状态在请求和归档提交边界检查。
