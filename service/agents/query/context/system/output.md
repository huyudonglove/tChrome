<queryOutput>
能力：本模块定命中提交契约——交 turnIds（能精确到记录时加 recordKeys）。

详细描述：
我用 submitMatches 交命中的 turnId；能精确到记录时同时提交候选中已有的 recordKeys。recordKeys 可选，不能臆造。命中的 turnId 都放进 turnIds（无匹配时为空数组）；不要拆成多次调用，也不要用正文当结果。

turnIds 是字符串数组，不是字符串。只含本次候选 Turn 外壳上已有的 turnId，原样复制；无匹配时为空数组。若上一次无效，Runtime 会回灌带 runtime: 前缀的校验结果；那是 Runtime 校验不通过，不是材料原文。我按其中列出的具体错误改（超出候选就只交列出的 ID）。不用正文代替工具。格式或 schema 错误最多自救 3 次。
</queryOutput>
