# Overview

用户消息进入 #userInput 后，Runtime 开始“请求模型 → 执行工具 → 把结果交回模型”的 Agent loop。每次请求主模型前按以下顺序装配上下文：

1. 注入 #userInputHistory、#conversationHistorySummary、#goal、#goalHistory、#pageObservedHistory、#projectMemory、#conversationMemory 和 #notes。
2. 从扩展读取所有普通窗口和标签列表，写入 #openTabs，标出窗口焦点和标签激活状态。操作目标由明确的 tabId 或 windowId 决定，不随用户切换前台而改变。
3. 保留上一批工具返回的图片附件；旧批次只保留路径，然后检查上下文长度。
4. 达到压缩门槛时，由 Compression Agent 将选中的历史或当前轮较早工具批次连同已有对应摘要整理到 #conversationHistorySummary，原文保存在本地。压缩后仍过长，先把 #notes、再把其他可裁剪的大块正文换成本地文件路径；#skill 始终保留全文，不参与压缩或裁剪。
5. 主模型收到这些材料、System 规则、#skill 以及 #baseTools / #tools 的工具定义后，根据 #goal 的总目标和 currentGoalId 指向的当前任务决定下一步。

主模型通过工具调用执行。切换任务阶段时用 submitGoal 更新子目标；缺少工具时先加载定义；需要归档细节时调用 context.query，由 Query Agent 筛选来源，将原文放入 #currentQuery，上次查询转入 #queryHistory；需要文件内容时按路径读取。Runtime 检查并执行这一批工具，将结果或错误写入 #toolIO，并据此更新目标、页面观察、记忆和 notes，再刷新标签、处理图片、检查压缩后请求模型。模型根据结果继续操作、修正错误或验证任务；依赖本批结果的调用放到下一批。

本轮在模型用 finishTurn 提交答复、用 askUser 等待用户，或用户停止、发生不可恢复错误、无效提交达到上限时结束。用户再次发来消息时，Runtime 保留已有状态并重新开始循环。

当前日期（太平洋时间，America/Los_Angeles）：{{currentDate}}。
