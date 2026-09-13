# sidepanel

顶栏书签图标打开资料库，网站、账号和普通资料跨会话保留，所有字段明文显示。支持搜索、类型筛选、新建、编辑、删除、复制和打开网址。打开时每三秒刷新列表以同步 Agent 的改动，编辑草稿独立保留。通过 `/library`、`/library/save`、`/library/delete` 与服务共享存储，样式位于 `library.css`。

面板入口。视觉和交互对标 telance：顶栏、欢迎快捷、消息行、回底、追问卡片、会话搜索/删除确认、圆发送。发送中按钮换成停止。过程岗和账号库不搬。

打开时 `GET /session` 还原当前会话消息。`POST /turn` 体是 `{userInput, submittedAt, currentTab}`。`currentTab` 是当前标签的 `{tab, url, title}`。停止 `POST /stop`。切会话 `POST /conversations/open`，新建 `POST /conversations/new`，删除 `POST /conversations/delete`。

运行时通过会话轮询读取 `activity`。压缩期间在输入框正上方固定显示醒目状态条，区分历史记录与当前轮记录，并说明完成后自动继续；状态条位于消息滚动区之外；停止按钮仍可使用。状态由当前活动轮的压缩事件投影，完成、失败或停止后清除，不进入聊天正文或模型上下文。Runtime 在发送主模型请求前等待压缩完成。

任务状态与最终回复以服务端会话记录为准，HTTP 请求错误单独提示。会话轮询校验响应，失败时保留上次有效状态，运行中与空闲时均继续重试，成功后清除同步错误。会话和列表独立刷新，列表失败不阻止会话更新；已发出的消息不因响应或刷新失败回填输入框。

消息以 `GET /session` 的持久化结果为准：助手正文显示 Turn.output 中的最终回复、追问或错误；工具 arguments.reason 按顺序显示为过程说明，保留完整正文。模型 content 和工具原始返回只保留在服务日志。最终回复来自 finishTurn.text，追问来自 askUser.question；追问正文在消息中显示，底部提供选项或输入提示。
