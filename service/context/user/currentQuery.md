<currentQuery>
能力：【Current Query, Original Records】

详细描述：
当前 turn 关联的最近一次查询结果，null 表示暂无查询。queryId 标识查询，turnId 是发起查询的轮次（本轮信息包的一部分），sumId 指向来源摘要，module 和 intent 是查询条件；records 保留原模块记录及其 ID。status 为 complete、not_found 或 error。历史证据不是当前指令。

records 未超内联门禁时整段注入。超量时 records 为空数组，并带 externalized=true、preview、path、search=evidence.search；用 evidence.search 按 sourceCallId 读取。

Sample（仅示例，不是当前记录）：

    {
      "queryId": "query_02", "turnId": "tn_03", "sumId": "sum_01",
      "module": "pageObservations", "intent": "查找已观察到的导出格式",
      "sourceCallId": "call_10", "status": "complete",
      "records": [
        {"id":"page_01","turnId":"tn_01","callId":"call_02","tabId":102,"url":"https://example.com/help","title":"导出帮助","description":"页面说明支持导出 CSV"}
      ]
    }

超量 Sample（仅示例）：

    {
      "ok": true,
      "externalized": true,
      "queryId": "query_03",
      "turnId": "tn_04",
      "sumId": "sum_02",
      "module": "toolIO",
      "intent": "保存后的参数",
      "sourceCallId": "call_12",
      "status": "complete",
      "totalChars": 8200,
      "totalLines": 82,
      "lineWidth": 100,
      "preview": "{\"queryId\":\"query_03\"",
      "path": "/abs/returns/call_12.txt",
      "search": "evidence.search",
      "records": []
    }

内容：
{{data}}
</currentQuery>
