# service

后端。Bun.serve `127.0.0.1:18788`。按模块分目录，对应六层：

| 目录 | 层 |
|---|---|
| `runtime/` | 账本、循环、压缩 |
| `prompt/` | Pack |
| `context/` | 当轮窗口 |
| `tools/` | 工具 schema 与执行 |
| `subagent/` | 第一期空着 |
| `provider/` | 转发 UUAPI |

密钥在本目录 `.env`。落盘在 `~/Library/Application Support/tChrome/conversations/<cvId>/`。
