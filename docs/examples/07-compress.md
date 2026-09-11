# 07 模型压缩与委托查询

当前实现以 `service/compression/` 和 `service/runtime/context-state.ts` 为准。

发送前先按模块投影并统计 System + User 的字符数。达到 200000 字符时，runtime 从未覆盖记录中选择较早内容，分别发起无工具权限的 LLM 请求。用户历史、页面历史、会话记忆各保留最近 3 条，工具记录保留最近 2 个完整模型工具批次；当前输入、目标和当前页面不参与压缩。

每个模块写入 `conversations/<conversationId>/compression/<module>/`：

- `sources/<id>.json`：完整原始记录。
- `records/<id>.json`：tag、摘要、层级、来源 ID 和生成时间。
- `index.json`：全部摘要目录、当前未被覆盖的摘要 ID、已覆盖原始 ID。

原文和摘要先不可变落盘，索引原子提交。窗口仅过滤已覆盖原文，账本和记忆索引保持完整。失败模块不推进覆盖状态，已成功的其他模块归档仍有效；停止后不提交新的归档结果。没有重新分配原记录 ID。

每次生成一级摘要并追加；连续同层摘要积累达到 20000 字符时，再生成更高层摘要。旧摘要和来源仍可查，窗口只显示未被覆盖的摘要，且仅暴露 tag 和 summary。

主 Agent 使用常驻 `context.query`，传入 module、tag 和可选 question。查询 Agent 按语义选择该模块目录中的候选 ID；runtime 校验 ID 并沿来源关系返回原文，去重并保持原始顺序。主 Agent 不直接操作归档 ID。

查询目录分批读取，当前单次结果最多 30000 字符，以完整记录为单位返回；超出明确返回 partial 和遗漏数量，不能当作全部。单条原文本身超过上限时也会返回 partial。压缩后窗口仍达到 200000 字符则返回 context_limit，不发送超限主请求，也不裁剪近期原文。

验证见 `service/runtime/context-state.test.ts`（发送前触发、保留窗口与失败）、`service/detail.test.ts`（查询结果进入下一次主请求）、`service/compression/` 中的分层、取消和归档测试。测试使用模拟 LLM，不代表某个真实模型的摘要质量已通过验证。
