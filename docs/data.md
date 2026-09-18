# 数据存储与执行循环

运行时数据保存在 `~/Library/Application Support/tChrome/`。`session.json` 指向当前会话；会话账本、轮次、会话记忆和归档按会话保存，项目长期记忆独立保存。完整目录与字段统一见 [schema](schema.md)。

用户输入创建新 Turn。本轮内模型可以多次调用工具；Runtime 持久化工具结果、目标变更、页面观察和记忆写入，再组装下一次请求。增量记录通过 `turnId` 关联到所属轮次，Ledger.goals 保存所有目标的最新状态，currentGoalId 指向当前任务；总目标 goal_ 与子目标 subgoal_ 分别自增，通过 parentId 关联。Turn.goalChanges 保存每次变更快照；#goalHistory 展示已完成、已取消目标，更新目标不另建版本。当前页面和 notes 保存当前工作状态。

每次发送主模型前，Runtime 统计 System + User 文本字符数，达到 200000 时启动模型压缩。历史记录按 Turn 分组并批量压缩，所有已结束轮次均可归档。当前轮次仍过长时，归档较早的完整工具批次并保留最近 2 个批次；已有摘要仅随同轮新材料合并，无新材料时不请求压缩。

摘要通过专用工具返回并校验，原文和摘要写入本地归档后才更新覆盖索引。窗口使用 `#conversationHistorySummary` 展示摘要，原始记录保留；压缩失败或取消不推进覆盖状态。压缩处理之后，发送前还会执行下面的硬内联预算检查。

主模型 System + User 的硬内联上限为 250000 字符，与 200000 字符的历史压缩触发门槛分开。Runtime 先按既有门槛检查压缩，再检查发送预算；压缩后仍超过 250000 时，优先将 notes 正文写入 `TCHROME_DATA/context-files/`，以 `{contextFile:{path,chars,format}}` 替换相应模块正文，直到满足预算。notes 外置后仍超限时，再外置其他大块内容。数组模块也允许单独外置大记录，保留后续较小记录内联，便于看到分页读取结果。path 为绝对路径，chars 为原文字符数，format 为 `json` 或 `text`。System #baseTools、User #tools、#skill 和编号规则保持内联；#skill 始终保留全文，不参与压缩或裁剪。notes、长期记忆等不参与历史压缩的材料同样可以通过文件引用展示，保存内容和历史原文不会被删除或截断。

模型需要原文时，先通过 `catalog.add` 加载 `local.fs_read`，按 `offset` / `limit` 按字节分段读取，后续页使用返回的 `nextOffset`，不一次回读全文。固定规则和引用本身仍无法装入预算时返回 `context_limit`。

常驻 `context.query(sumId, module, intent)` 从指定摘要的来源中查询一个模块。模块为 userInput、goalChanges、toolIO、pageObservations、memoryWrites、output、queryHistory 或 summaries。Runtime 装配候选原文，Query Agent 通过 submitMatches 返回命中的 turnIds，Runtime 校验后将完整 records 放入 currentQuery；#toolIO 只投影 currentQuery 指针。查询结果与其它工具返回共用统一内联门禁（默认 4000 字符），超出时注入 externalized 摘要（preview+path+totalLines/lineWidth）；本地全文按默认 100 字/行拆行，可用 evidence.search 按 keyword 或只传 startLine（约 400 字窗口）检索。查询不会刷新页面。

当前流程示例见 [上下文装配](examples/02-context-engineering.md)、[模型请求](examples/04-provider-request.md)、[压缩与查询](examples/07-compress.md)和[结束轮次](examples/08-finish-turn.md)。
