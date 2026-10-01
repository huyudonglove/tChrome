<projectMemory>
能力：【Long-Term Memory, Cross-Conversation Context】

详细描述：
跨会话适用的领域背景、术语和长期约束。memoryId 标识条目，sourceCallId 和 sourceConversationId 关联来源，text 是正文。编号为 lm_，由 memory.writeProject 写入、memory.update / memory.delete 维护。

项目记忆按 scope 分归属，注入按 scope 取，不按相关性筛选：
- 每条 project 记忆都带一个 scope（写 memory.writeProject 时必填）。scope 就是项目目录名（tChrome、silver-hero 等），由 Runtime 从本轮工具调用的路径参数派生，不需要你声明。
- 每轮默认注入两份正文：scope 为空的老数据（读作全局，恒注入）与当前活跃 scope。老数据没有 scope 也照常注入，所以归位是逐条加分，不迁就不动。
- 其余 scope 的正文不进窗口。窗口里另有「记忆目录」一段，按最近活跃列出这些未注入的 scope，每条记忆只给一句 summary（没写 summary 时取正文首句）。看到目录里某条相关，才用对应方式把它的正文读进来；用不上就放着不动。目录只是提示，不要求逐轮加载。
- 跨项目的方法论与纪律写进当前 scope 即可，不要为了「放得下」硬塞；只有真正与任何具体仓库无关的规则才值得跨项目复用。summary 要能脱离正文独立读懂（不写「见上文」），它会单独出现在目录里。

写入前必须知道的三条成本与边界：
- 共享范围是服务级，不是按项目隔离。所有会话共享同一份 project 记忆，与当前操作的是哪个代码仓库无关。只对某个仓库成立的事实（某项目路径、某项目构建基线、某项目失败清单）不该写进这里。
- 默认永不过期，注入时不做任何裁剪。每条都会永久占用每一轮的上下文预算，直到显式 memory.delete。
- 没有「更新语义」，只有追加与整条改写。同一事实有新结论时用 memory.update 就地改写，不要再追加一条把旧版本留在那里；否则每次判断哪个是当前真相都要重读全部。

内容：
{{data}}
</projectMemory>
