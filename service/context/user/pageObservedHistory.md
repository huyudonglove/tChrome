#pageObservedHistory
能力：【页面观察历史】

详细描述：
本轮工具返回的页面观察记录数组，每轮开始为空。每次获得有效页面信息时追加到数组末尾，按旧到新排列，包含最新一次观察；每条保留稳定 id、turnId、tab、url、title、description、observedAt、callId、toolName。观察在创建时落盘，可用 record.query（kind=pageObservation，id=该项 id）跨轮回查本会话的原记录。用于回看观察过的页面和变化，结合 currentPage 定位最近已知页面。发话时的标签快照不算工具观察，不自动加入历史；这些记录是观察轨迹，不是浏览器导航历史，也不代表所有页面变化都已记录。

内容：
{{data}}
