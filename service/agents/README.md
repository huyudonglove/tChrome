# 工具类 Agent

`compression/` 和 `query/` 各自拥有独立目录：

- `index.ts`：业务入口与流程；压缩分别生成各轮或执行片段摘要，查询匹配会话历史目录并返回原文。
- `protocol.ts`：提示词加载与输入组装、专用返回工具装配、参数校验与业务校验。
- `prompts/`：本 Agent 的 System、User 提示词。
- `index.test.ts`：业务及协议行为验证。

两个 Agent 直接复用现有无状态 `provider.complete`，使用同一套模型配置、协议适配、传输重试和响应解析。Provider 不处理摘要结构、查询候选或其他 Agent 业务规则；这里不另建公共 LLM 请求封装。

`service/context-archive/` 负责不可变原文与摘要存储、目录索引、覆盖关系和来源展开。运行数据继续保存在 `conversations/<conversationId>/compression/<module>/`。Runtime 在发送主请求前触发压缩，`context.query` 工具触发查询；主 Agent 的窗口投影与提示词组装仍由 `service/context/` 管理。

每个 Agent 的 `tools/` 是本 Agent 专用工具 schema 的唯一来源：压缩通过 `submitTurnSummaries` 提交逐轮结构化摘要；查询通过 `submitMatches` 提交 ids（未找到时为空数组）。这些工具仅装配到对应 Agent 请求，不进入主 Agent 工具目录。每次必须恰好调用一次本 Agent 的返回工具，正文不作为业务结果；协议层读取工具文件并按同一 schema 校验参数，目录 ID 范围等语义约束另行校验。

查询请求明确区分两种数据：`request` 仅含主 Agent 的 module=conversationHistory、tag、question；`catalog` 由 runtime 从本地目录组装，提供候选 id 和语义描述。查询 Agent 根据前者匹配后者，通过 submitMatches 输出 ID。校验范围直接从同一 catalog 派生，不单独接受另一份 allowedIds，避免目录与校验列表不一致。主 Agent 的 context.query 不接受 ID。

## 按轮次压缩

`service/runtime/turn-history.ts` 提供 `assembleTurnHistory` 和 `loadSettledTurnHistory`，使用既有 turnId 汇集输入、目标变化、工具结果、页面观察及最终输出。记录包含 conversationId，轮次编号只在所属会话内解释；已结束历史按账本顺序读取，排除当前活动轮次和未结束记录。会话记忆写入按来源 turnId 关联到当轮，notes 保持当前状态，不增加轮次或版本历史。

每次发送主模型前，Runtime 检测 System + User 文本长度；达到 200,000 字符才触发压缩。按 turnId 汇集当轮输入、目标变化、工具调用与完整返回、页面观察、会话记忆写入和最终输出，保留最近 3 个已结束轮次及当前轮次。较早轮次可批量提交，但每轮分别生成 tag、userRequest、actions、result，追加到 conversationHistorySummary。若归档较早轮次后仍达到阈值，再归档当前轮次较早的执行片段，保留最近 2 个完整工具批次。当前输入、目标、当前页面、notes 和长期记忆保持可见。没有独立的 20K 摘要阈值，也不把多轮合成一条摘要。

模型输出校验成功、完整来源与摘要落盘后，才原子更新目录索引和覆盖关系。失败或取消不提交该批次覆盖，原文继续可用；此前成功提交的归档保留。索引是提交点，中断可能留下未被索引引用的文件。窗口按来源覆盖过滤历史输入、目标版本、页面观察、会话记忆写入和工具记录，本地原文不删除。
