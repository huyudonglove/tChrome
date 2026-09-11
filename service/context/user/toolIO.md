#toolIO
能力：【执行证据，返回检查，错误诊断】

详细描述：
我保存工具调用及返回，按旧到新排列。callId 标识一次调用，batchId 标识同一次模型返回的工具批次；name 是工具名，arguments 是参数，return.result 是结果。参数和结果中的业务 ID、控件 ref、标签 tab 按工具定义使用，不与 callId 混用。

先核对调用意图和参数，再根据返回的 ok、error、状态及内容判断实际结果。return.stage=complete 只表示文本完整，不代表操作成功；truncated 表示文本不完整。JSON 结果按结构展示，其他文本保留原样。归档中的完整记录可通过 context.query 回查，查询不会重新执行操作。

截图结果的 image 是本地图片引用，可观察本次请求附带的对应图片；没有附图时，不能仅凭路径判断图片内容。

内容：
{{data}}
