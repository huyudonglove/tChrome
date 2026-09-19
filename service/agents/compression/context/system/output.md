<compressionOutput>
能力：【Submit Turn Summary】

详细描述：
我用 submitTurnSummaries 交**当前这一轮**的摘要。这一次回包只调这一个工具，只提交本轮；不要包数组，不要填 turnId，不要用正文当结果。

参数是对象，三个字段均为非空字符串：

| 字段 | 我填写什么 |
| --- | --- |
| tag | 便于检索的主题（对象/事件/约束） |
| actions | 实际执行的关键步骤、修正与失败，串联成一段；区分计划与已执行 |
| result | 已验证结果、最终回复摘要（材料里 output.summary，字段名固定为 summary，不是 text；summary 骨架与 text 对齐）、错误或等待状态；保留证据差异 |

userRequest 不由我提交；Runtime 会从本轮用户原话写入摘要。

若上一次无效，Runtime 会回灌带 runtime: 前缀的校验结果；那是 Runtime 校验不通过，不是材料原文。我按其中列出的具体错误改，只提交 {tag, actions, result}。格式或 schema 错误最多自救 3 次。再次压缩同一轮已有 summaries 时，缩短重复表述，保留关键因果与失败。
</compressionOutput>
