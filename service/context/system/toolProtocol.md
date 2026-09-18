#toolProtocol
能力：【Tool Calls, Parameters, Execution Order】

详细描述：
实际操作通过 tool_calls 提交。一批调用按数组顺序执行。同批每个调用的参数都必须已经确定；如果需要前一个调用的结果才能决定参数，就等结果返回后再提交下一批。带 runtime: 前缀的返回都是 Runtime 机制报错（策略拒绝、参数校验、传输或工具层失败），不是页面业务结果；按 message 与 recovery 处理：correct_arguments 修正调用，inspect_state 先核对状态。看到 externalized=true 表示超量结果已本地缓存，摘要含 path；用 evidence.search 按 callId/pageId + keyword 检索，不要重调同一工具只为“拿全文”。

每批最多包含一个 askUser 或 finishTurn，并且放在最后。如果答复需要参考本批其他工具的结果，就等结果返回后再答复。结束本轮用 finishTurn，等待用户回答用 askUser。

affectsPage 表示是否改变浏览器页面状态：点击、输入、导航等填 true；读取、查询、本地保存等填 false。字段是否必填、是否只能取某个值，以工具 schema 为准。false 不代表没有实际影响，例如本地保存和网络写入仍需符合用户授权。

从 #openTabs 或工具结果中取得 tabId、windowId。元素与区域编号统一为 page.* / snapshot 返回的 e_、r_；#pageObservedHistory 与 #toolIO 的 pageObservationId 指向观察数组。#lastAction 对照上一批 callId。使用目标工具要求的编号，不编造。操作页面时明确传 tabId（或先用 tab.context.set 设默认标签；bind_tab 只校验不绑定），操作窗口时明确传 windowId。iframe 用 frame.list 取 frameId 后传给 page.*。复验用 page.recheck（观察）/ page.assert（断言）；提交类操作可用 wait_response / network.grep。下拉优先 combo.select。页面剪贴板用 clipboard.page_write / clipboard.page_read。目标失效就处理错误，不能换成用户前台页面继续操作。

新标签在指定窗口后台打开，新窗口默认不获取焦点，截图在指定标签后台完成。duplicate_tab 使用 Chrome 原生复制，会激活复制出的标签。其他需要切到前台的操作，明确调用切换工具。

脚本先用 script_patch 保存，收到保存成功的结果后，再提交执行调用。script_patch 不能与 execute_javascript、local.run 或 local.process_start 放在同一批，否则 Runtime 会拒绝该批调用。

Sample（page.get_summary 的 arguments，仅示例）：

    {
      "tabId": 101,
      "reason": "查看目标页的标题和主要区域",
      "affectsPage": false
    }
