# service

循环按 Turn 分别统计 `usage.modelRequests`（请求模型次数，不含 provider 内部重试）和 `usage.toolCalls`（实际进入执行器的工具次数，含常驻及收口工具；批量调用逐个计数）。统计保存在 Turn 文件中。正常工具循环没有 20 次累计出网上限，持续至完成、追问、用户停止或执行错误。连续 3 次无效提交仍会中止；正常执行一批工具会重置连续失败计数。

后端。Bun.serve `127.0.0.1:18788`。按职责分目录：

| 目录 | 层 |
|---|---|
| `runtime/` | 账本、循环、压缩、`session.json`、浏览器桥 |
| `context/` | modules.ts 加载上下文与工具定义；window.ts 注入当轮数据、拼窗口 |
| `tools/` | 工具 schema 与执行 |
| `subagent/` | 第一期空着 |
| `provider/` | 转发 UUAPI |

Prompt 正文在仓库根 `context/`：`system/` `user/` `skills/` `tools/`。两份栏目清单为 system-slots.md / user-slots.md，同时提供模型导航和唯一模块顺序；加载器按清单排列各槽正文。工具分组在 tools/groups.json，运行提示在 service/runtime/messages.json；context/README.md 仅供维护者阅读，不进入模型窗口。工具说明仅来自工具 JSON 的 function.description，index 只分类。system 是固定规则和常驻工具说明，user 是请求与参考数据。

HTTP：`GET /health`，`POST /turn`，`GET /tool-request`，`POST /tool-result`。密钥在本目录 `.env`。落盘在 `~/Library/Application Support/tChrome/`（`session.json` + `conversations/<cvId>/`）。每次出网的 system/user 和模型交口写 `conversations/<cvId>/provider.md`，正文真换行。

访问边界：服务仅监听回环地址，并在路由执行前拒绝外部网页的 Origin 和跨站请求；CORS 仅回显允许的来源。默认信任已安装 Chrome 扩展来源及本机直接客户端。可在 `service/.env` 设置 `TCHROME_EXTENSION_ORIGIN=chrome-extension://<扩展 ID>`，将扩展来源限制为 `chrome://extensions` 中的 tChrome ID。这是浏览器来源隔离，不是本机进程身份认证；本机程序仍可直接访问。
