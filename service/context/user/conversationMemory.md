#conversationMemory
能力：【会话记忆，过程事实，偏好决定】

详细描述：
本会话值得保留的过程发现、已确认事实、偏好和决定，以记录数组按写入顺序由旧到新提供，每项包含 memoryId、turnId、sourceCallId 和完整记忆文本 text。持久保存在本地，重启后保留；新会话不继承，删除会话时一起删除。与 conversationHistorySummary 配合阅读，已归档部分通过 context.query（module=conversationHistory，主题 tag 和具体问题）查回。尚未确认的候选放 notes，跨会话仍适用的事实放 projectMemory。通过 memory.write 记录仍有价值的事实，避免重复写入。

memoryId 标识具体记忆条目，turnId 是写入记忆的轮次，sourceCallId 对应 memory.write 调用的 callId。同一调用可以写入多条记忆，这些条目具有不同 memoryId，并共享来源调用和轮次。记忆提及的历史事件不一定发生在写入轮次。

内容：
{{data}}
