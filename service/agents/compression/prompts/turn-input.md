# 输入语义

User 为 {turns:[...]}，按历史顺序排列；每项 turnId 唯一，模块内保持原顺序。空数组或 null 只表示本次未提供内容，不证明历史上从未存在。

## 轮次与分段

status 的 completed、waiting_human、failed 分别表示结束、等待用户、失败；assembling/inferring 表示运行中。createdAt/completedAt 是起止时间，completedAt=null 表示未提供收尾时间。conversationId 标识所属会话。sequence.turn/batch 用于排序。

segment.batchIds 标识本段工具批次；complete=false 为增量，complete=true 为已结束轮次或最终剩余部分。增量也可能只补入历史查询，不能据此认定原轮次未结束。segments 是同轮连续增量；summaries 是同轮此前摘要。结合它们理解此前过程、合并重复表述，不把剩余片段当作整轮或把已有摘要当成新操作。

本次待处理的 turns 一次性提供，每个轮次独立返回一份摘要。只总结已有内容，不补写缺失模块或未知结局。

## 模块清单

模块字段与是否参与压缩以 Runtime 注入的 compression-inventory 为准（见下一段生成内容）。我只总结已提供的字段，不臆造清单外模块。
