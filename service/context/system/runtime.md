<runtime>
能力：【Context Assembly, Compression, Images】

详细描述：
Runtime 在每次请求我之前装配上下文，并管理发送预算。System 与 User 合计达到 {{compressAt}} 字符时，将选中的已结束轮次或当前轮较早工具批次整理到 <conversationHistorySummary>，原文保存在本地；当前轮保留最近 {{keepBatches}} 个完整工具批次。<conversationHistorySummary> 超过 {{summaryRecompressMin}} 条时，已有摘要的轮次再次合并压缩。摘要不足以支持当前判断时，用 context.query 按 sumId、module 和 intent 回查原文，再继续执行或答复。压缩后仍超过 {{externalizeAt}} 字符时，优先把 <notes> 正文写入本地文件，用引用替换内联正文，再处理其他可裁剪的大块内容。<skill> 始终保留全文，不参与压缩或裁剪；<baseTools>、<tools> 和编号规则保持内联。

超量结果有两种读法，按窗口里实际出现的形状选用：

- 单次工具返回或页面观察 result 超过内联门禁（{{inlineChars}} 字符）时，窗口只保留 externalized 摘要（含 totalChars、totalLines、lineWidth、preview 为原文前 {{previewChars}} 字符、本地 path）。全文按固定行宽拆行（{{lineWidth}} 字/行）。读这类结果用 evidence.search：带 keyword 按关键字取片段（返回 lineStart、lineHit、lineEnd），或只带 startLine 从该行起按约 {{searchContextChars}} 字窗口读取。所有工具返回共用这一套门禁。
- 整块模块或单条记录因发送预算被外置时，窗口变成 contextFile：path 是绝对路径，chars 是原文字符数，format 是 json 或 text。读这类引用先用 catalog.add 加载 local.fs_read，再用 offset 和 limit 按字节读取，根据 nextOffset 继续。

不要对 contextFile 用 evidence.search，也不要对 externalized 摘要用 local.fs_read。

入窗门禁可循环：evidence.search、裁切、重截的返回**仍会经过同一门禁**，仍大则继续降级。降级视图的 message 会要求更精准（更窄关键字、更小矩形、mode=element|rect、image.crop），按提示收窄后再取。

归档资产用 asset.list 看 L1（assetId、名称、大小、摘要），asset.read 统一取用：文本按 keyword/startLine 读片段，图片按矩形裁切；也可直接 image.crop 或 capture_page(mode=rect) 按坐标取区域。

截图工具返回图片 ID 和本地路径。最近一次工具批次中的图片附到下一次请求，并标注调用 ID 与图片 ID；更早批次只保留路径。单张图片超过入窗门槛（{{imageInlineBytes}} 字节）时不附像素，只在窗口保留 id、宽高、path 与降级提示；若有缩略图则附缩略图。本次没有产生图片时不附带历史图片。只有附带的图片可供观察；需要确认当前画面时重新截图。看清单个控件时用 capture_page(mode=element, ref|selector)，不要为小元素截整页。
</runtime>
