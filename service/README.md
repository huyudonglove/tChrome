# service

会话 ID 的分配高水位保存在数据目录的 `conversation-id.json`，删除会话后不复用 ID。浏览器工具请求跨会话按 FIFO 排队，仅队首计算执行超时；停止或删除会话只取消该会话的请求。侧栏 `/stop` 携带 `conversationId`，过期会话请求返回 409。

循环按 Turn 分别统计 `usage.modelRequests`（请求模型次数，不含 provider 内部重试）和 `usage.toolCalls`（实际进入执行器的工具次数，含常驻及收口工具；批量调用逐个计数）。统计保存在 Turn 文件中。正常工具循环没有 20 次累计出网上限，持续至完成、追问、用户停止或执行错误。连续 3 次无效提交仍会中止；正常执行一批工具会重置连续失败计数。

后端。Bun.serve `127.0.0.1:18788`。按职责分目录：

| 目录 | 层 |
|---|---|
| `runtime/` | 账本、循环、工具证据归档、`session.json`、浏览器桥 |
| `context/` | modules.ts 加载上下文模块；window.ts 纯投影当轮数据、记忆和已提供的工具说明 |
| `tools/` | registry.ts 读取本模块 definitions/ 内工具定义、分组和分类；参数检查、工具执行及结构化效果 |
| `provider/` | 模型通信、传输重试与响应解析 |
| `presentation/` | 纯函数生成会话消息、错误文案、待执行工具和列表预览 |

Prompt 正文与加载器都在 `service/context/`。system-slots.md / user-slots.md 只保存编号文件名；每个模块独立声明 tag、能力和详细描述。加载器读取元数据生成两份导航，依次放在 system 开头，再追加七个 system 模块正文。user 保留原十五个 tag 的详细描述和工作数据，不重复能力标签。execution 拆出 toolProtocol 与 boundaries；网页方法直接放在 user/skill.md。

工具 API 定义位于 `service/tools/definitions/`，分组在 groups.json。说明唯一来自 function.description，index 只分类；常驻说明进入 #baseTools，动态说明进入 #tools。运行提示位于 service/runtime/messages.json。上下文 README 是维护入口，不进入模型窗口。

HTTP：`GET /health`，`POST /turn`，`GET /tool-request`，`POST /tool-result`。密钥在本目录 `.env`。落盘在 `~/Library/Application Support/tChrome/`（`session.json` + `conversations/<cvId>/`）。每次出网的 system/user 和模型交口写 `conversations/<cvId>/provider.md`，正文真换行。

访问边界：服务仅监听回环地址，并在路由执行前拒绝外部网页的 Origin 和跨站请求；CORS 仅回显允许的来源。默认信任已安装 Chrome 扩展来源及本机直接客户端。可在 `service/.env` 设置 `TCHROME_EXTENSION_ORIGIN=chrome-extension://<扩展 ID>`，将扩展来源限制为 `chrome://extensions` 中的 tChrome ID。这是浏览器来源隔离，不是本机进程身份认证；本机程序仍可直接访问。

存储层保留持久化和会话命令，读取 ledger / events / turns 后调用 presentation 投影，命令返回行为保持不变。浏览器执行实现在 `extension/tools/browser-tools.js`，由后台 worker 调用。

超过窗口阈值时，Runtime 仅将较早 toolIO 归档为 observation，保留最近两条，并提供 `observation.detail` 回查。Context 每层投影最近 8 条记忆，超阈值时 turn / conversation 显示 summary（没有摘要时生成展示用短文本），project 不做摘要压缩。该投影不写磁盘记忆、不裁 memoryIds，也不卸载 toolIds。

Provider 使用 Chat Completions 的 `stream: false`，解析完整 JSON 响应。统一策略校验位于 `runtime/loop.ts` 的 `validateCompletion`，调用 `tools/schema.ts` 检查所有 provider 返回的工具提交；provider 不承担工具加载策略或批次执行决策。
