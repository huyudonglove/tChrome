# 统一证据块索引

工具返回、文件大纲、观察结果与文本资产使用 `index.ts` 的同一棵块树。完整原文保持原样，节点以 sourceId 和起止字符偏移引用快照。`local_fs_read` 的 JSON 返回还保留解码后的文件内容 source，提供真实文件路径、行号与 JSON 路径，取回代码时保留换行和完整表达式。

JS/TS 系列源码通过已有 TypeScript 解析器识别声明和内部语句边界；JSON 按字段、数组项划分；其他文本按段落、行、句子递归划分。相邻小段合并到预算内，过大结构继续细分，最终按 Unicode 字符边界切分。预算来自现有 inlineChars 减 pointerShellReserve，并计算 JSON 转义与目录/内容返回的包装。每个 source 的叶子范围连续覆盖完整原文。

块地址 `blk_01` 在单棵快照树内顺序分配并随索引持久化。访问时必须同时指定来源 callId/pageId，或通过 asset_read 指定 assetId。目录和搜索命中带 parentBlockId，可回父目录读取相邻块。

- `evidence_search(windows=[{callId}])`：读取根块。
- `evidence_search(windows=[{callId, blockId}])`：目录返回 `kind=directory` 和子块；叶子返回 `kind=content` 和完整原文。
- `evidence_search(windows=[{callId, keyword}])`：返回 `kind=search`、命中片段和块 ID；跨块命中映射到相交叶子。出现 nextOffset 时，以相同关键词和 offset 继续。

pageId 使用同样的接口。asset_read 的文本参数同样为 blockId 或 keyword/offset。搜索片段只用于定位；完整原文通过块 ID 读取，取回结果直接内联。文件修改不会改变已经保存的快照；显式刷新观察会更新该观察的原文与索引。

运行时在返回块地址前保存索引；文件大纲通过 ToolExecution.evidenceIndex 交给运行时落盘，模型窗口只接收根块。查询结果通过 sourceCallId 指向已保存的工具返回索引。压缩仍使用自身的轮次摘要流程。
