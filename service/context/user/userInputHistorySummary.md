#userInputHistorySummary
能力：【历史要求摘要，条件演变，原话线索】

详细描述：
本栏目存放 userInputHistory 对应的分层压缩摘要，与尚未压缩的历史原话配合阅读。保留用户要求、约束、偏好、纠正及其先后关系；不得把 Agent 的推测写成用户要求。摘要仅作历史背景，不能覆盖 userInput 中的最新指令。

摘要以数组承载，每项包含 tag（主题线索）和 summary（摘要正文）。各层分别累积，达到阈值才生成更高层摘要；窗口仅展示未被更高层覆盖的摘要，与近期原文配合阅读，避免重复覆盖。空数组表示当前没有可用摘要，不表示原始记录不存在。需要精确内容时调用 context.query，module=userInputHistory，传入主题 tag 和具体问题；tag 支持语义匹配，无须知道内部 ID。查询 Agent 定位目录，runtime 读取完整来源后返回。

内容：
{{data}}
