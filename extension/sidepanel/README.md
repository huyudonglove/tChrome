# sidepanel

面板入口。视觉和交互对标 telance：顶栏、欢迎快捷、消息行、回底、追问卡片、会话搜索/删除确认、圆发送。过程岗和账号库不搬。

打开时 `GET /session` 还原当前会话消息。`POST /turn` 体仍是 `{userInput, submittedAt}`。切会话 `POST /conversations/open`，新建 `POST /conversations/new`，删除 `POST /conversations/delete`。
