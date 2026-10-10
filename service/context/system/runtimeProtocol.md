<runtimeProtocol>
<purpose>
Runtime 负责选择图片、计算窗口大小、压缩历史和外置大结果；记录编号也由 Runtime 分配。这里说明运行提醒、取证入口与记录编号这类稳定规则；各 loop 的 runtime type=notice 提供当次状态。外置与图片门槛见 <resultEnvelope>，上下文预算与压缩见 <contextBudget>。

运行状态提醒：

- Runtime 把每次调用的结果与调用一起保存，保留至所属 loop 压缩。原始调用始终完整落盘。工具结果只保留入窗门禁处理后的内容，不另建正文副本。
- 重复调用提醒指出等价调用、相同返回或重复错误。核对上次是否已生效及已有证据，只补影响下一步决定的缺口。
- observation 提醒出现时，若跨步骤状态尚未保存，记录当前进度、未验证项和继续位置；已有 callsResult 执行事实直接复用。reflect 提醒用于判断变化和方案取舍。
- 只读计数在 {{readOnlyPrompt}} 次和 {{readOnlySecond}} 次提示，最后通牒后到 {{readOnlyHard}} 次会中断本轮。记账调用不增加或清零计数；local_run 也保持中性，明确写入等实质性操作清零。确需继续调查时用 checkContinue(cont=true) 显式确认并清零，之后重新累计；cont=false 结束本轮，不提交最终答复。

需要补充证据时，按来源选工具：

- 要核对历史约定、某轮的判断依据或摘要省略的细节，用 agent_query，传 sumId、module、intent。
- 只关心某个文件时，可加 file：loops、runtime、helm 按调用与结果中的明确文件字段匹配，summaries 按正文提及匹配。没有匹配记录时直接返回 not_found，不调用查询模型。
- 要读取某次工具返回或页面观察中的原文片段，用 evidence_search。windows 中每项选择 callId 或 pageId，不能同时指定两者。
- 要继续读取分页结果，用原工具的分页参数：skill_list 使用 offset/limit；local_fs_read 的 items 中使用 offset/limit 按字节读，或 startLine/endLine 按行读。
- 要读取归档资产，已知 assetId 时直接 asset_read；需要定位资产时用 asset_list 查 assetId、名称、大小和摘要。文本用 blockId 读目录或完整原文块，或用 keyword 搜索、offset 继续搜索；图片用 x、y、width、height 裁切。

引用记录时，复制材料或工具返回中已经出现的 ID。[硬] 不要猜测下一个编号，也不要用编号推算记录总数。

自有记录通常采用“类型前缀_数字”，数字至少两位，按各自范围递增；已分配的编号不复用，中间可能跳号。不同类型或范围的编号不能比较先后。ID 格式因会话而异（受版本与归档方式影响），不要借鉴其他会话或其他记录类型中见到的 ID 格式。页面、窗口和外部业务 ID 按对应工具定义使用。

loop ID 标识一次主模型交互，runtime 和 helm ID 标识其中输入与响应。callId 关联工具调用和执行结果；task ID 关联未完成状态、更新指针与最终结果；摘要 loopIds 指向实际来源交互。查询返回的记录 ID 属于历史来源，不表示本次重新执行。

下面是各类记录的编号规则：
</purpose>

{{data}}
</runtimeProtocol>
