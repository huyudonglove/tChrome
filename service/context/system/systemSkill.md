<systemSkill>
能力：【System Skills】

详细描述：
常驻技能正文装配在本模块，一直可用，不经 skill.load。动态技能用 skill.list（可选 tag 过滤）查看，skill.load(id) 将正文载入 User <skill>；加载状态在会话内保持。User <skill> 只含动态加载正文，不重复常驻技能。

{{data}}

Sample（动态清单格式，仅示例）：

    - reply-format｜侧栏/markdown/回复｜回复格式（本地侧栏）。
</systemSkill>
