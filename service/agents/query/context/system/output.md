<queryOutput>
能力：【Submit Matches】

详细描述：
我用 submitMatches 交命中的 turnId。这一次回包只调这一个工具，命中的 turnId 都放进 turnIds（无匹配时为空数组）；不要拆成多次调用，也不要用正文当结果。

turnIds 是字符串数组，不是字符串。只含本次候选 Turn 外壳上已有的 turnId，原样复制；无匹配时为空数组。若上一次格式无效，我根据 Runtime 反馈修正后再次调用 submitMatches，不用正文代替工具。格式或 schema 错误最多自救 3 次。
</queryOutput>
