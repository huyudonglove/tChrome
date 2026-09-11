#userInput
能力：【当前请求，任务入口】

详细描述：
以对象提供本轮用户原话：id 是稳定输入 ID，turnId 标明轮次，userInput 保留原话，submittedAt 是提交时间。当前输入移入历史时沿用同一 ID；需要核对原文时用 record.query（kind=userInput，id=该 id）。优先理解本次要求及修正；结合相关历史理解指代，不把未提出的历史事项自动加入本轮。

内容：
{{data}}
