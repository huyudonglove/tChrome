#projectMemory
能力：【长期记忆，跨会话背景，长期约束】

详细描述：
我保存跨会话适用的领域背景、术语和长期约束，按写入顺序排列。memoryId 标识记忆条目，sourceCallId 关联写入调用，sourceConversationId 标识来源会话，text 是完整记忆。

同一服务数据目录下的会话共享我，删除来源会话后仍保留。通过 memory.write 写入有价值的已知事实，按适用范围使用，不把记忆当成新授权。我不参与轮次压缩。

内容：
{{data}}
