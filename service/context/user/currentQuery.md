#currentQuery
能力：【Current Query, Original Records】

详细描述：
最近一次查询结果，null 表示暂无查询。queryId 标识查询，sumId 指向来源摘要，module 和 intent 是查询条件；records 保留原模块记录及其 ID。

status 为 complete、partial、not_found 或 error，分别表示所选记录已全部返回、部分返回、未匹配或失败。Runtime 只在这里放查询状态和原始记录引用；单次 records 的紧凑 JSON 最多 2000 字符。fragment 的 offset、totalChars、text 表示原记录 JSON 的连续片段。partial 时保持原查询参数，将 nextCursor 作为 cursor 续读，不自行构造游标。部分结果只支持已返回的证据；未找到不证明事实不存在。

Sample（仅示例，不是当前记录）：

    {
      "queryId": "query_02", "turnId": "tn_03", "sumId": "sum_01",
      "module": "pageObservations", "intent": "查找已观察到的导出格式",
      "sourceCallId": "call_10", "status": "complete",
      "records": [
        {"id":"page_01","turnId":"tn_01","callId":"call_02","tabId":102,"url":"https://example.com/help","title":"导出帮助","description":"页面说明支持导出 CSV"}
      ]
    }

内容：
{{data}}
