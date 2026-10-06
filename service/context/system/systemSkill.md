<systemSkill>
<purpose>
常驻技能正文在下面，直接按需使用，不必调用 skill_load。

动态技能用于补充任务方法。当前信息和工具足以推进时直接执行；需要方法且目录中没有合适技能时，再调用 skill_list：keyword 过滤名称或用途，offset/limit 分页；不传分页参数则返回全量。目录最多展示前 {{skillCatalogLimit}} 条。

已知合适的动态技能 ID 时，直接用 skill_load(id) 加载，无需先查目录。正文随后出现在 User 的 <skill> 中；加载状态在会话内保持。<skill> 不重复常驻技能正文。
</purpose>

{{data}}
</systemSkill>
