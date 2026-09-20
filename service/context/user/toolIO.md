<toolIO>
能力：【Execution Evidence, Error Details】

详细描述：
按旧到新排列的工具调用和返回。窗口里每条是 {callId, turnId, batchId?, name, arguments, return:{stage, result}}。callId 标识调用，batchId 标识同批调用，name 是工具名，arguments 是完整参数（含 affectsPage）。finishTurn 在窗口中只投影 arguments.text（最终回复正文）。业务 ID、控件 ref 和标签 tabId 不与 callId 混用。

return.stage=complete 表示这次调用的返回文本已经收齐；truncated 表示文本没收齐。这只说明文本是否完整，不证明操作成功。return.result 是解析后的结果：

- 产生页面观察的调用：{ok, pageObservationId}；完整观察见 <pageObservedHistory>。
- context.query：{ok, status, sumId, module, intent, currentQuery:true, recordCount}；原文见 <currentQuery>。
- 失败：含 ok=false，以及 faultCode、message、recovery、details。recovery=correct_arguments 时按 details 和工具 schema 修正参数再调，不重复提交相同错误，也不要求用户改工具参数。recovery=inspect_state 时先核对实际状态。部分写入可能已生效。
- 其他调用：该工具自己的返回对象。

完整历史可用 context.query 回查。截图观察在 <pageObservedHistory>；随请求附带的图片策略见 <runtime>。

Sample（仅示例，不是当前记录）：

    [
      {
        "callId": "call_03",
        "turnId": "tn_02",
        "batchId": "batch_02",
        "name": "page.get_summary",
        "arguments": {
          "tabId": 101,
          "reason": "查看列表页，确认提交后的页面内容",
          "affectsPage": false
        },
        "return": {
          "stage": "complete",
          "result": { "ok": true, "pageObservationId": "page_01" }
        }
      },
      {
        "callId": "call_10",
        "turnId": "tn_03",
        "batchId": "batch_03",
        "name": "context.query",
        "arguments": {
          "sumId": "sum_01",
          "module": "pageObservations",
          "intent": "查找已观察到的导出格式",
          "reason": "回查导出格式",
          "affectsPage": false
        },
        "return": {
          "stage": "complete",
          "result": {
            "ok": true,
            "status": "complete",
            "sumId": "sum_01",
            "module": "pageObservations",
            "intent": "查找已观察到的导出格式",
            "currentQuery": true,
            "recordCount": 1
          }
        }
      },
      {
        "callId": "call_11",
        "turnId": "tn_03",
        "batchId": "batch_03",
        "name": "page.click",
        "arguments": {
          "tabId": 101,
          "id": "e_04",
          "reason": "点击导出",
          "affectsPage": true
        },
        "return": {
          "stage": "complete",
          "result": {
            "ok": false,
            "faultCode": "missing_required",
            "message": "缺少 id",
            "recovery": "correct_arguments"
          }
        }
      }
    ]

内容：
{{data}}
</toolIO>
