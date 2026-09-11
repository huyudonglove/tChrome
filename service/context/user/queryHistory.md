#queryHistory
能力：【历史查询，取证经过，原文关联】

详细描述：
我保存历史查询及其原文证据，按旧到新排列。queryId 标识一次查询，sumId 指向来源摘要；module 是查询模块，intent 是查询意图，status 是查询状态。records 直接保留原模块记录及其 ID，如 callId、memoryId 或 id，不另加包装或改名。

我说明当时查了什么、读到了什么，不代表当前业务状态。本轮查询历史可作为压缩参考，有用结论合入 result，不把查到的历史操作写成本轮重新执行的操作。最新查询单独放在 currentQuery。

内容：
{{data}}
