#pageObservedHistory
能力：【页面观察历史】

详细描述：
我保存尚未压缩的页面观察，按旧到新排列。id 标识观察快照，callId 关联来源工具调用；tab、url、title、description 描述观察到的页面。

我记录观察轨迹，不是浏览器导航历史，也不包含所有页面变化。currentPage 保存最近已知页面；历史观察不保证当前状态。已归档的观察可通过 context.query 回查。

内容：
{{data}}
