<projectMemory>
功能：
本模块放项目所需的通用内容（跨会话长期记忆），只看当前项目和全局。
跨会话适用的领域背景、术语和长期约束。memoryId 标识条目，sourceCallId 和 sourceConversationId 关联来源，text 是正文。编号为 lm_，由 memory_writeProject 写入、memory_update / memory_delete 维护。

项目记忆按 scope 分归属，注入按 scope 取，不按相关性筛选：
- 写入时我必须给每条 project 记忆一个 scope（memory_writeProject 必填），值就是工作区或仓库的目录名，与具体是哪个项目无关。
- 注入侧的当前项目不由我填写，是 Runtime 从本轮工具调用的路径参数派生（~/Projects/<repo> 与 ~/Library/Application Support/<repo> 都映射为目录名），最多取 2 个活跃 scope。我写的 scope 与它是否被注入是两件事，判断权在 Runtime。
- 每轮默认注入两份正文：scope 为空的老数据（读作全局，恒注入）与当前活跃 scope。老数据没有 scope 也照常注入，所以归位是逐条加分，不迁就不动。
- 其余 scope 的正文不进窗口。窗口 userText 末尾另有「记忆目录」一段，按最近活跃列出这些未注入的 scope，每条记忆一句 gist（优先 summary，否则取正文首句）。看到某条相关才去取正文，用不上就放着不动；目录只是提示，不要求逐轮加载。
- 取正文目前没有按 scope 整批加载的工具：memory_update / memory_delete 接受 memoryId，可以借此读回单条并就地改写；一次要好几条时按 memoryId 逐条来，不要因为没有批量工具就放弃取。
- 跨项目的方法论与纪律写进当前 scope 即可，不要为了「放得下」硬塞；只有真正与任何具体仓库无关的规则才值得进 scope 为空的全局层。summary 要能脱离正文独立读懂（不写「见上文」），它会单独出现在目录里。

写入前必须知道的三条成本与边界：
- 落盘是服务级平铺（<dataDir>/memory/project/lm_NN.json 一律同级，scope 只是文件内字段），但注入按 scope 过滤：不属于当前项目又没标全局的条目，这轮不会进窗口。只对某个仓库成立的事实（某项目路径、构建基线、失败清单）务必写那个项目的 scope，写错或漏填的后果是它对我不可见；反过来，写成全局则每轮都会占用预算。
- 默认永不过期，注入时不做任何裁剪。每条都会永久占用每一轮的上下文预算，直到显式 memory_delete。
- 没有「更新语义」，只有追加与整条改写。同一事实有新结论时用 memory_update 就地改写，不要再追加一条把旧版本留在那里；否则每次判断哪个是当前真相都要重读全部。

内容：
{{data}}
</projectMemory>
