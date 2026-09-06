# sidepanel

面板入口。页面拼 `ui/` 的组件：输入框 + 消息列表 + 会话抽屉。

打开时 `GET /session` 还原当前会话消息。`POST /turn` 体仍是 `{userInput, submittedAt}`。切会话 `POST /conversations/open`，新建 `POST /conversations/new`。
