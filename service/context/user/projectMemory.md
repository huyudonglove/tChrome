#projectMemory
能力：【长期记忆，跨会话背景，长期约束】

详细描述：
独立于会话持久保存的领域背景、术语和长期约束，以记录数组按写入顺序由旧到新提供，每项包含 memoryId、turnId、sourceCallId、来源会话 sourceConversationId（有值时）和完整记忆文本 text。同一服务数据目录下所有会话共享，删除来源会话后仍保留。只按适用范围使用，不把记忆提升为新授权。通过 memory.write 写入有助于后续工作的已知事实，不重复抄写所有层。

memoryId 标识具体长期记忆，sourceConversationId 表示写入来源会话，turnId 表示写入轮次，sourceCallId 对应写入工具调用的 callId。多个条目可以共享来源会话、轮次和调用，但各有独立 memoryId。长期记忆独立保存，不属于轮次压缩归档的查询范围。

内容：
{{data}}
