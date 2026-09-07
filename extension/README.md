# extension

GUI。Side Panel + background。样式对标 telance，组件放 `ui/`。

面板只请求本机服务 `http://127.0.0.1:18788`：`GET /health`，`POST /turn` `{userInput, submittedAt}`。发送时 `ping` 唤醒 worker。worker 独立每秒拉 `GET /tool-request`，跑完交 `POST /tool-result`；任务运行期间保持 worker 活跃，alarms 用于休眠后恢复。关闭侧栏不影响调度，重新打开后根据服务端 running 状态恢复消息刷新和停止按钮。密钥和落盘不在这里。

`bun build` 打进 `dist/`。Chrome 加载 `dist/`。

更新后需在 `chrome://extensions` 重新加载扩展，使新增的 `storage` 和 `alarms` 权限生效。
