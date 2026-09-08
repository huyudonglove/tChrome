#projectMemory
用途与来源：项目背景、术语和长期约束。理解任务背景时读取；确认了后续仍有用的背景信息后，用 memory.write.projectMemory 追加。当前实现只在本会话保存，不会自动跨会话共享。
三类 memory 都是追加记录，各栏目最多显示最近 8 条；不要重复写入所有栏目。仅保存后续确需的事实并注明适用范围。新 conversation 不继承记忆。conversationMemory / turnMemory 压缩后展示 summary，projectMemory 保持原文。

{{data}}
