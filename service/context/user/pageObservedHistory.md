#pageObservedHistory
能力：【Page Observation History】

详细描述：
页面观察操作的统一数组，按旧到新排列，最新在末尾。每项：id 标识观察，callId 关联来源调用，tabId 是目标标签，type 是产生观察的工具名（如 page.get_summary），result 是该次工具完整返回。这里集中保存观察结果；#toolIO 中对同一 callId 只保留 pageObservationId 引用，不重复整段返回。更早观察可通过 context.query 回查。不自动代表页面当前状态。

Sample（仅示例，不是当前记录）：

    [
      {
        "id": "page_01",
        "turnId": "tn_01",
        "callId": "call_02",
        "tabId": 102,
        "type": "page.get_summary",
        "result": {
          "ok": true,
          "tabId": 102,
          "title": "导出帮助",
          "url": "https://example.com/help",
          "description": "页面说明支持导出 CSV"
        }
      }
    ]

内容：
{{data}}
