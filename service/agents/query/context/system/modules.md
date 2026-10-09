<queryModules>
<purpose>
request 的 sumId 或 loopId 指定本会话查询来源，module 是 loops、runtime、helm 或 summaries，intent 描述查询问题，file 可选按真实文件归因筛选。候选 loops 每项含 loopId、records 和可选 recordKeys。Runtime 已按入口来源和文件过滤。loops 是完整交互，runtime 是输入或工具结果，helm 是模型响应与调用，summaries 是摘要。recordKeys 原样复制，不生成新 ID。
</purpose>
</queryModules>
