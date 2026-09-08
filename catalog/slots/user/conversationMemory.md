#conversationMemory
用途与来源：本会话已确认的事实、用户偏好和决定。延续任务或判断约束时读取；有值得保留的新事实时，用 memory.write.conversationMemory 追加。用户修正事实时记录修正，不把旧记录当成当前要求。
三类 memory 都是追加记录，各槽最多显示最近 8 条；不要重复写入所有模块。仅保存后续确需的事实并注明适用范围。新 conversation 不继承记忆。conversationMemory / turnMemory 压缩后展示 summary，projectMemory 保持原文。

{{data}}
