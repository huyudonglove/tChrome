# 工具类 Agent

`compression/` 和 `query/` 各自拥有独立目录：

- `index.ts`：业务入口与流程；压缩分别生成各轮或执行片段摘要，查询按意图选择候选轮次，由 Runtime 返回原文。
- `protocol.ts`：提示词加载与输入组装、专用返回工具装配、参数校验与业务校验。
- `context/`：本 Agent 的 System XML 模块；User 为一层标签内的 JSON。
- `index.test.ts`：业务及协议行为验证。

两个 Agent 直接复用现有无状态 `provider.complete`，使用同一套模型配置、协议适配、传输重试和响应解析。Provider 不处理摘要结构、查询候选或其他 Agent 业务规则；这里不另建公共 LLM 请求封装。 Runtime 传入绑定当前回合执行状态的 Provider，两个 Agent 自动复用主模型的取消信号；停止会同时中止网络请求和重试等待。索引提交前仍检查回合有效性，已取消压缩的锁可由新回合接管，旧任务退出不能清除新任务的锁。

`service/context-archive/` 负责不可变原文与摘要存储、目录索引、覆盖关系和来源展开。运行数据继续保存在 `conversations/<conversationId>/compression/<module>/`。Runtime 在发送主请求前触发压缩，`context.query` 工具触发查询；主 Agent 的窗口投影与提示词组装仍由 `service/context/` 管理。

每个 Agent 的 `tools/` 是本 Agent 专用工具 schema 的唯一来源：压缩通过 `submitTurnSummaries` 按历史顺序**逐轮**提交 `{tag, actions, result}`（userRequest 由 Runtime 写入）；成功立刻落盘，失败停止后续轮次并保留原文。查询通过 `submitMatches` 提交 turnIds（未找到时为空数组）。这些工具仅装配到对应 Agent 请求，不进入主 Agent 工具目录。每一次回包只调本 Agent 的返回工具一次，结果放进该工具参数，正文不作为业务结果；协议层读取工具文件并按同一 schema 校验参数，目录 ID 范围等语义约束另行校验。

主 Agent 提交 sumId、module、intent。Runtime 沿摘要来源关系展开指定模块，给查询 Agent 提供带 turnId 的候选原文；Agent 通过 submitMatches 选择轮次。Runtime 校验返回值属于候选集合，再读取原模块记录并保留身份字段。

## 按轮次压缩

压缩 Agent **不复用**主 Agent 的 context 模块集，按同样方式**分层**：

```text
service/agents/compression/context/
  modules.json          # System 模块清单（全 XML）
  system/overview.md    # <overview> 运行机制 + 模块粗览
  system/identity.md    # <identity> 身份只在此模块
  system/role.md
  system/modules.md
  system/turns.md
  system/output.md
```

User 仅为 `<compressionTurns>\n{"turns":[...]}\n</compressionTurns>`（标签内无说明）。归档字段由主注册表 `service/context/modules.json`（compress=true）注入 System。可读对照表见 [context/README.md](../context/README.md)。新增模块：改注册表 + projector，再视需要更新压缩 `context/system/` 措辞。

`service/runtime/turn-history.ts` 提供 `assembleTurnHistory` 和 `loadSettledTurnHistory`，使用既有 turnId 汇集输入、目标变化、工具结果、页面观察及最终输出。记录包含 conversationId，轮次编号只在所属会话内解释；已结束历史按账本顺序读取，排除当前活动轮次和未结束记录。会话记忆写入按来源 turnId 关联到当轮，notes 保持当前状态，不增加轮次或版本历史。

每次发送主模型前，Runtime 检测 System + User 文本长度；达到 200,000 字符才触发压缩。按 turnId 汇集当轮输入、目标变化、工具调用与完整返回、页面观察、会话记忆写入、查询历史和最终输出，所有已结束轮次均可归档，当前轮次按完整工具批次处理。较早轮次可批量提交，但每轮分别生成 tag、userRequest、actions、result，追加到 conversationHistorySummary。若归档较早轮次后仍达到阈值，再归档当前轮次较早的执行片段，保留最近 2 个完整工具批次。当前输入、目标、当前页面、notes、长期记忆和 currentQuery 保持可见；currentQuery 计入总窗口但不参与压缩，queryHistory 作为取证参考，结论合入 result。摘要保持每轮独立。

模型输出校验成功、完整来源与摘要落盘后，才原子更新目录索引和覆盖关系。失败或取消不提交该批次覆盖，原文继续可用；此前成功提交的归档保留。索引是提交点，中断可能留下未被索引引用的文件。窗口按来源覆盖过滤历史输入、已结束目标、页面观察、会话记忆写入和工具记录，本地原文不删除。

查询历史以独立查询来源归档，与原工具批次的覆盖状态分开跟踪；即使查询稍后才移入历史，也能补入所属 Turn。currentQuery 不进入压缩输入，toolIO 不重复存放查询原文。

压缩入口将本次选中的原文与需要合并的既有摘要按 turnId 组织，一次调用 provider.complete，统一校验返回后提交归档。不设置内部 60K 请求门槛，不进行字段分片、串行分批或递归摘要合并。Runtime 仍按 history/current 阶段按需选择材料，各阶段各一次；传输层重试属于同一次逻辑请求。

没有未覆盖的新来源时直接跳过，不调用压缩模型。新来源只与同一 turn 的既有摘要合并，其他 turn 的摘要保持不变。

## 按意图查询

查询 Agent 同样不复用主 Agent 的 context 模块集，按同一套分层：

```text
service/agents/query/context/
  modules.json          # System 模块清单（全 XML）
  system/overview.md    # <overview> 运行机制 + 模块粗览
  system/identity.md    # <identity> 身份只在此模块
  system/role.md
  system/modules.md
  system/turns.md
  system/output.md
```

User 仅为 `<queryTurns>\n{"request":{...},"turns":[...]}\n</queryTurns>`（标签内无说明）。字段语义在 System `<queryModules>`。

主 Agent 提交 sumId、module、intent。Runtime 沿摘要来源关系展开指定模块，一次把候选交给查询 Agent。查询用一次 submitMatches 返回 turnIds；无匹配时为空数组。Runtime 校验返回值属于候选集合，再把命中轮次的完整 records 放入 `<currentQuery>`。
