#pageObservedHistory
能力：【页面观察历史】

详细描述：
尚未压缩的页面观察，以数组按从旧到新的顺序提供，每条包含 id、turnId、callId、tab、url、title、description。结合 conversationHistorySummary 回看页面和变化，currentPage 表示最近已知页面。发话时的标签快照不算工具观察；记录是观察轨迹，不是浏览器导航历史，也不代表所有页面变化都已记录。需要归档细节时用 context.query，module=conversationHistory，提供主题 tag 和具体问题；历史观察不保证当前页面状态。

每次原始观察的 id 标识该条历史快照，turnId 标识来源轮次，callId 关联产生观察的工具调用。同一工具调用产生的观察通过 callId 关联工具记录；tab 和页面控件 ID 用于浏览器定位，不能替代观察记录 ID。

内容：
{{data}}
