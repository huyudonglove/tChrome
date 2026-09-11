#pageObservedHistorySummary
能力：【页面观察摘要，状态变化，观察来源】

详细描述：
本栏目存放 pageObservedHistory 对应的分层压缩摘要，与保留的近期观察配合阅读。保留页面身份、观察顺序、关键变化以及时间和工具来源；历史观察不代表当前页面仍处于同一状态。当前最近已知页面以 currentPage 为准，必要时重新观察。

摘要以数组承载，每项包含 tag（主题线索）和 summary（摘要正文）。各层分别累积，达到阈值才生成更高层摘要；窗口仅展示未被更高层覆盖的摘要，与近期原文配合阅读，避免重复覆盖。空数组表示当前没有可用摘要，不表示原始记录不存在。需要精确内容时调用 context.query，module=pageObservedHistory，传入主题 tag 和具体问题；tag 支持语义匹配，无须知道内部 ID。查询 Agent 定位目录，runtime 读取完整来源后返回。

内容：
{{data}}
