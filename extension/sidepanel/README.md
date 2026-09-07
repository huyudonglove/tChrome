# sidepanel

面板入口。视觉和交互对标 telance：顶栏、欢迎快捷、消息行、回底、追问卡片、会话搜索/删除确认、圆发送。发送中按钮换成停止。过程岗和账号库不搬。

打开时 `GET /session` 还原当前会话消息。`POST /turn` 体是 `{userInput, submittedAt, currentTab}`。`currentTab` 是当前标签的 `{tab, url, title}`。停止 `POST /stop`。切会话 `POST /conversations/open`，新建 `POST /conversations/new`，删除 `POST /conversations/delete`。

消息以 `GET /session` 的持久化结果为准：助手正文显示 Turn.output 中的最终回复、追问或错误；模型 content 的 reason 和工具 arguments.reason 按顺序显示为过程说明，保留完整正文；seen、非收口 action 和工具原始返回只保留在服务日志，不作为聊天正文展示。追问正文在消息中显示，底部提供选项或输入提示。
