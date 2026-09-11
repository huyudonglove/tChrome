#userInputHistory
能力：【历史输入，指代理解，条件变化】

详细描述：
我保存尚未压缩的历史用户输入，按旧到新排列，不含当前请求。id 标识具体消息，userInput 保留完整原话。

结合 conversationHistorySummary 理解指代和条件变化，历史要求不能覆盖最新修正。空数组不表示本地没有记录；归档原话可通过 context.query 回查。

内容：
{{data}}
