#currentQuery
能力：【当前查询，历史原文】

详细描述：
最近一次查询结果，null 表示暂无查询。queryId 标识查询，sumId 指向来源摘要，module 和 intent 是查询条件；records 保留原模块记录及其 ID。

status 为 complete、partial、not_found 或 error，分别表示所选记录已全部返回、部分返回、未匹配或失败。单次 records 最多 2000 字符；fragment 的 offset、totalChars、text 表示原记录 JSON 的连续片段。partial 时保持原查询参数，将 nextCursor 作为 cursor 续读，不自行构造游标。部分结果只支持已返回的证据；未找到不证明事实不存在。

内容：
{{data}}
