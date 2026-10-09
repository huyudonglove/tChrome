# service

模型连接使用单一 `enabled` 布尔设置，代理与直连互斥。存在 `connection.json` 时恢复用户选择；没有保存设置时默认直连，仅显式 `TCHROME_PROXY_MODE=proxy`（`bun run service:proxy`）启用代理。普通 HTTP/HTTPS/ALL_PROXY 环境变量仅提供代理地址，不自动打开开关。切换后保存设置，服务启动日志反映实际生效模式。

会话 ID 的分配高水位保存在数据目录的 `conversation-id.json`，删除会话后不复用 ID。浏览器工具请求跨会话按 FIFO 排队，仅队首计算执行超时；停止或删除会话只取消该会话的请求。侧栏 `/stop` 携带 `conversationId`，过期会话请求返回 409。

循环按 Turn 分别统计 `usage.modelRequests`（请求模型次数，不含 provider 内部重试）和 `usage.toolCalls`（实际进入执行器的工具次数，含常驻及收口工具；批量调用逐个计数）。统计保存在 Turn 文件中。正常工具循环没有 20 次累计出网上限，持续至完成、追问、用户停止或执行错误。连续 3 次无效提交仍会中止；正常执行一批工具会重置连续失败计数。

后端。Bun.serve `127.0.0.1:18788`。按职责分目录：

| 目录 | 层 |
|---|---|
| `runtime/` | 账本、循环、工具证据归档、`session.json`、浏览器桥 |
| `context/` | modules.ts 加载上下文模块；window.ts 投影 loop 数据、记忆和已提供的工具说明 |
| `tools/` | registry.ts 读取本模块 definitions/ 内工具定义、分组和分类；参数检查、工具执行及结构化效果 |
| `agents/compression/` | Compression Agent 的 context 模块、输入输出协议、校验与 loop 分区压缩流程 |
| `agents/query/` | Query Agent 的 context 模块、输入输出协议、校验与语义检索流程 |
| `context-archive/` | 会话历史归档存储、覆盖索引与来源展开 |
| `provider/` | 模型通信、传输重试与响应解析 |
| `presentation/` | 纯函数生成会话消息、错误文案、待执行工具和列表预览 |

主 Agent 的 Prompt 正文与加载器都在 `service/context/`。唯一顺序源是 `modules.json`；每个模块是一份 XML 文件，含能力与详细描述。System 与 User 窗口都渲染完整 XML 模块；User 模块另含 `内容：` 段注入运行数据。Skill 正文位于独立的 `service/skills/<name>/SKILL.md`，由 runtime 加载后注入 `<skill>`；`context/user/skill.md` 只提供模块说明和数据占位。

工具 API 定义位于 `service/tools/definitions/`，分组在 groups.json。说明唯一来自 function.description，index 只分类；System `<baseTools>` 展示常驻能力导航，User `<tools>` 展示本会话已加载的动态能力导航；每项由工具名和 function.description 首句生成，完整调用说明与参数 schema 通过 tools[] 发送。过程展示仅使用工具 arguments.reason；最终回复、提问分别使用 finishTurn 的 text（侧栏）与 askUser.arguments.question，不回退到模型 content。模型后续上下文与压缩链路也使用 finishTurn.text。运行提示位于 shared/error-messages.json。上下文 README 是维护入口，不进入模型窗口。

HTTP：`GET /health`，`POST /turn`，`GET /tool-request`，`POST /tool-result`。密钥在本目录 `.env`。落盘在服务数据目录（绝对路径；默认用户主目录下 `Library/Application Support/tChrome`，`TCHROME_DATA` 可覆盖；模型经 System `<overview>` 使用该绝对路径）的 `session.json` + `conversations/<cvId>/`。

访问边界：服务仅监听回环地址，并在路由执行前拒绝外部网页的 Origin 和跨站请求；CORS 仅回显允许的来源。默认信任已安装 Chrome 扩展来源及本机直接客户端。可在 `service/.env` 设置 `TCHROME_EXTENSION_ORIGIN=chrome-extension://<扩展 ID>`，将扩展来源限制为 `chrome://extensions` 中的 tChrome ID。这是浏览器来源隔离，不是本机进程身份认证；本机程序仍可直接访问。

存储层保留持久化和会话命令，读取 ledger / events / turns 后调用 presentation 投影，命令返回行为保持不变。浏览器执行实现在 `extension/tools/browser-tools.js`，由后台 worker 调用。

记忆分 conversation 与 project 两层。会话记忆按来源 loop 随历史压缩，项目记忆跨会话并保持完整。主模型 User 依次为 skill、projectMemory、tools、conversation、contextUsage；所有模块 purpose 在 System。conversation 的 loop 记录 runtime 输入与 helm 响应，两者均有独立 ID；runtime type 为 userInput、interrupt、callsResult、notice。调用与结果按 callId 关联，判断与执行事实分开。

每次发送主模型前，Runtime 按 System + User 字符数判断压缩阈值。最近 1 个 loop 完整保留，其余按 userInput / interrupt 分区，顺序逐区请求；无输入分界时按条数分前后两半分别发送。loop 不拆、不递归。每批摘要全部合法才覆盖，失败停止后续批次并保留原文。摘要记录准确 loopIds，按层折叠至最高 L6；无新来源不单独折叠。

主 Agent 固定配套两个职责单一的子 Agent：Compression Agent 在主模型请求前按需压缩历史材料，Query Agent 在主 Agent 调用 `context_query` 时按意图定位历史证据。两者都复用现有无状态 `provider.complete` 请求能力，包括模型配置、协议适配、重试和响应解析，不另建 LLM 请求层。两个子 Agent 各自通过 `protocol.ts` 组装提示词并校验专用返回工具调用，通过 `index.ts` 执行业务流程，提示词保存在各自的 `context/`；主 Agent 只提交查询意图或消费压缩结果，不直接承担子 Agent 的候选筛选与摘要生成。主 Agent 的工具提交由 `runtime/loop.ts` 的 `validateCompletion` 调用 `tools/schema.ts` 校验；provider 不承担业务输出校验、工具加载策略或批次执行决策。

运行中的请求由 `runtime/execution.ts` 按数据目录、会话和回合统一管理，状态只允许 `active → cancelled` 或 `active → finished`，终态不能再次发出请求。Runtime 在回合入口给 Provider 绑定同一个 AbortSignal，主模型、压缩和查询自动共享；停止、删除会话或服务退出触发取消，Chat/Responses 网络请求及重试等待同时中止。新回合使用独立状态，切换或新建会话不取消其他会话。持久化 ledger 继续管理会话业务状态并检查迟到写入；执行状态机负责内存中的请求生命周期，回合退出统一释放。

长期记忆 projectMemory 位于数据目录的 memory/project/，独立于会话，所有会话共享读取，删除来源会话后仍保留。conversation 记忆继续按会话隔离。具体存储规则见 memory/README.md。

模型请求默认发送 `reasoning_effort: "high"`。可在 `service/.env` 配置 `UUAPI_REASONING_EFFORT=low|medium|high`，修改后重启服务；代码创建 Provider 时也可传 `reasoningEffort` 覆盖。上游是否实际采用该强度取决于所选模型及网关支持。

## 模型 Provider

`TCHROME_PROVIDER=uuapi`（默认）使用 UUAPI Chat Completions；`TCHROME_PROVIDER=shiningspace` 使用 `https://ai.shiningspace.com:8090/v1/responses` 和 `grok-4.7`；`TCHROME_PROVIDER=gemini` 使用 Google Gemini 原生 `generateContent`（`GEMINI_API_KEY`、默认模型 `gemini-3.8-flash`，可用 `GEMINI_MODEL` 覆盖）；`TCHROME_PROVIDER=deepseek` 使用 OpenAI 兼容 Chat Completions（`DEEPSEEK_API_KEY`，默认 `https://api.a6api.com/v1` 与 `deepseek-v4-flash`，可用 `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` 覆盖）；`TCHROME_PROVIDER=caicai` 使用 CaicAI New API 网关（`CAICAI_API_KEY`，默认 `https://www.caicaicome888.top/v1` 与 `DeepSeek-V4.1-Flash`）；`TCHROME_PROVIDER=a6api` 使用 A6API OpenAI 兼容网关（`A6API_API_KEY`，默认 `https://a6api.com/v1` 与 `gemini-3.8-flash`，可用 `A6API_BASE_URL` / `A6API_MODEL` 覆盖，工具名 sanitize）。Gemini 适配器把 system 写入 `systemInstruction`，user 写入 `contents`，在 `tools` 中附带内置 `google_search`（`GEMINI_GOOGLE_SEARCH=0` 可关闭）以及与 Chat 相同的 `functionDeclarations`；模型返回的 `functionCall` 分配 `gem_call_` 本地 ID 后进入既有 Runtime 校验。`groundingMetadata` 不并入正文，也不伪装成 tool_calls：Provider 以独立 `grounding` 字段返回，Runtime 分配 `call_` 写入 `toolIO`（name=`google_search`，return 含 queries/sources），不进入执行队列、不计入 `usage.toolCalls`。ShiningSpace 密钥配置为 `SHININGSPACE_API_KEY`，推理强度配置为 `SHININGSPACE_REASONING_EFFORT=medium`（默认，支持 low/medium/high）。密钥和推理强度写入被忽略的 `service/.env`，修改后重启服务。会话列表右下角的设置中切换 provider，无需重启，从下一次模型请求起生效，正在发送的请求继续使用原 provider。选择与代理开关一起保存到 `connection.json`，优先于环境变量；`TCHROME_PROVIDER` 仅作为未保存选择时的默认值。各 provider 共用侧栏代理开关。

Responses 适配器负责文本、图片 input_image、扁平 function schema 和 function_call 返回转换。Runtime 继续统一管理上下文与工具校验；请求使用 store=false，不使用 previous_response_id 串接会话。未完成响应不会执行其中的部分工具调用。

Chat 与 Responses 的失败分类和重试决策统一由 `provider/failures.ts` 管理。连接错误、超时、HTTP 408/429/5xx、Responses 的 server_error/rate_limit_exceeded，以及响应格式无效（provider_invalid_response，含空回包）按 `network.maxAttempts` 静默重试（默认 10 次含首次），重试成功则正常继续，不向模型回灌错误文案。输出超限、内容拒绝、未完整结束分别返回 `provider_output_limit`、`provider_refused`、`provider_incomplete`，不自动重试，也不执行部分工具调用。401 返回密钥错误，403 返回请求被拒绝并保留上游原因；重试耗尽后面板展示失败，本轮不执行工具。请求附带 tools 列表，tool_choice 默认 auto；仅在 needFinishTurn 重试或无效提交自救等「必须再调工具」的路径试发 required，网关或 thinking 模式拒绝（报文含 tool_choice / functionCallingConfig）则当场降级 auto 重试，不按模型是否 thinking 写死支持与否。Gemini 对应 `functionCallingConfig.mode`：required→ANY，默认 AUTO。

summaries 展示历史 loop 的 summary、userRequest、actions、result 与准确 loopIds。context_query / agent_query 按 sumId 或 loopId 查询 loops、runtime、helm、summaries，支持 file 过滤；无匹配直接 not_found。Query Agent 返回候选 loopIds，Runtime 校验后读取完整来源记录。查询结果留在 callsResult，遵守统一返回门禁；原文凭 callId / pageId 使用 evidence_search 的 blockId 或 keyword 获取，返回 nextOffset 时继续分页。

未完成任务在 conversation 底部 tasks 展示完整最新状态；创建和更新返回 task ID 指针，完成或取消后从 tasks 移出，最终任务保留在完成操作返回。工具 keepInCalls 在执行时解析并持久化，true 保留到压缩，false 仅在结果返回后的下一次请求展示一次。大结果保留既有索引和原文路径，不另建证据正文副本。历史 loop 正常追加不回写，容量读数放在整条 User 最末尾；压缩时接受缓存前缀重建。

Compression Agent 的每次模型请求独立写入 `conversations/<cvId>/agent-logs/compression/<时间戳>-<唯一标识>.jsonl`。请求发送前记录完整 messages 与 tools；收到后记录 Provider 返回的完整 CompletionResult（正文、工具调用、解析错误等），并记录成功摘要或异常。schema 校验失败包含字段路径、规则和预期类型，来源覆盖关联准确 loopIds；会话的 compress-error 附日志路径。日志不包含模型密钥或请求认证头，也不进入主模型上下文。

网络配置统一在 `service/config/runtime.json`，修改后重启服务生效。`network.idleTimeoutMs=90000` 表示等待响应头或响应体连续 90 秒没有数据才超时，非请求总耗时；收到非空数据块重置计时。`network.maxAttempts=10` 包含首次请求，`retryDelayMs=200` 为尝试间隔。测试经 `bunfig.toml` 预载把 `TCHROME_RETRY_DELAY_MS` 置为 1，重试循环不按生产间隔硬等；`TCHROME_MAX_ATTEMPTS` 可覆盖尝试次数。通用 HTTP 工具和主/辅助模型请求共用该策略，用户停止立即取消传输及等待；模型继续采用统一失败分类决定哪些错误可重试，HTTP 工具对空闲超时和连接中断重试，收到 HTTP 错误状态则直接返回。持续响应会继续消费，普通 HTTP 工具完整保留正文与响应头，搜索完整保留返回内容，再由发送前上下文门禁处理；probe_http 保持只检查响应头。Tavily SDK 的 `sdk.tavilyTimeoutSeconds` 和 TLS 握手的 `tls.timeoutMs` 属于专用超时，独立配置在同一文件，不冒充流式空闲计时。

### 模型请求网络计时

会话 `events.jsonl` 中，`provider-timing` 记录逻辑请求开始、结果及结束耗时；`provider-network` 记录该请求每次实际 HTTP 尝试的阶段。二者用持久递增的 `requestId` 和 `turnId` 关联，覆盖主模型、压缩、查询及子代理，并发请求独立计时。每次实际发送的 `attempt` 独立编号，保留重试前的失败数据。

网络阶段包含发送开始、响应头、首个非空响应体数据、完成/失败/取消；耗时使用单调时钟。记录可测请求体的 UTF-8 字节数、已接收响应体字节数及 HTTP 状态，不记录请求正文、认证头或 URL。响应头和首块等待包含网络及服务端处理，不能解释为纯上传或模型思考耗时。普通 fetch 无法测出 DNS、建连、TLS 和上传完成时刻，上传字段明确为 null；流式请求体无法无损预先计量时大小为 null。首块也不等于首个内容 token。日志只用于诊断，不进入模型上下文，不改变请求、超时和重试规则。

### 最近 100 次模型出网内容

服务数据目录 `provider-requests/out_NN.json` 保存最近 100 次实际模型 HTTP 发送的请求快照，所有会话共用此保留数量；一次重试也算一次发送。每条包含 `conversationId`、`turnId`、`requestId`、`attempt`、时间、HTTP 方法、不带查询参数与认证信息的 endpoint，以及最终序列化请求体 `body`。body 保留原样，包含实际发送的 System/User、工具 schema、模型参数及图片数据（如有），不截断、不进入模型上下文。请求头不保存。

`events.jsonl` 的 `provider-outbound` 记录快照路径，可与 `provider-network` 的请求编号和尝试序号关联。超过 100 条时按持久递增编号删除最旧快照，重启后继续累计。文件权限为仅本用户读写。日志失败或无法无损记录的非文本请求体通过 `request-log-error` 标记，原请求继续执行；当前模型适配器使用序列化 JSON 文本。历史请求无法补录，服务重启启用后开始收集。
