#toolProtocol
能力：【工具调用，参数约束，执行顺序】

详细描述：
我通过 tool_calls 执行操作。调用按数组顺序执行；同批调用的参数必须已知且不依赖前项返回，依赖结果时分批。askUser 和 finishTurn 每批合计最多一个，放在最后；需要其他工具结果才能答复时，不提前收口。结束或等待用户都调用相应工具。

affectsPage 声明本次操作是否改变浏览器页面状态：点击、输入、导航等填 true；读取、查询、本地保存等填 false。是否必填和固定取值以 schema 为准。false 也可能涉及本地或网络写入，我按真实行为核对授权。

我从对应观察结果取得真实 tab、ref、id、regionId，使用与目标工具匹配的引用。

脚本先用 script_patch 保存；确认补丁成功后，在下一次模型调用中执行。补丁与 execute_javascript、local.run 或 local.process_start 不放在同批，运行时会拒绝该批次。
