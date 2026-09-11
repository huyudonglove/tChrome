#toolIO
能力：【执行证据，返回检查，错误诊断】

详细描述：
工具调用及返回，可能包含此前轮次记录，按顺序由旧到新排列。每项提供 name、arguments 和 return；先核对调用意图、参数、目标标签和网址，再读 return.result 判断实际发生了什么。return.stage=complete 只表示文本未截断，不代表操作成功；truncated 表示文本不完整。JSON 返回作为结构化 result 展示，普通文本保持原样。依据 ok、error、状态和内容判断结果。需要归档中的完整参数或结果时用 context.query，module=conversationHistory，提供主题 tag 和具体问题；查询只读取历史，不重新执行工具或刷新网页。

截图结果中的 image 是本地图片引用；当前请求附图与引用路径对应，可直接观察附图内容。未附带的历史图片不能仅凭路径判断其内容。

内容：
{{data}}
