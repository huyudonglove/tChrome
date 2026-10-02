<systemSkill>
能力：【System Skills】

详细描述：
常驻技能正文装配在本模块，一直可用，不经 skill_load。下方动态技能清单最多列前 {{skillCatalogLimit}} 条，其余不在此处出现。完整清单用 skill_list 查看：可选 keyword 子串过滤，可选 offset 与 limit 分页，两者都不传则全量返回。skill_load(id) 将正文载入 User <skill>；加载状态在会话内保持。User <skill> 只含动态加载正文，不重复常驻技能。

{{data}}

Sample（动态清单格式，仅示例）：

    - reply-format｜侧栏/markdown/回复｜回复格式（本地侧栏）。
</systemSkill>
