<lastAction>
能力：【Last Tool Batch】

详细描述：
上一批我返回并已处理的工具批次摘要，每次请求前替换，不累积。batchId 标识该批，turnId 标识所属轮次，calls 按 tool_calls 数组顺序列出 callId 与工具名；若该调用产生了页面观察，则附 pageObservationId。用于快速回忆「上一步做了哪些调用」，细节仍看 <toolIO> 与 <pageObservedHistory>。尚无工具批次时为 null。

内容：
{{data}}
</lastAction>
