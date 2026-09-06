# extension

GUI。Side Panel + background。样式对标 telance，组件放 `ui/`。

面板只请求本机服务 `http://127.0.0.1:18788`：`GET /health`，`POST /turn` `{userInput, submittedAt}`。发送期间每秒 `ping` worker。worker 拉 `GET /tool-request`，跑完交 `POST /tool-result`。密钥和落盘不在这里。

`bun build` 打进 `dist/`。Chrome 加载 `dist/`。
