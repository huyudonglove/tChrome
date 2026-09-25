<activeContext>
能力：【Active Context Spine】

详细描述：
单屏因果脊椎：把当前 Goal、正在做的 TaskItem、主操作标签、关键实体与承接意图合成一份紧凑视图，打通目标 / 计划 / 环境 / 笔记 / 意图之间的断层。
Runtime 装配期纯计算生成，不新增工具、不改账本。字段：goalId 为 currentGoalId；activeTaskItem 取 doing，否则第一个 todo；focus.primaryTabId 优先取最近两批工具与观察中高频 tabId，否则聚焦窗口的活动标签；activeEntities 来自 notes（JSON 展开，跳过多行/超长草稿）；handoverIntent 取 <reflectHistory> 最近一条末项 text，没有历史时回退当前步骤 text。
以本模块快速对齐“现在卡在哪、主战场是哪个页、有哪些关键变量”，细节仍回看 goal / task / notes / reflection。

内容：
{{data}}
</activeContext>
