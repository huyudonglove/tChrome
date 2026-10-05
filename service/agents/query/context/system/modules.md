<queryModules>
<purpose>
本模块说明 request 各字段与候选 turns 里记录的形态。
下列字段出现在 User 的 { "request": {...}, "turns": [...] } 材料里。

request：

- sumId：本次查询入口摘要 ID。
- module：指定读取的模块。取值与含义：
  - userInput：用户原话
  - toolIO：工具参数与结果（归档形态，含 return.text）
  - observations：观察结果（页面、代码、截图等）
  - workspace：因果工作区条目（op/value）
  - memoryWrites：会话记忆写入
  - stopReason：当轮收尾。kind=reply 时字段为 text（最终回复正文）；ask/error/tool 同前；kind=tool 表示停在该调用、还没收口
  - queryHistory：当轮历史查询
  - summaries：入口及来源摘要对象 {sumId, turnId, summary, userRequest, actions, result}，不是原文
- intent：本次要找什么；我按它判断哪些轮次含相关证据。

turns：按来源轮次排列的候选数组。每项：

- turnId：来源轮次 ID；提交时原样复制这里的值。
- records：该轮指定模块的原始记录数组；记录保留自身标识。空数组表示该轮该模块没有记录。
</purpose>

</queryModules>
