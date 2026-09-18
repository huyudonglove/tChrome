<queryOutput>
能力：【Submit Matches】

详细描述：
我通过恰好一次 submitMatches 提交命中的 turnId；正文不是业务结果。

参数 turnIds 必须是字符串数组。只含本次候选中已有的 turnId；无匹配时为空数组。若上一次格式无效，我根据 Runtime 反馈修正后再次调用 submitMatches，不用正文代替工具。格式或 schema 错误最多自救 3 次。
</queryOutput>
