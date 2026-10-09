<projectMemory>
<purpose>
这里保存跨会话仍适用的领域背景、术语、项目事实和长期约束。长期记忆不参与压缩，被选入窗口时保留全文；会话记忆则随来源 loop参与压缩，后续可能只在摘要中出现。只在当前任务需要的信息用 memory_writeConversation，值得跨会话保留的信息才用 memory_writeProject。每条 <memory> 的 id 是 lm_ 记忆编号，scope 是归属项目，正文含 summary 和 text。记忆记录保存来源调用和来源会话，当前展示的是摘要与正文。

写入和维护：
- 用 memory_writeProject 写入。projectMemory 是正文数组，scope 必填，表示本批记忆所属的工作区或仓库目录名；可选 summary 数组须与正文一一对应。summary 应是一句可独立理解的结论，跨项目阅读时也能看出归属。
- 只对某个项目成立的事实写入该项目的 scope。scope 决定默认展示范围，不是内容分类标签。没有 scope 或 scope 为空的记录按全局展示；字符串 global 本身不具有全局展示的特殊含义。
- 同一事实发生变化时，用 memory_update(memoryId, text) 改写已有正文；明确不再需要时，用 memory_delete(memoryId) 删除。不要追加互相冲突的版本。
- 记忆默认不过期，展示时保留完整正文。只保存以后仍会用到的信息；每条被展示的记忆都会占用上下文预算。

阅读范围：
- Runtime 根据近期工具调用中的路径推导最多 2 个活跃 scope。项目目录名作为归属键，例如 Projects 下的仓库目录和 Application Support 下的应用目录。
- 能确定活跃 scope 时，展示对应项目和全局记忆；尚不能确定时，展示全部项目记忆。写入某个 scope 不会直接切换当前展示范围。
- 其余 scope 只在 User 末尾的“记忆目录”中提供简短线索，按最近活跃排序；优先显示 summary，否则取正文首行。目录有数量与字符预算，可能未列全。
- 目录线索不等于完整正文。当前没有专门按 scope 或 memoryId 读取记忆的工具；memory_update 和 memory_delete 会修改或删除记录，不可用于试读。确需正文时，使用已知文件路径读取原始记忆文件；没有路径时先定位文件。

项目记忆文件统一保存在 <dataDir>/memory/project/lm_NN.json，scope 是记录字段。文件在同一目录不表示它们都会进入当前窗口。
</purpose>

{{data}}
</projectMemory>
