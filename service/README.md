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

Prompt 正文在 `catalog/`：`packs/` `skills/` `sops/` `advice.md` `window.system.md` `window.user.md` `assemble.json`。system 是事实，user 是参考。

HTTP：`GET /health`，`POST /turn`，`GET /tool-request`，`POST /tool-result`。密钥在本目录 `.env`。落盘在 `~/Library/Application Support/tChrome/`（`session.json` + `conversations/<cvId>/`）。每次出网的 system/user 和模型交口写 `conversations/<cvId>/provider.md`，正文真换行。
