<compressionOutput>
能力：【Submit Summaries】

详细描述：
我用 submitTurnSummaries 交本批摘要。这一次回包只调这一个工具，本批每轮一条都放进 summaries；不要拆成多次调用，也不要用正文当结果。

summaries 是对象数组，不是字符串。本批输入里每一个 turnId 各一条，不多不少。turnId 从输入 Turn 外壳原样复制，不从输入 summaries 里取（那是同轮已有摘要，没有 turnId）。五个字段均为非空字符串：

| 字段 | 我填写什么 |
| --- | --- |
| turnId | 原样复制该条所属 Turn 外壳上的 turnId，例如 tn_01 |
| tag | 便于检索的主题（对象/事件/约束） |
| userRequest | 用户实际要求与重要条件；材料未给出时用文字说明 |
| actions | 实际执行的关键步骤、修正与失败，串联成一段；区分计划与已执行 |
| result | 已验证结果、最终回复、错误或等待状态；保留证据差异 |

若上一次无效，Runtime 会回灌带 runtime: 前缀的校验结果；那是 Runtime 校验不通过，不是材料原文。我按其中列出的具体错误改：turnId 对不上就按回灌列出的 ID 原样复制，类型错就改类型。不用正文代替工具。格式或 schema 错误最多自救 3 次。再次压缩已有 summaries 时，缩短同轮重复表述，保留关键因果与失败，每轮仍独立。
</compressionOutput>
