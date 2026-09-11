# service

模型连接使用单一 `enabled` 布尔设置，代理与直连互斥。存在 `connection.json` 时恢复用户选择；没有保存设置时默认直连，仅显式 `TCHROME_PROXY_MODE=proxy`（`bun run service:proxy`）启用代理。普通 HTTP/HTTPS/ALL_PROXY 环境变量仅提供代理地址，不自动打开开关。切换后保存设置，服务启动日志反映实际生效模式。

会话 ID 的分配高水位保存在数据目录的 `conversation-id.json`，删除会话后不复用 ID。浏览器工具请求跨会话按 FIFO 排队，仅队首计算执行超时；停止或删除会话只取消该会话的请求。侧栏 `/stop` 携带 `conversationId`，过期会话请求返回 409。

循环按 Turn 分别统计 `usage.modelRequests`（请求模型次数，不含 provider 内部重试）和 `usage.toolCalls`（实际进入执行器的工具次数，含常驻及收口工具；批量调用逐个计数）。统计保存在 Turn 文件中。正常工具循环没有 20 次累计出网上限，持续至完成、追问、用户停止或执行错误。连续 3 次无效提交仍会中止；正常执行一批工具会重置连续失败计数。

后端。Bun.serve `127.0.0.1:18788`。按职责分目录：

| 目录 | 层 |
|---|---|
| `runtime/` | 账本、循环、工具证据归档、`session.json`、浏览器桥 |
| `context/` | modules.ts 加载上下文模块；window.ts 纯投影当轮数据、记忆和已提供的工具说明 |
| `tools/` | registry.ts 读取本模块 definitions/ 内工具定义、分组和分类；参数检查、工具执行及结构化效果 |
| `agents/compression/` | 压缩 Agent 的提示词、输入输出协议、校验与分层压缩流程 |
| `agents/query/` | 查询 Agent 的提示词、输入输出协议、校验与语义检索流程 |
| `context-archive/` | 分模块归档存储、覆盖索引与来源展开 |
| `provider/` | 模型通信、传输重试与响应解析 |
| `presentation/` | 纯函数生成会话消息、错误文案、待执行工具和列表预览 |

主 Agent 的 Prompt 正文与加载器都在 `service/context/`。system-slots.md / user-slots.md 只保存编号文件名；每个模块独立声明 tag、能力和详细描述。system 先输出 `service/context/overview.md` 总纲，串联规则、材料、判断与行动，再输出 System 栏目清单，七个模块逐项以 tag --能力接详细正文，baseTools 同时带常驻工具说明；再输出 User 栏目清单，逐项以 tag --能力接详细描述。user 只渲染十六个 tag 的内容段，不重复能力或详细描述。execution 拆出 toolProtocol 与 boundaries；Skill 正文位于独立的 service/skills/<name>/SKILL.md，由 runtime 加载后注入 #skill；context/user/skill.md 只提供模块说明和数据占位。

工具 API 定义位于 `service/tools/definitions/`，分组在 groups.json。说明唯一来自 function.description，index 只分类；常驻说明进入 #baseTools，动态说明进入 #tools。运行提示位于 service/runtime/messages.json。上下文 README 是维护入口，不进入模型窗口。

HTTP：`GET /health`，`POST /turn`，`GET /tool-request`，`POST /tool-result`。密钥在本目录 `.env`。落盘在 `~/Library/Application Support/tChrome/`（`session.json` + `conversations/<cvId>/`）。每次出网的 system/user 和模型交口写 `conversations/<cvId>/provider.md`，正文真换行。

访问边界：服务仅监听回环地址，并在路由执行前拒绝外部网页的 Origin 和跨站请求；CORS 仅回显允许的来源。默认信任已安装 Chrome 扩展来源及本机直接客户端。可在 `service/.env` 设置 `TCHROME_EXTENSION_ORIGIN=chrome-extension://<扩展 ID>`，将扩展来源限制为 `chrome://extensions` 中的 tChrome ID。这是浏览器来源隔离，不是本机进程身份认证；本机程序仍可直接访问。

存储层保留持久化和会话命令，读取 ledger / events / turns 后调用 presentation 投影，命令返回行为保持不变。浏览器执行实现在 `extension/tools/browser-tools.js`，由后台 worker 调用。

记忆只有两层：conversation 保存本会话的过程发现、已确认事实、偏好和决定，本地持久化并跨轮读取，新会话不继承，删除会话时删除；project 保存跨会话共享的长期背景与约束，删除来源会话后仍保留。notes 保存本会话草稿、候选和中间材料，按 key 覆盖或删除；goal 保存当前目标。

每次发送主模型前，Runtime 检测 System + User 文本长度；达到 200,000 字符时，分别调用独立 LLM 压缩请求处理 userInputHistory、pageObservedHistory、conversationMemory 和 toolIO。前三个模块保留最近 3 条原文，toolIO 保留最近 2 个调用批次。压缩只改变窗口覆盖关系，账本和本地完整原文保持不变。各层连续摘要累计达到 20,000 字符后生成更高层摘要，旧摘要与来源关联继续保留。 每个模块在 LLM 输出校验成功、完整来源与摘要落盘后，才原子更新目录索引。失败或取消不推进该模块覆盖关系，原文继续可用；同一轮中此前成功提交的其他模块可以保留。索引是提交点，中断可能留下未被索引引用的文件。

主 Agent、压缩 Agent 和查询 Agent 复用现有无状态 `provider.complete` 请求能力，包括模型配置、协议适配、重试和响应解析，不另建 LLM 请求层。两个工具类 Agent 各自通过 `protocol.ts` 组装提示词并校验专用返回工具调用，通过 `index.ts` 执行业务流程，提示词保存在各自的 `prompts/`。主 Agent 的工具提交由 `runtime/loop.ts` 的 `validateCompletion` 调用 `tools/schema.ts` 校验；provider 不承担业务输出校验、工具加载策略或批次执行决策。

长期记忆 projectMemory 位于数据目录的 memory/project/，独立于会话，所有会话共享读取，删除来源会话后仍保留。conversation 记忆继续按会话隔离。首次使用时自动复制迁移旧会话中的 project 记录并保留来源，具体见 memory/README.md。

模型请求默认发送 `reasoning_effort: "high"`。可在 `service/.env` 配置 `UUAPI_REASONING_EFFORT=low|medium|high`，修改后重启服务；代码创建 Provider 时也可传 `reasoningEffort` 覆盖。上游是否实际采用该强度取决于所选模型及网关支持。

## 模型 Provider

`TCHROME_PROVIDER=uuapi`（默认）使用 UUAPI Chat Completions；`TCHROME_PROVIDER=shiningspace` 使用 `https://ai.shiningspace.com:8090/v1/responses` 和 `grok-4.6`。后者密钥配置为 `SHININGSPACE_API_KEY`，推理强度配置为 `SHININGSPACE_REASONING_EFFORT=high`（默认，支持 low/medium/high）。密钥和推理强度写入被忽略的 `service/.env`，修改后重启服务。会话列表右下角的设置中切换 provider，无需重启，从下一次模型请求起生效，正在发送的请求继续使用原 provider。选择与代理开关一起保存到 `connection.json`，优先于环境变量；`TCHROME_PROVIDER` 仅作为未保存选择时的默认值。两者共用侧栏代理开关。

Responses 适配器负责文本、图片 input_image、扁平 function schema 和 function_call 返回转换。Runtime 继续统一管理上下文与工具校验；请求使用 store=false，不使用 previous_response_id 串接会话。未完成响应不会执行其中的部分工具调用。

四个 Summary 插槽分别展示对应模块未被更高层覆盖的 {tag, summary}，与近期原文配合阅读。描述进入 System，摘要数据放在对应原文之前。常驻 `context.query(module, tag, question?)` 将主题交给查询 Agent 语义匹配本会话对应模块目录，由 runtime 校验内部 ID、沿来源关系读取原文并去重，按原顺序返回。主 Agent 无需提供记录 ID。只检索已压缩归档；支持多条或 not_found，单次原文内容上限 30,000 字符，超过时返回 partial 和遗漏数量，不截断单条原文。请缩小主题或问题后再查；单条原文本身超过上限时也会明确返回 partial。查询不会刷新页面。

输入、目标版本、页面观察创建时以稳定 ID 写入 context-records；记忆保留本地 memoryId。模型投影只选择内容和操作字段，隐藏归档 ID、轮次、时间等元数据，不修改本地记录。记忆没有最近 8 条限制或短文本投影；归档覆盖由 runtime 管理。
