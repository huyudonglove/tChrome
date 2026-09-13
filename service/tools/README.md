# 服务工具

本目录是本机服务的工具能力模块，统一管理定义、注册、参数校验和服务端执行。工具 API 的 schema 与专用说明来源位于本模块 `definitions/`。

`affectsPage` 的通用含义统一写在 System 的 `#toolProtocol` 中；各工具定义只维护自身类型、必填、固定值和专用说明，不重复装配通用解释。

- `definitions/<工具名>.json`：工具名称、`function.description`、参数 schema。
- `definitions/index.json`：动态工具的 browser / service 分类。
- `definitions/groups.json`：常驻工具和初始动态工具分组。

`registry.ts` 读取本模块定义。System #baseTools 展示常驻能力导航，User #tools 展示本会话已加载的动态能力导航；每项由工具名和 function.description 首句生成，完整调用说明与参数 schema 通过 tools[] 发送。`schema.ts` 校验调用，Runtime 对主 Agent 响应统一执行校验后调度。校验前按 schema 中明确声明的字段类型，将精确的 `"true"` / `"false"` 转为布尔值，将 JSON 数字字符串转为有限数字（绝对值不超过安全整数上限，integer 字段必须为安全整数）；嵌套对象和数组沿 properties/items 处理。转换后的参数通过原有校验后交给执行器；不补必填项、不转换文本、不把单值包装成数组，也不猜测联合分支的类型。`service/context/` 负责同一服务内的上下文装配。Chrome API 操作由 `extension/tools/` 的宿主执行器完成，经浏览器桥接收服务调度；工具注册和 schema 仍统一维护在本模块。工具返回结构化结果与 effects，`service/runtime/effects.ts` 统一应用状态和持久化。

浏览器元素引用使用 `el_01`（snapshot/find）、`e_01`（page.* 元素）和 `r_01`（page.* 区域）。扩展通过统一编号目录生成前缀，由 service worker 在 `chrome.storage.local` 持久自增分配；跨标签、导航和 worker 重启不复用。编号绑定实际 DOM 节点，同一节点重复观察保持编号；旧节点消失或不可见时操作失败，不按新枚举位置重新解释旧编号。

`web_search` 搜索公开网页链接；`tavily_search` 通过 Tavily 高级搜索返回网页及相关内容，单次 HTTP 请求入口为 `send_http`。旧搜索名称、`api_execute` 和未实现的接口登记入口已删除；未知工具调用明确失败。

`tavily_search` 属于动态服务工具，默认不加载，通过 `catalog.add` 启用。服务环境需配置 `TAVILY_API_KEY`（空配置示例见 `service/.env.example`）。搜索固定为 advanced，query 去除首尾空白，maxResults 默认 5、范围 1 至 10；每条 content 最多 4000 字符，截断标注 truncated。结果包含 query、searchDepth、results 和 urls；失败使用下述统一错误格式。

新增工具时维护定义、分类和必要的分组，并在对应执行端实现。修改说明后运行 `bun run scripts/sync-context-examples.ts` 更新示例，再运行 `bun run check`。

## 本机工具

`local-files.ts` 提供绝对路径的文件读写、列表、搜索、复制、移动与删除；`local-process.ts` 提供脚本执行、后台进程、标准输入、终止和系统打开。`local-tools.ts` 统一分派本机工具并建立会话作用域。工具定义仍只维护在 `definitions/local.*.json`，通过现有动态目录发现和 `catalog.add` 加载，不另建浏览器到本机的通信通道。

脚本在服务电脑上按扩展名选择解释器执行，必须提供绝对 cwd。仅在显式提供 timeoutMs 时设置执行时限。stdout/stderr 完整写入 process-output/<processId>/ 并返回正文与绝对路径，不设并发数量上限。后台进程ID只属于创建它的会话，服务重启后失效；停止会话、删除会话和服务正常退出会终止对应进程组。新建或切换会话不停止原会话任务；需要停止时先停止原会话。已结束进程记录保留至服务结束。

本地能力使用服务进程的操作系统权限，不绕过macOS权限；文件修改即时生效，不随聊天记录删除而回滚。`affectsPage=false` 仅说明不影响浏览器页面，不表示本地操作没有副作用。文件复制/移动默认拒绝已存在目标，移动的默认实现是复制成功后删除源，操作期间应避免源被其他程序修改。

## 压缩归档查询

常驻 `context.query(sumId, module, intent, cursor?)` 从指定摘要的来源中查询一个模块。模块为 userInput、goalChanges、toolIO、pageObservations、memoryWrites、output、queryHistory 或 summaries。Runtime 装配候选原文，查询 Agent 通过 submitMatches 返回命中的 turnIds，Runtime 校验后将对应记录放入 currentQuery；工具返回只含状态和引用。每次 records 的紧凑 JSON 最多 2000 字符；超出返回 partial 与 nextCursor，可带原查询参数和 cursor 继续读取，无需再次调用查询 Agent。超大单条保留身份字段及 fragment:{offset,totalChars,text}，text 是原记录 JSON 的连续片段，不是摘要。查询不会刷新页面。

查询模块统一为 conversationHistory；每份归档保留轮次内部的输入、目标变化、工具、页面观察、记忆增量及最终输出。目录与原文由 `service/context-archive/` 管理，工具层只校验参数并调度 `service/agents/query/`。查询 Agent 自己管理提示词、输入输出协议与业务校验，模型请求复用现有 `provider.complete`。查询 Agent 仅选择候选，返回 ID 不能作为文件路径。查询结果不再经过普通工具的二次截断。

脚本保存在服务数据目录 `data/scripts`：`script_patch(filename, patch)` 仅应用单文件 git unified diff，支持新增、修改和删除；`script_read(filename)` 返回代码，`script_list()` 返回文件名，三者的 affectsPage 固定为 false。文件名为单层 .sh/.py/.js/.mjs/.cjs。

`execute_javascript` 使用 filename（仅 .js/.mjs/.cjs）和可选 tab，不接受内联 code；内容为页面表达式，多语句或异步逻辑使用 IIFE。`local.run` / `local.process_start` 使用 filename 和绝对路径 cwd，可选 args 字符串数组及 timeoutMs；.sh 由 zsh、.py 由 python3、.js/.mjs/.cjs 由 bun 执行，不接受内联 command。补丁只返回状态，必须在确认成功后的下一次模型调用执行；Runtime 拒绝同批 script_patch 与脚本执行。

本机每次执行读取已保存文件并创建私有快照，后续补丁不会改变正在运行的脚本。普通相对文件路径按 cwd 解析；脚本自身路径和相对 import 按快照位置解析，不支持依赖托管目录中相邻脚本的相对导入。服务运行环境需安装 Git，补丁解析、检查与应用统一使用 `git apply --recount`，由 Git 按正文计算 hunk 行数。补丁仍需合法 unified diff 结构、匹配原文上下文及末尾换行；不猜测修复正文。

HTTP 传输由 `service/network/idle-fetch.ts` 统一检查响应活动，`http-text.ts` 管理工具重试和完整文本读取。网络空闲时限、尝试次数和重试间隔统一读取 `service/config/runtime.json`；空闲超时随响应数据重置，持续传输不会因总耗时过长被中止。服务工具接收回合的取消信号，批量请求取消后不再访问后续地址。

## 统一错误返回

模型可见的工具失败由 `result.ts` 统一输出 `{ok:false, faultCode, message, recovery, details}`，并保留 tab、HTTP 状态、批量结果等业务字段。`shared/error-messages.json` 是模型提示、用户提示和恢复建议的唯一文案来源；原始原因放在 details，未知错误保留错误码并使用通用提示。recovery 是下一步建议，不控制网络自动重试；超时后先检查操作是否生效，避免重复副作用。批量 HTTP 的失败子项使用同一格式，成功数据与 effects 保留。

查询保留底层错误码；压缩失败在回合输出中使用 compression_failed，并通过可选 causeCode 保留底层原因。侧栏分别显示请求超时、主动取消、连接失败、HTTP 错误和响应格式错误。

参数校验反馈包含参数 schema 和完整诊断；anyOf/oneOf 的候选分支保持替代关系，missing 仅列共同或已适用条件的必填字段。每个失败调用按 callId 独立记录，同名调用不会互相覆盖。模型自行修正调用参数并继续，历史参数保留 affectsPage；连续无效调用仍有停止上限，避免无限请求，达到上限只报告未完成状态，不要求用户补填工具参数。

点击工具：`click(targetText|ref)` 按控件文字或 snapshot_page/find_on_page 引用定位；`page.click(id)` 使用 page.* 的元素编号。两者保留独立引用体系，reason 是可选展示信息，不自动填充。click 不接受旧 text 字段，也不将非字符串强转为目标文字。

工具参数对象原样接收，字符串仅执行一次标准 JSON.parse，不修复围栏、尾逗号或单引号。HTTP 正文、响应头、搜索正文和脚本输出不再隐式截断；发送主模型前由统一上下文门禁处理文本。浏览器桥不设独立总执行时限；已执行请求只重发结果，扩展 worker 恢复时结果未知则返回错误而不重做动作。

动态加载成功后将工具名持久写入会话 ledger.loadedToolIds，新 turn 合并默认工具与会话清单生成 tools[]；重新打开会话和服务重启不清空，新会话独立。finishTurn 仅 text 必填，reason 和 affectsPage 可省略；正文仍必须非空，不从 content 补齐。
