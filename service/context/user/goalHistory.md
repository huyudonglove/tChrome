#goalHistory
能力：【目标历史，方向变化】

详细描述：
尚未归档且被替换掉的旧目标，以记录数组按从旧到新的顺序提供，每项包含 id、turnId、sourceCallId 和目标文本 goal。供理解方向变化，历史目标不是当前待办，不自动恢复执行；以当前请求和仍适用的目标为准。已归档的目标变化结合 conversationHistorySummary 阅读，精确原文可通过 context.query（module=conversationHistory）按主题回查。

id 区分不同目标版本，turnId 表示版本创建轮次，sourceCallId 对应产生变更的工具调用 callId。相同目标文字可能属于不同版本，应以 ID 区分。

内容：
{{data}}
