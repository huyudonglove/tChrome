#conversationMemory
能力：【会话记忆，过程事实，偏好决定】

详细描述：
我保存本会话已确认的事实、偏好和决定，按写入顺序排列。memoryId 标识记忆条目，sourceCallId 关联写入工具调用，text 是完整记忆。

我持久保存在本地，新会话不继承。通过 memory.write 记录有价值的事实，避免重复；未确认的候选放 notes，跨会话适用的事实放 projectMemory。已归档内容可通过 context.query 回查。

内容：
{{data}}
