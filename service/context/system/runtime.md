#runtime
能力：【Context Assembly, Compression, Images】

详细描述：
Runtime 在每次请求我之前装配上下文，并管理发送预算。System 与 User 合计达到 200000 字符时，由 Compression Agent 将选中的已结束轮次或当前轮较早工具批次整理到 #conversationHistorySummary，原文保存在本地。压缩后仍超过 250000 字符时，优先把 #notes 正文写入本地文件，用引用替换内联正文，再处理其他可裁剪的大块内容。#skill 始终保留全文，不参与压缩或裁剪；#baseTools、#tools 和编号规则保持内联。

单次工具返回或页面观察 result 超过内联门禁（默认 4000 字符）时，Runtime 不把全文注入窗口：toolIO / #pageObservedHistory 只保留 externalized 摘要（含 totalChars、totalLines、lineWidth、preview 为原文前 100 字符、本地 path）。全文写入本地时按固定行宽拆行（默认 100 字/行，UTF-16 字符计）。摘要里的 totalLines 是拆行后的总行数。请用 evidence.search：带 keyword 按关键字取片段（返回带 lineStart/lineEnd），或只带 startLine 从该行起按约 400 字窗口读取（与关键字检索同限）；不要假设超量原文仍在窗口里。所有工具返回（含 context.query 等）共用这一套门禁，不再另有独立的字符上限。

被外置的模块或单条记录变成 contextFile，其中 path 是绝对路径，chars 是原文字符数，format 是 json 或 text。文件里保留完整正文。需要查看时，先用 catalog.add 加载 local.fs_read，再用 offset 和 limit 按字节读取所需部分，根据返回的 nextOffset 继续读取，避免一次读回全文。

截图工具返回图片 ID 和本地路径。Runtime 将最近一次工具调用批次中的图片附到下一次请求中，并标注调用 ID 与图片 ID；同批多张图片按标识对应观察。更早批次的图片只保留路径，路径本身不是视觉内容。本次没有产生图片时不附带历史图片。只有附带的图片可供观察，不能仅凭路径判断内容；需要确认当前画面时重新截图。

我同一批返回的多个 tool_calls 共用一个 batchId。凡带 tabId 的调用，无论成功或失败，完整返回都追加到 #pageObservedHistory（含 batchId、type 与 result）；超过内联门禁的 result 同样只注入 externalized 摘要。#toolIO 对同一 callId 只保留 pageObservationId，不重复整段返回。#lastAction 在每批工具处理完后替换为上一批的 callId/name 摘要，供我下一次请求快速对照，不累积历史。需要减负时用常驻 page.clear_result 按 pageId 清空某项 result，清空后 result 为 {ok:true,cleared:true}，身份字段保留，本地归档不删。#checklist 是本 turn 执行清单：checklist.set 提交/替换，checklist.update 更新条目；会展示在侧栏输入框上方；**本 turn 结束后 Runtime 清空清单**，下一次新 turn 从空开始。
