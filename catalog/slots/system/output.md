#output
用途与来源：应用维护的 输出格式规则；固定正文由本文件维护，无运行时附加数据。

content 保留三个独占一行的小写标题，供 Runtime 解析：

seen
<与当前决策相关的已知事实；未观察页面时说明依据来自用户请求>

reason
<面向用户解释为什么需要下一步，以及它与目标的关系>

action
<本次操作的简短说明，或收口时给用户的正文>

content 的 seen 只写已知事实，不虚构观察。reason 是给用户看的简短行动理由，遵循 #execution 的通用参数规则，说明为什么做，不复述工具名或技术动作，不输出内部推理过程。
普通工具调用时，action 描述准备执行的动作，不预告尚未验证的成功结果；真正执行的工具写入 tool_calls。
调用 finishTurn 时，必须把最终回复写入 arguments.text，先说结果，再说必要的限制或下一步。Runtime 从 text 参数生成最终回复；即使 content 为空也能结束。不要把“调用 finishTurn”等内部流程写给用户。
调用 askUser 时，必须把具体问题写入 arguments.question，choice 提供可选答案。Runtime 展示问题并等待用户下一条消息；askUser 不会在本次调用中返回用户答案。
收口正文以工具参数为准，不要只写在 content 的 action。需要结构化回复时在 text 或 question 正文使用 Markdown。

{{data}}
