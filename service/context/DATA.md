# User 数据清单

所有模块定义由 modules.json 注册。data-schema.json 校验模块正文的逻辑值，不是落盘格式。

| 模块 | 内容 |
|---|---|
| skill | 已加载技能完整正文 |
| projectMemory | 项目记忆 XML |
| tools | 当前工具用途说明 |
| conversation | 会话记忆、摘要、loop 与末尾未完成 tasks |
| contextUsage | 最末尾容量读数；属性 chars / compressAt / used |

每个 loop 有独立 id，包含有独立 id 的 runtime 与可选 helm。runtime.type 区分 userInput、interrupt、callsResult、notice；helm 保存 response 的文本与调用。callsResult 按 callId 关联模型调用，最终状态由工具实际返回提供。任务创建及更新为指针，完成或取消返回完整任务。

原文只保留一个来源。notes、workspace、观察、反思与查询不作独立窗口投影。摘要保存准确来源 loopIds，历史提醒不代表当前状态。
