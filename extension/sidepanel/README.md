# sidepanel

顶栏书签图标打开资料库，网站、账号和普通资料跨会话保留，所有字段明文显示。支持搜索、类型筛选、新建、编辑、删除、复制和打开网址。打开时每三秒刷新列表以同步 Agent 的改动，编辑草稿独立保留。通过 `/library`、`/library/save`、`/library/delete` 与服务共享存储，样式位于 `library.css`。

面板入口。视觉和交互对标 telance：顶栏、欢迎快捷、消息行、回底、追问卡片、会话搜索/删除确认、圆发送。发送中按钮换成停止。过程岗和账号库不搬。

打开时 `GET /session` 还原当前会话消息。`POST /turn` 体是 `{userInput, submittedAt, currentTab}`。`currentTab` 是当前标签的 `{tab, url, title}`。停止 `POST /stop`。切会话 `POST /conversations/open`，新建 `POST /conversations/new`，删除 `POST /conversations/delete`。

运行时通过会话轮询读取 `activity`。压缩期间顶栏显示“正在压缩上下文”，状态栏区分历史记录、当前轮记录、已有摘要，并说明完成后自动继续；停止按钮仍可使用。状态由当前活动轮的压缩事件投影，完成、失败或停止后清除，不进入聊天正文或模型上下文。Runtime 在发送主模型请求前等待压缩完成。

消息以 `GET /session` 的持久化结果为准：助手正文显示 Turn.output 中的最终回复、追问或错误；模型 content 的 reason 和工具 arguments.reason 按顺序显示为过程说明，保留完整正文；seen、非收口 action 和工具原始返回只保留在服务日志，不作为聊天正文展示。追问正文在消息中显示，底部提供选项或输入提示。
