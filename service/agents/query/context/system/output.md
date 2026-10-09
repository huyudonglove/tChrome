<queryOutput>
<purpose>
在一次回复中只调用一次 submitMatches，提交所有选择。不要用普通正文代替工具调用。

- loopIds：必填字符串数组，从候选 loops 的 loopId 原样复制；无匹配时提交空数组。
- recordKeys：可选字符串数组，从候选已有的 recordKeys 原样复制。填写后，Runtime 只返回同时属于所选 loopIds 且命中这些 key 的记录；因此应包含所有需要返回的记录。

收到带 runtime: 前缀的校验错误时，按错误修正后重新提交完整选择。这是 Runtime 的反馈，不是历史材料。格式或 schema 校验最多尝试 3 次，包含首次提交。
</purpose>
</queryOutput>
