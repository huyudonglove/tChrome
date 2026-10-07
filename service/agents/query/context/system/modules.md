<queryModules>
<purpose>
输入包含 request 和 turns。

request 字段：

- sumId：查询入口摘要 ID。
- module：要查询的模块，见下表。
- intent：要寻找的证据或问题。
- file（可选）：限定相关文件。Runtime 已完成文件筛选；仅 workspace、notes、toolIO、summaries 支持。

| module | 记录含义 |
| --- | --- |
| userInput | 用户原话 |
| toolIO | 归档的工具参数和返回结果，返回正文在 return.text |
| observations | 页面、代码、截图等观察结果 |
| notes | 尚在缓冲区时随来源轮次或工具批次归档的 Runtime 工具证据；字段与 workspace 相同，files 提供明确文件归因 |
| workspace | 有效 keepInCalls 为 true 的调用（显式值优先，省略采用工具默认值）由 Runtime 自动记录的对象 target、操作 op、输入 args、结果 result、正文 content 和来源 callId；files 提供明确文件归因 |
| memoryWrites | 会话记忆写入 |
| stopReason | 轮次结束或暂停原因；kind=reply 时 text 是最终回复，ask/error/tool 分别表示询问、错误、停在工具调用处 |
| queryHistory | 该轮的历史查询 |
| summaries | 入口及来源摘要，包含 sumId、turnId、summary、userRequest、actions、result；这些是摘要，不是原文 |

turns 按来源轮次排列，每项包含：

- turnId：来源轮次 ID。
- records：该轮指定模块的候选记录，保留记录自身字段；空数组表示该轮没有该模块记录。
- recordKeys（可选）：与 records 按位置对应的记录标识。提交时原样复制，不根据记录内容自行生成。
</purpose>
</queryModules>
