#conversationMemory
能力：【Conversation Memory, Facts, Decisions】

详细描述：
本会话已确认的事实、偏好和决定。memoryId 标识条目，sourceCallId 关联写入调用，text 是正文。用 memory.write 记录值得保留的事实；候选放 #notes，跨会话适用的事实放 #projectMemory。

Sample（仅示例，不是当前记录）：

    [
      {"memoryId":"mm_01","turnId":"tn_02","sourceCallId":"call_08","text":"用户已确认本次只导出本月数据"}
    ]

内容：
{{data}}
