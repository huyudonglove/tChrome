#pageObservedHistory
能力：【页面观察历史】

详细描述：
本轮未压缩的页面观察，以数组按从旧到新的顺序提供，每条包含 tab、url、title、description。结合 pageObservedHistorySummary 回看页面和变化，currentPage 表示最近已知页面。发话时的标签快照不算工具观察；记录是观察轨迹，不是浏览器导航历史，也不代表所有页面变化都已记录。需要归档细节时用 context.query，module=pageObservedHistory，提供主题 tag 和具体问题；历史观察不保证当前页面状态。

内容：
{{data}}
