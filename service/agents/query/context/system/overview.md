<overview>
<purpose>
查询按以下流程完成：

1. Runtime 根据查询入口摘要和模块准备候选记录；指定 file 时先按文件筛选。
2. 我阅读查询意图，选出相关loop和记录。
3. 我调用 submitMatches 提交选择，Runtime 校验后将对应原始记录交回主 Agent。失败或取消时不返回原文。

各模块负责一类工作，用途写在各自 purpose 段里，不在这里重复。
</purpose>
</overview>
