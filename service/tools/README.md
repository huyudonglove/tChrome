# 服务工具

本目录是本机服务的工具能力模块，统一管理定义、注册、参数校验和服务端执行。工具 API 的 schema 与专用说明来源位于本模块 `definitions/`。

`affectsPage` 的通用含义统一写在 System 的 `#toolProtocol` 中；各工具定义只维护自身类型、必填、固定值和专用说明，不重复装配通用解释。

- `definitions/<工具名>.json`：工具名称、`function.description`、参数 schema。
- `definitions/index.json`：动态工具的 browser / service 分类。
- `definitions/groups.json`：常驻工具和初始动态工具分组。

`registry.ts` 读取本模块定义。System #baseTools 展示常驻能力导航，User #tools 展示本轮已加载的动态能力导航；每项由工具名和 function.description 首句生成，完整调用说明与参数 schema 通过 tools[] 发送。`schema.ts` 校验调用，Runtime 对主 Agent 响应统一执行校验后调度。校验前按 schema 中明确声明的字段类型，将精确的 `"true"` / `"false"` 转为布尔值，将 JSON 数字字符串转为有限数字（绝对值不超过安全整数上限，integer 字段必须为安全整数）；嵌套对象和数组沿 properties/items 处理。转换后的参数通过原有校验后交给执行器；不补必填项、不转换文本、不把单值包装成数组，也不猜测联合分支的类型。`service/context/` 负责同一服务内的上下文装配。Chrome API 操作由 `extension/tools/` 的宿主执行器完成，经浏览器桥接收服务调度；工具注册和 schema 仍统一维护在本模块。工具返回结构化结果与 effects，`service/runtime/effects.ts` 统一应用状态和持久化。

`web_search` 搜索公开网页链接；`tavily_search` 通过 Tavily 高级搜索返回网页及相关内容，单次 HTTP 请求入口为 `send_http`。旧搜索名称、`api_execute` 和未实现的接口登记入口已删除；未知工具调用明确失败。

`tavily_search` 属于动态服务工具，默认不加载，通过 `catalog.add` 启用。服务环境需配置 `TAVILY_API_KEY`（空配置示例见 `service/.env.example`）。搜索固定为 advanced，query 去除首尾空白，maxResults 默认 5、范围 1 至 10；每条 content 最多 4000 字符，截断标注 truncated。结果包含 query、searchDepth、results 和 urls；失败返回 faultCode、error。

新增工具时维护定义、分类和必要的分组，并在对应执行端实现。修改说明后运行 `bun run scripts/sync-context-examples.ts` 更新示例，再运行 `bun run check`。

## 本机工具

`local-files.ts` 提供绝对路径的文件读写、列表、搜索、复制、移动与删除；`local-process.ts` 提供命令执行、后台进程、标准输入、终止和系统打开。`local-tools.ts` 统一分派本机工具并建立会话作用域。工具定义仍只维护在 `definitions/local.*.json`，通过现有动态目录发现和 `catalog.add` 加载，不另建浏览器到本机的通信通道。

命令在服务电脑上由 zsh 执行，必须提供绝对 cwd。默认30秒、最长300秒超时，每个输出流持续读取并保留末尾65536字符，最多并行8个进程。后台进程ID只属于创建它的会话，服务重启后失效；停止会话、删除会话和服务正常退出会终止对应进程组。新建或切换会话不停止原会话任务；需要停止时先停止原会话。已结束进程记录最多保留64条。

本地能力使用服务进程的操作系统权限，不绕过macOS权限；文件修改即时生效，不随聊天记录删除而回滚。`affectsPage=false` 仅说明不影响浏览器页面，不表示本地操作没有副作用。文件复制/移动默认拒绝已存在目标，移动的默认实现是复制成功后删除源，操作期间应避免源被其他程序修改。

## 压缩归档查询

常驻 `context.query(sumId, module, intent, cursor?)` 从指定摘要的来源中查询一个模块。模块为 userInput、goalChanges、toolIO、pageObservations、memoryWrites、output、queryHistory 或 summaries。Runtime 装配候选原文，查询 Agent 通过 submitMatches 返回命中的 turnIds，Runtime 校验后将对应记录放入 currentQuery；工具返回只含状态和引用。每次 records 的紧凑 JSON 最多 2000 字符；超出返回 partial 与 nextCursor，可带原查询参数和 cursor 继续读取，无需再次调用查询 Agent。超大单条保留身份字段及 fragment:{offset,totalChars,text}，text 是原记录 JSON 的连续片段，不是摘要。查询不会刷新页面。

查询模块统一为 conversationHistory；每份归档保留轮次内部的输入、目标变化、工具、页面观察、记忆增量及最终输出。目录与原文由 `service/context-archive/` 管理，工具层只校验参数并调度 `service/agents/query/`。查询 Agent 自己管理提示词、输入输出协议与业务校验，模型请求复用现有 `provider.complete`。查询 Agent 仅选择候选，返回 ID 不能作为文件路径。查询结果不再经过普通工具的二次截断。
