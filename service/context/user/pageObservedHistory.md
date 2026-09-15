#pageObservedHistory
能力：【Page Observation History】

详细描述：
实际页面观察，包含最新一次观察，按旧到新排列。id 标识快照，callId 关联来源调用；tabId、url、title、description 描述当时页面。这里只记录观察轨迹，不是完整导航历史，也不代表当前状态。更早观察可通过 context.query 回查。

Sample（仅示例，不是当前记录）：

    [
      {"id":"page_01","turnId":"tn_01","callId":"call_02","tabId":102,"url":"https://example.com/help","title":"导出帮助","description":"页面说明支持导出 CSV"}
    ]

内容：
{{data}}
