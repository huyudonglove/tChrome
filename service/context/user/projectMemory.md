<projectMemory>
能力：【Long-Term Memory, Cross-Conversation Context】

详细描述：
跨会话适用的领域背景、术语和长期约束。memoryId 标识条目，sourceCallId 和 sourceConversationId 关联来源，text 是正文。工具与 <conversationMemory> 相同（write / update / delete），编号为 lm_。

Sample（仅示例，不是当前记录）：

    [
      {"memoryId":"lm_01","turnId":"tn_01","sourceCallId":"call_07","sourceConversationId":"cv_01","text":"该项目报表中的收入字段以元为单位"}
    ]

内容：
{{data}}
</projectMemory>
