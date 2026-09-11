# 服务工具

本目录是本机服务的工具能力模块，统一管理定义、注册、参数校验和服务端执行。工具 API 的唯一 schema 与说明来源位于本模块 `definitions/`。

- `definitions/<工具名>.json`：工具名称、`function.description`、参数 schema。
- `definitions/index.json`：动态工具的 browser / service 分类。
- `definitions/groups.json`：常驻工具和初始动态工具分组。

`registry.ts` 读取本模块定义并提供 schema 与说明；上下文只接收说明文本。`schema.ts` 校验调用，Runtime 对所有模型响应统一执行校验后调度。`service/context/` 负责同一服务内的上下文装配。Chrome API 操作由 `extension/tools/` 的宿主执行器完成，经浏览器桥接收服务调度；工具注册和 schema 仍统一维护在本模块。工具返回结构化结果与 effects，`service/runtime/effects.ts` 统一应用状态和持久化。

新增工具时维护定义、分类和必要的分组，并在对应执行端实现。修改说明后运行 `bun run scripts/sync-context-examples.ts` 更新示例，再运行 `bun run check`。

## 本机工具

`local-files.ts` 提供绝对路径的文件读写、列表、搜索、复制、移动与删除；`local-process.ts` 提供命令执行、后台进程、标准输入、终止和系统打开。`local-tools.ts` 统一分派本机工具并建立会话作用域。工具定义仍只维护在 `definitions/local.*.json`，通过现有动态目录发现和 `catalog.add` 加载，不另建浏览器到本机的通信通道。

命令在服务电脑上由 zsh 执行，必须提供绝对 cwd。默认30秒、最长300秒超时，每个输出流持续读取并保留末尾65536字符，最多并行8个进程。后台进程ID只属于创建它的会话，服务重启后失效；停止会话、删除会话和服务正常退出会终止对应进程组。新建或切换会话不停止原会话任务；需要停止时先停止原会话。已结束进程记录最多保留64条。

本地能力使用服务进程的操作系统权限，不绕过macOS权限；文件修改即时生效，不随聊天记录删除而回滚。`affectsPage=false` 仅说明不影响浏览器页面，不表示本地操作没有副作用。文件复制/移动默认拒绝已存在目标，移动的默认实现是复制成功后删除源，操作期间应避免源被其他程序修改。

## 压缩归档查询

常驻 `context.query(module, tag, question?)` 将主题交给查询 Agent 语义匹配本会话轮次归档目录，由 runtime 校验内部 ID、沿来源关系读取原文并去重，按原顺序返回。主 Agent 无需提供记录 ID。只检索已压缩归档；支持多条或 not_found，单次原文内容上限 30,000 字符，超过时返回 partial 和遗漏数量，不截断单条原文。请缩小主题或问题后再查；单条原文本身超过上限时也会明确返回 partial。查询不会刷新页面。

查询模块统一为 conversationHistory；每份归档保留轮次内部的输入、目标变化、工具、页面观察、记忆增量及最终输出。目录与原文由 `service/context-archive/` 管理，工具层只校验参数并调度 `service/agents/query/`。查询 Agent 自己管理提示词、输入输出协议与业务校验，模型请求复用现有 `provider.complete`。查询 Agent 仅选择候选，返回 ID 不能作为文件路径。查询结果不再经过普通工具的二次截断。
