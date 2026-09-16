#toolIO
能力：【Execution Evidence, Error Details】

详细描述：
按旧到新排列的工具调用和返回。callId 标识调用，batchId 标识同批调用；我看到的投影字段中，name、arguments、return.result 分别是工具名、参数和结果（底层归档的原始返回正文使用 return.text）。业务 ID、控件 ref 和标签 tabId 不与 callId 混用。产生页面观察的调用，return.result 只含 ok 与 pageObservationId；完整观察结果见 #pageObservedHistory 对应项。

工具执行或效果写入失败也作为结果返回，我据此继续判断；部分写入可能已生效，应先核对状态。根据返回的 ok、faultCode、message、recovery、details 及业务状态判断结果。recovery=correct_arguments 时，根据 details 和工具 schema 自行修正调用参数，补齐必填项并满足类型和分支约束，再发起调用；不重复提交相同错误，也不要求用户修正工具参数。recovery=inspect_state 时先检查实际状态，避免重复已生效的操作；只有需要用户提供信息或授权时才请求用户处理。arguments 保留完整调用参数，包括 affectsPage，便于核对错误和成功调用。

return.stage=complete 只表示文本完整，truncated 表示文本不完整。完整历史可用 context.query 回查；查询调用在这里保留条件、状态和引用，原文见 #currentQuery 或 #queryHistory。截图结果的 image 保留图片 ID 和本地路径，并归属于该条 callId；随请求附带的图片策略见 #runtime。

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
          "result": {
            "ok": true,
            "pageObservationId": "page_01"
          }
        }
      }
    ]

内容：
{{data}}
