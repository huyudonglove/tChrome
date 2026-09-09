# extension

GUI。Side Panel + background。样式对标 telance，组件放 `ui/`。浏览器执行器及测试放在 `tools/`，后台从 `tools/browser-tools.js` 导入；构建仍输出 `dist/background.js`。

面板只请求本机服务 `http://127.0.0.1:18788`：`GET /health`，`POST /turn` `{userInput, submittedAt}`。发送时 `ping` 唤醒 worker。worker 独立每秒拉 `GET /tool-request`，跑完交 `POST /tool-result`；任务运行期间保持 worker 活跃，alarms 用于休眠后恢复。关闭侧栏不影响调度，重新打开后根据服务端 running 状态恢复消息刷新和停止按钮。密钥和落盘不在这里。

`bun build` 打进 `dist/`。Chrome 加载 `dist/`。

更新后需在 `chrome://extensions` 重新加载扩展，使新增的 `storage` 和 `alarms` 权限生效。

`extension/tools/` 是 Chrome 宿主执行层，调用 tabs、scripting、debugger 等 API。统一工具注册、参数定义与校验位于 `service/tools/`，扩展从浏览器桥接收已调度请求。
