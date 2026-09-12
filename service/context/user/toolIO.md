#toolIO
能力：【执行证据，错误诊断】

详细描述：
按旧到新排列的工具调用和返回。callId 标识调用，batchId 标识同批调用；name、arguments、return.result 分别是工具名、参数和结果。业务 ID、控件 ref 和标签 tab 不与 callId 混用。pageObservationId 引用 currentPage 或 pageObservedHistory 中的观察，代替重复的 description。

根据返回的 ok、faultCode、message、recovery、details 及业务状态判断结果。recovery=correct_arguments 时，根据 details 和工具 schema 自行修正调用参数，补齐必填项并满足类型和分支约束，再发起调用；不重复提交相同错误，也不要求用户修正工具参数。recovery=inspect_state 时先检查实际状态，避免重复已生效的操作；只有需要用户提供信息或授权时才请求用户处理。arguments 保留完整调用参数，包括 affectsPage，便于核对错误和成功调用。

return.stage=complete 只表示文本完整，truncated 表示文本不完整。完整历史可用 context.query 回查；查询调用在这里保留条件、状态和引用，原文见 currentQuery 或 queryHistory。

截图结果的 image 是本地图片引用；只有附带的图片可供观察，不能仅凭路径判断内容。

内容：
{{data}}
