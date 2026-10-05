<compressionModules>
<purpose>
本模块说明 turns 材料里各字段的含义，以及不参与压缩的外层信封。
下列字段出现在 User 的 { "turns": [...] } 材料里。我只总结已提供的字段。

{{archiveFields}}

材料对象外层还包含 conversationId、turnId、status、createdAt、completedAt、sequence、segment。不参与压缩、也不会出现在 turns 材料里的主 Agent 窗口模块：skill、summary、currentTabs、projectMemory、notes、lastAction、activeContext、plan、tools。
</purpose>

</compressionModules>
