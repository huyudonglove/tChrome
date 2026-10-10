<resultEnvelope>
<purpose>
工具结果与页面观察超过门槛时只保留正文存放位置，需要时再取回。这里说明外置大结果与图片附带的门槛；取证入口见 <runtimeProtocol>，压缩阈值见 <contextBudget>。

读到 externalized 结果时，当前窗口里是块目录和路径，不是完整原文。它表示原文已保存，不等于工具截断；若工具本身返回 truncated、budgetNote 等缺失提示，索引只能保存该次实际返回的内容。只取回下一步所需的证据：

externalized 只说明正文存放方式，工具是否成功仍看原始 ok、faultCode、error 等字段；没有 ok 时不推定成功。批量返回中的 results 保留各项状态和失败原因，逐项检查。externalizationHint 是读取正文的提示，与工具原始 message 分开。

- 单次工具返回或页面观察 result 超过 {{inlineChars}} 字符时会外置。完整原文保持原样保存，结果带 totalChars、本地 path、rootBlockId 和 directory。
- 所有内容使用同一种块索引。代码优先按语法结构划分，结构化数据按字段或条目划分，普通文本按段落、行递归划分；过大的结构继续拆成子块。目录提供块 ID、标题、大小和来源位置。
- evidence_search 的 windows 每次最多 8 项，返回 results[]。每项必须选择 callId 或 pageId；不传 blockId/keyword 时读根目录，传 blockId 读取对应块，传 keyword 搜索原文。blockId 与 keyword 不能同时提供。
- kind=directory 是子块目录，kind=content 是该块完整原文，kind=search 是命中片段及块 ID。需要完整实现时，用命中的 blockId 取回原文；目录或片段足以回答定位问题时，可以继续下一步，不把它们当作完整代码。
- 搜索返回 nextOffset 时，如仍缺所需证据，用相同来源和 keyword 加 offset 继续取下一页。每个窗口均有结果；读取原文块不会截短正文，也不再次外置。asset_read 的文本使用相同规则。
- 索引对应当次返回的原文快照。块 ID 只在该来源内使用，来源位置用于理解上下文，无需换算行号。修改当前文件时注意快照与当前文件是否一致。
- 页面观察、代码执行、截图等新产出仍经过入窗门禁。外置文本按块导航或用关键词定位后取回完整原文；图片则缩小区域，并遵循下方的图片门槛。

调用记录的 runtimeHints 是运行时提醒，imagesError 是图片解析或保存失败的原因；它们与工具 return 分开呈现。工具执行成功并不表示图片处理成功。

需要看图时，先确认这次请求确实附带了图片：

- Runtime 先选最近一次模型返回的工具批次中的图片，再判断上下文压缩与外置。同批图片随下一次请求发送，并标注调用 ID、图片 ID；更早批次只保留路径。本批没有图片时，不附带历史图片。
- 图片超过 {{imageInlineBytes}} 字节时不附原图像素，保留 id、宽高、path 和提示；有缩略图时附缩略图。只有实际附带的图片可供观察。
- 要确认当前画面，重新截图。看单个控件用 capture_page 的 mode=element，按 ref 或 selector 定位；看局部用 mode=rect，或 image_crop 裁切已有图片。
</purpose>
</resultEnvelope>
