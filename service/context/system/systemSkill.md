<systemSkill>
<purpose>
常驻技能正文在下面，直接按需使用，不必调用 skill_load。

动态技能目录最多展示前 {{skillCatalogLimit}} 条。需要查找其他技能时调用 skill_list：keyword 过滤名称或用途，offset/limit 分页；不传分页参数则返回全量。

找到合适的动态技能后，用 skill_load(id) 加载。正文随后出现在 User 的 <skill> 中；加载状态在会话内保持。<skill> 不重复常驻技能正文。
</purpose>

{{data}}
</systemSkill>
