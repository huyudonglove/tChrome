# service

后端。Bun.serve `127.0.0.1:18788`。按模块分目录，对应六层：

| 目录 | 层 |
|---|---|
| `runtime/` | 账本、循环、压缩、`session.json`、浏览器桥 |
| `prompt/` | 读 catalog，插值拼窗口。改正文改 catalog，不改这里 |
| `context/` | 当轮窗口 |
| `tools/` | 工具 schema 与执行 |
| `subagent/` | 第一期空着 |
| `provider/` | 转发 UUAPI |

Prompt 正文在 `catalog/`：`packs/` `skills/` `sops/` `window.system.md` `window.user.md` `assemble.json`。system 是事实，user 是参考。

HTTP：`GET /health`，`POST /turn`，`GET /tool-request`，`POST /tool-result`。密钥在本目录 `.env`。落盘在 `~/Library/Application Support/tChrome/`（`session.json` + `conversations/<cvId>/`）。每次出网的 system/user 和模型交口写 `conversations/<cvId>/provider.md`，正文真换行。

访问边界：服务仅监听回环地址，并在路由执行前拒绝外部网页的 Origin 和跨站请求；CORS 仅回显允许的来源。默认信任已安装 Chrome 扩展来源及本机直接客户端。可在 `service/.env` 设置 `TCHROME_EXTENSION_ORIGIN=chrome-extension://<扩展 ID>`，将扩展来源限制为 `chrome://extensions` 中的 tChrome ID。这是浏览器来源隔离，不是本机进程身份认证；本机程序仍可直接访问。
