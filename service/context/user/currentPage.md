#currentPage
能力：【当前页面】

详细描述：
本轮最近已知的页面信息，包含 tab、url、title、description。初始取用户发话时的标签信息，此时尚未读取页面内容，也没有页面观察 ID；工具返回有效页面信息后替换为最新观察记录，与 pageObservedHistory 中对应项共用 id，并保留 turnId、observedAt、callId、toolName。带观察 id 时可用 record.query（kind=pageObservation，id=该 id）回查。用于定位当前已知页面，不是实时监控，也不是每次操作都会刷新；需要确认当前实际状态时重新观察。

内容：
{{data}}
