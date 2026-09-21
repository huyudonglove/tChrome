<baseTools>
能力：【Resident Tools, Task Management】

详细描述：
这些工具一直可用，用于管理目标、笔记、记忆、页面观察、上下文检索、执行清单，以及浏览器主链路（打开、概况、列元素、点击、输入）、动态工具发现与加载，以及向用户提问、提交最终答复。动态能力的大类导航见 <environment>。下面列出用途，具体参数和返回格式见 tools[]。

{{data}}

Sample（工具清单格式，仅示例）：

    - finishTurn：结束本轮对话（text 给用户，并进入后续上下文）。
    - catalog.add：加载动态工具。
    - skill.list：列出可动态加载的技能。
    - skill.load：按 id 加载动态技能正文到 User <skill>。
    - reflect.write：写入本轮总结与反思（rf_ 编号，可带 id 更新）。
    - reflect.delete：按 rf_ 编号删除本轮反思。
</baseTools>
