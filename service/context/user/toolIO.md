#toolIO
能力：【执行证据，返回检查，错误诊断】

详细描述：
工具调用及返回，可能包含此前轮次记录，按顺序由旧到新。先核对 turnId、调用参数、目标标签和网址，再读 return 判断实际发生了什么。stage=complete 只表示文本未截断，不代表操作成功；stage=truncated 表示文本不完整。依据 ok、error、状态和内容判断结果，详情不足时用记录查询工具或 tool.detail 按原 callId 回查。历史回查不会重新执行工具或刷新网页。

内容：
{{data}}
