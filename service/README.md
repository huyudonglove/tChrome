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
| `agents/compression/` | Compression Agent 的提示词、输入输出协议、校验与逐轮压缩流程 |
| `agents/query/` | Query Agent 的提示词、输入输出协议、校验与语义检索流程 |
| `context-archive/` | 会话历史归档存储、覆盖索引与来源展开 |
| `provider/` | 模型通信、传输重试与响应解析 |
| `presentation/` | 纯函数生成会话消息、错误文案、待执行工具和列表预览 |

主 Agent 的 Prompt 正文与加载器都在 `service/context/`。system-slots.md / user-slots.md 只保存编号文件名；每个模块独立声明 tag、能力和详细描述。system 先输出 `service/context/overview.md` 总纲，串联规则、材料、判断与行动，再输出 System Modules，九个模块逐项以 tag --能力接详细正文；再输出 User Modules，逐项以 tag --能力接详细描述。user 只渲染十五个 tag 的内容段，不重复能力或详细描述。Skill 正文位于独立的 service/skills/<name>/SKILL.md，由 runtime 加载后注入 #skill；context/user/skill.md 只提供模块说明和数据占位。

工具 API 定义位于 `service/tools/definitions/`，分组在 groups.json。说明唯一来自 function.description，index 只分类；System #baseTools 展示常驻能力导航，User #tools 展示本会话已加载的动态能力导航；每项由工具名和 function.description 首句生成，完整调用说明与参数 schema 通过 tools[] 发送。过程展示仅使用工具 arguments.reason；最终回复、提问分别使用 finishTurn.arguments.text 和 askUser.arguments.question，不回退到模型 content。运行提示位于 shared/error-messages.json。上下文 README 是维护入口，不进入模型窗口。

HTTP：`GET /health`，`POST /turn`，`GET /tool-request`，`POST /tool-result`。密钥在本目录 `.env`。落盘在 `~/Library/Application Support/tChrome/`（`session.json` + `conversations/<cvId>/`）。每次出网的 system/user 和模型交口写 `conversations/<cvId>/provider.md`，正文真换行。

访问边界：服务仅监听回环地址，并在路由执行前拒绝外部网页的 Origin 和跨站请求；CORS 仅回显允许的来源。默认信任已安装 Chrome 扩展来源及本机直接客户端。可在 `service/.env` 设置 `TCHROME_EXTENSION_ORIGIN=chrome-extension://<扩展 ID>`，将扩展来源限制为 `chrome://extensions` 中的 tChrome ID。这是浏览器来源隔离，不是本机进程身份认证；本机程序仍可直接访问。

存储层保留持久化和会话命令，读取 ledger / events / turns 后调用 presentation 投影，命令返回行为保持不变。浏览器执行实现在 `extension/tools/browser-tools.js`，由后台 worker 调用。

记忆只有两层：conversation 保存本会话的过程发现、已确认事实、偏好和决定，本地持久化并跨轮读取，新会话不继承，删除会话时删除；project 保存跨会话共享的长期背景与约束，删除来源会话后仍保留。notes 保存本会话草稿、候选和中间材料，按 key 覆盖或删除；goals 保存总目标与子目标的最新记录，currentGoalId 指向当前任务，父子关系通过 parentId 关联；模型显式维护完成和取消状态。

每次发送主模型前，Runtime 检测 System + User 文本长度；达到 200,000 字符才触发压缩。按 turnId 汇集当轮输入、目标变化、工具调用与完整返回、页面观察、会话记忆写入、查询历史和最终输出，所有已结束轮次均可归档，当前轮次按完整工具批次处理。较早轮次可批量提交，但每轮分别生成 tag、userRequest、actions、result，追加到 conversationHistorySummary。若归档较早轮次后仍达到阈值，再归档当前轮次较早的执行片段，保留最近 2 个完整工具批次。当前输入、目标、当前页面、notes、长期记忆和 currentQuery 保持可见；currentQuery 计入总窗口但不参与压缩，queryHistory 作为取证参考，结论合入 result。摘要保持每轮独立。

主 Agent、Compression Agent 和Query Agent 复用现有无状态 `provider.complete` 请求能力，包括模型配置、协议适配、重试和响应解析，不另建 LLM 请求层。两个工具类 Agent 各自通过 `protocol.ts` 组装提示词并校验专用返回工具调用，通过 `index.ts` 执行业务流程，提示词保存在各自的 `prompts/`。主 Agent 的工具提交由 `runtime/loop.ts` 的 `validateCompletion` 调用 `tools/schema.ts` 校验；provider 不承担业务输出校验、工具加载策略或批次执行决策。

运行中的请求由 `runtime/execution.ts` 按数据目录、会话和回合统一管理，状态只允许 `active → cancelled` 或 `active → finished`，终态不能再次发出请求。Runtime 在回合入口给 Provider 绑定同一个 AbortSignal，主模型、压缩和查询自动共享；停止、删除会话或服务退出触发取消，Chat/Responses 网络请求及重试等待同时中止。新回合使用独立状态，切换或新建会话不取消其他会话。持久化 ledger 继续管理会话业务状态并检查迟到写入；执行状态机负责内存中的请求生命周期，回合退出统一释放。

长期记忆 projectMemory 位于数据目录的 memory/project/，独立于会话，所有会话共享读取，删除来源会话后仍保留。conversation 记忆继续按会话隔离。具体存储规则见 memory/README.md。

模型请求默认发送 `reasoning_effort: "high"`。可在 `service/.env` 配置 `UUAPI_REASONING_EFFORT=low|medium|high`，修改后重启服务；代码创建 Provider 时也可传 `reasoningEffort` 覆盖。上游是否实际采用该强度取决于所选模型及网关支持。

## 模型 Provider

`TCHROME_PROVIDER=uuapi`（默认）使用 UUAPI Chat Completions；`TCHROME_PROVIDER=shiningspace` 使用 `https://ai.shiningspace.com:8090/v1/responses` 和 `grok-4.6`；`TCHROME_PROVIDER=gemini` 使用 Google Gemini 原生 `generateContent`（`GEMINI_API_KEY`、默认模型 `gemini-3.8-flash`，可用 `GEMINI_MODEL` 覆盖）；`TCHROME_PROVIDER=deepseek` 使用 OpenAI 兼容 Chat Completions（`DEEPSEEK_API_KEY`，默认 `https://api.a6api.com/v1` 与 `deepseek-v4-flash`，可用 `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` 覆盖）；`TCHROME_PROVIDER=caicai` 使用 CaicAI New API 网关（`CAICAI_API_KEY`，默认 `https://www.caicaicome888.top/v1` 与 `DeepSeek-V4.1-Flash`）。Gemini 适配器把 system 写入 `systemInstruction`，user 写入 `contents`，在 `tools` 中附带内置 `google_search`（`GEMINI_GOOGLE_SEARCH=0` 可关闭）以及与 Chat 相同的 `functionDeclarations`；模型返回的 `functionCall` 分配 `gem_call_` 本地 ID 后进入既有 Runtime 校验。`groundingMetadata` 不并入正文，也不伪装成 tool_calls：Provider 以独立 `grounding` 字段返回，Runtime 分配 `call_` 写入 `toolIO`（name=`google_search`，return 含 queries/sources），不进入执行队列、不计入 `usage.toolCalls`。ShiningSpace 密钥配置为 `SHININGSPACE_API_KEY`，推理强度配置为 `SHININGSPACE_REASONING_EFFORT=medium`（默认，支持 low/medium/high）。密钥和推理强度写入被忽略的 `service/.env`，修改后重启服务。会话列表右下角的设置中切换 provider，无需重启，从下一次模型请求起生效，正在发送的请求继续使用原 provider。选择与代理开关一起保存到 `connection.json`，优先于环境变量；`TCHROME_PROVIDER` 仅作为未保存选择时的默认值。各 provider 共用侧栏代理开关。

Responses 适配器负责文本、图片 input_image、扁平 function schema 和 function_call 返回转换。Runtime 继续统一管理上下文与工具校验；请求使用 store=false，不使用 previous_response_id 串接会话。未完成响应不会执行其中的部分工具调用。

Chat 与 Responses 的失败分类和重试决策统一由 `provider/failures.ts` 管理。输出超限、内容拒绝、未完整结束及响应格式无效分别返回 `provider_output_limit`、`provider_refused`、`provider_incomplete`、`provider_invalid_response`，直接终止，不自动重试，也不执行部分工具调用。只对连接错误、超时、HTTP 408/429/5xx，以及 Responses 明确的 server_error/rate_limit_exceeded 重试，最多 3 次；401 返回密钥错误，403 返回请求被拒绝并保留上游原因，不直接认定密钥失效，其他 HTTP 错误和本地异常不重试。取消始终优先，返回 stopped。

conversationHistorySummary 展示历史轮次或执行片段的 {tag, userRequest, actions, result}，与近期原文配合阅读。描述进入 System，摘要数据放在当前输入之后。常驻 `context.query(sumId, module, intent)` 从指定摘要的来源中查询一个模块。模块为 userInput、goalChanges、toolIO、pageObservations、memoryWrites、output、queryHistory 或 summaries。Runtime 装配候选原文，Query Agent 通过 submitMatches 返回命中的 turnIds，Runtime 校验后将完整 records 放入 currentQuery；#toolIO 只投影 currentQuery 指针。查询结果与其它工具返回共用统一内联门禁（默认 4000 字符），超出时注入 externalized 摘要（preview+path+totalLines/lineWidth）；本地全文按默认 100 字/行拆行，可用 evidence.search 按 keyword 或只传 startLine（约 400 字窗口）检索。查询不会刷新页面。

输入和页面观察以稳定 ID 写入 context-records；目标最新状态按原 ID 更新至 Ledger.goals，历史变更快照保存在 Turn.goalChanges；记忆保留本地 memoryId。模型投影保留记录 ID、轮次与来源关联以及内容和操作字段，不修改本地记录。记忆投影保留完整文本；归档覆盖由 runtime 管理。openTabs 在每次请求主模型前刷新全部普通窗口及其标签、激活和焦点状态，读取失败显式报告；pageObservedHistory 是页面观察统一数组（id、tabId、type、result，旧→新）；toolIO 中产生观察的调用只投影 pageObservationId 引用，完整观察结果只出现在 #pageObservedHistory。

Compression Agent 的每次模型请求独立写入 `conversations/<cvId>/agent-logs/compression/<时间戳>-<唯一标识>.jsonl`。请求发送前记录完整 messages 与 tools；收到后记录 Provider 返回的完整 CompletionResult（正文、工具调用、解析错误等），并记录成功摘要或异常。schema 校验失败包含字段路径、规则和预期类型，轮次覆盖错误包含预期与实际 turnId；会话的 compress-error 附日志路径。日志不包含模型密钥或请求认证头，也不进入主模型上下文。

网络配置统一在 `service/config/runtime.json`，修改后重启服务生效。`network.idleTimeoutMs=90000` 表示等待响应头或响应体连续 90 秒没有数据才超时，非请求总耗时；收到非空数据块重置计时。`network.maxAttempts=3` 包含首次请求，`retryDelayMs=1000` 为尝试间隔。通用 HTTP 工具和主/辅助模型请求共用该策略，用户停止立即取消传输及等待；模型继续采用统一失败分类决定哪些错误可重试，HTTP 工具对空闲超时和连接中断重试，收到 HTTP 错误状态则直接返回。持续响应会继续消费，普通 HTTP 工具完整保留正文与响应头，搜索完整保留返回内容，再由发送前上下文门禁处理；probe_http 保持只检查响应头。Tavily SDK 的 `sdk.tavilyTimeoutSeconds` 和 TLS 握手的 `tls.timeoutMs` 属于专用超时，独立配置在同一文件，不冒充流式空闲计时。
