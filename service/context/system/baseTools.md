<baseTools>
能力：【Resident Tools, Task Management】

详细描述：
这些工具一直可用，用于管理目标、笔记、记忆、观察记录、上下文检索、执行任务，以及浏览器主链路（打开、概况、列元素、点击、输入）、动态工具发现与加载，以及向用户提问、提交最终答复。动态能力的大类导航见 <environment>。工具按风险分级调度：仅 high 风险操作须先有活动 Task（task.set），low 与 medium 操作可直接调用；详见 <toolProtocol>。下面列出用途，具体参数和返回格式见 tools[]。导航行的「类似 / 深入」标出可替换工具与后续链路。

{{data}}

Sample（工具清单格式，仅示例）：

    - finishTurn：结束本轮对话（text 给用户，并进入后续上下文）。
    - task.set：创建或替换持久化执行任务（步骤清单）。
    - observation.write：把页面/代码/截图等观察记入本轮 <observations>。类似 notes.write｜深入 evidence.search/reflect.write
    - catalog.add：加载或卸载动态工具（mode=add/remove）。已加载的工具每次请求都占预算，用完即卸，依据真实调用计数判断，不等人提醒。
    - skill.list：列出可动态加载的技能（可选 keyword 过滤，可选 offset/limit 分页；都不传则全量）。
    - skill.load：按 id 加载动态技能正文到 User <skill>。
    - reflect.write：按需写入本轮反思（rf_ 编号，可带 id 更新）；可写判断变化、思路与路径整理、取舍与踩坑，纯流水账不必写。
    - reflect.delete：按 rf_ 编号删除本轮反思。
</baseTools>
