#turnMemory
用途与来源：阶段进展、临时发现和待处理事项。需要恢复工作步骤时读取；有必要保留阶段进展时，用 memory.write.turnMemory 追加。当前实现可能保留此前 Turn 的记录，先判断是否仍适用。
三类 memory 都是追加记录，各槽最多显示最近 8 条；不要重复写入所有模块。仅保存后续确需的事实并注明适用范围。新 conversation 不继承记忆。conversationMemory / turnMemory 压缩后展示 summary，projectMemory 保持原文。

{{data}}
