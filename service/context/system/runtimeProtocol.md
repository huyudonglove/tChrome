<runtimeProtocol>
<purpose>
Runtime 负责选择图片、计算窗口大小、压缩历史和外置大结果。这里说明稳定规则；各 loop 的 runtime type=notice 提供当次状态与提醒。

运行状态提醒：

- Runtime 在执行时解析 keepInCalls，并把最终值与实际工具结果一起保存。true 的调用和结果保留至所属 loop 压缩；false 的调用和结果仅在结果返回后的下一次请求展示一次。原始调用始终完整落盘。工具结果只保留入窗门禁处理后的内容，不另建 notes 或 workspace 正文副本。
- 重复调用提醒指出等价调用、相同返回或重复错误。核对上次是否已生效及已有证据，只补影响下一步决定的缺口。
- observation 提醒出现时，若跨步骤状态尚未保存，记录当前进度、未验证项和继续位置；已有 callsResult 执行事实直接复用。reflect 提醒用于判断变化和方案取舍。
- 只读计数在 {{readOnlyPrompt}} 次和 {{readOnlySecond}} 次提示，最后通牒后到 {{readOnlyHard}} 次会中断本轮。记账调用不增加或清零计数；local_run 也保持中性，明确写入等实质性操作清零。确需继续调查时用 checkContinue(cont=true) 显式确认并清零，之后重新累计；cont=false 结束本轮，不提交最终答复。

需要补充证据时，按来源选工具：

- 要核对历史约定、某轮的判断依据或摘要省略的细节，用 agent_query，传 sumId、module、intent。context_query 提供相同的查询能力。
- 只关心某个文件时，可加 file：loops、runtime、helm 按调用与结果中的明确文件字段匹配，summaries 按正文提及匹配。没有匹配记录时直接返回 not_found，不调用查询模型。
- 要读取某次工具返回或页面观察中的原文片段，用 evidence_search。windows 中每项选择 callId 或 pageId，不能同时指定两者。
- 要继续读取分页结果，用原工具的分页参数：skill_list 使用 offset/limit；local_fs_read 的 items 中使用 offset/limit 按字节读，或 startLine/endLine 按行读。
- 要读取归档资产，已知 assetId 时直接 asset_read；需要定位资产时用 asset_list 查 assetId、名称、大小和摘要。文本用 blockId 读目录或完整原文块，或用 keyword 搜索、offset 继续搜索；图片用 x、y、width、height 裁切。

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

上下文接近预算时，按以下规则安排工作：

- System 与 User 合计达到 {{compressAt}} 字符时，Runtime 自动压缩。最近 1 个 loop 完整保留，其余按历史顺序处理；单个 loop 始终不拆。
- 候选优先按 userInput 或 interrupt 分区。没有输入分界时，按 loop 条数分为前后两半，分别一次发送、一次返回；只有一条直接处理，不递归拆分。每批摘要明确记录来源 loopIds，全部合法才覆盖对应原文；失败保留该批及后续原文并停止后续批次。网络重试仍属于同一次逻辑请求。
- 未覆盖 loop 生成 L1 摘要，各层超过 {{summaryFoldMin}} 条才折叠，最高 L6；合并后仍保留准确的来源 loopIds 和来源摘要 ID。没有新来源时不单独重压已有摘要，也不显示压缩活动。
- 原始 loop 始终落盘可回溯。长任务历史记录占主要预算时，可调用 agent_compress。压缩会重建缓存前缀；正常追加不回写历史 loop。
- 压缩后仍超过 {{hardLimitChars}} 字符时，本轮以 context_limit 失败，不再通过裁剪标签或外置内容继续缩减窗口。
- <skill> 始终保留完整正文，不参与压缩、裁剪或文件外置。<baseTools>、<tools> 和编号规则保持内联。
</purpose>

</runtimeProtocol>
