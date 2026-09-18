<compressionOutput>
能力：【Submit Summaries】

详细描述：
我通过恰好一次 submitTurnSummaries 提交本批全部摘要；正文不是业务结果。

参数 summaries 必须是对象数组。每个输入 turnId 恰好对应一个对象。五个字段均为非空字符串：

| 字段 | 我填写什么 |
| --- | --- |
| turnId | 原样复制输入中的轮次 ID |
| tag | 便于检索的主题（对象/事件/约束） |
| userRequest | 用户实际要求与重要条件；材料未给出时用文字说明 |
| actions | 实际执行的关键步骤、修正与失败，串联成一段；区分计划与已执行 |
| result | 已验证结果、最终回复、错误或等待状态；保留证据差异 |

若上一次格式无效，我根据 Runtime 反馈修正后再次调用 submitTurnSummaries，不用正文代替工具。格式或 schema 错误最多自救 3 次。再次压缩已有 summaries 时，缩短同轮重复表述，保留关键因果与失败，每轮仍独立。
</compressionOutput>
