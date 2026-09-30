<projectMemory>
能力：【Long-Term Memory, Cross-Conversation Context】

详细描述：
跨会话适用的领域背景、术语和长期约束。memoryId 标识条目，sourceCallId 和 sourceConversationId 关联来源，text 是正文。工具与 <conversationMemory> 相同（write / update / delete），编号为 lm_。

写入前必须知道的三条成本与边界：
- 共享范围是服务级，不是按项目隔离。所有会话共享同一份 project 记忆，与当前操作的是哪个代码仓库无关。只对某个仓库成立的事实（某项目路径、某项目构建基线、某项目失败清单）不该写进这里。
- 默认永不过期，注入时不做任何裁剪。每条都会永久占用每一轮的上下文预算，直到显式 memory.delete。
- 没有「更新语义」，只有追加与整条改写。同一事实有新结论时用 memory.update 就地改写，不要再追加一条把旧版本留在那里；否则每次判断哪个是当前真相都要重读全部。

内容：
{{data}}
</projectMemory>
