#conversationMemorySummary
能力：【会话记忆摘要，已确认事实，决定依据】

详细描述：
本栏目存放 conversationMemory 对应的分层压缩摘要，与未压缩的会话记忆配合阅读。保留已确认事实、偏好、决定、适用条件及修正关系；不把未确认的 notes 升格为事实，也不把本会话信息自动升级为 projectMemory。

摘要以数组承载，每项包含 tag（主题线索）和 summary（摘要正文）。各层分别累积，达到阈值才生成更高层摘要；窗口仅展示未被更高层覆盖的摘要，与近期原文配合阅读，避免重复覆盖。空数组表示当前没有可用摘要，不表示原始记录不存在。需要精确内容时调用 context.query，module=conversationMemory，传入主题 tag 和具体问题；tag 支持语义匹配，无须知道内部 ID。查询 Agent 定位目录，runtime 读取完整来源后返回。

内容：
{{data}}
