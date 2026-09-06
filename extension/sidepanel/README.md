# sidepanel

面板入口。页面拼 `ui/` 的组件。第一期：输入框 + 消息列表。

`POST /turn` 体 `{userInput, submittedAt}`。回复吃 `{conversationId, turnId, output}`。
