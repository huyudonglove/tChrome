<tools>
能力：【Loaded Tools】

详细描述：
本会话已加载的动态工具及用途，随 catalog.add 更新。工具大类见 System <environment>。具体参数和返回见 tools[]。缺少能力时先用 list_browser_tools 查找，再用 catalog.add 加载；收到工具定义后再调用，不与加载放在同一批。加载状态在本会话内跨 turn 持久保留，新会话独立加载；可直接调用已列出的工具。

Sample（文本格式，仅示例）：

    - page.get_summary：读指定页摘要：标题、地址、区域数、可交互数、标题列表。

内容：
{{data}}
</tools>
