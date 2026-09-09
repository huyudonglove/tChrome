# 上下文模块

本模块保留 system / user 分层。目录文件只决定加载顺序；能力导航由模块元数据生成，详细规则和工作材料来自模块正文。

| 入口 | 职责 |
|---|---|
| [system-slots.md](system-slots.md) | 仅编号文件名，例如 `1. identity`；对应 system/ 中的文件 |
| [user-slots.md](user-slots.md) | 仅编号文件名；对应 user/ 中的文件 |
| [system/](system/) | identity、environment、execution、toolProtocol、boundaries、output、baseTools 七个规则模块 |
| [user/](user/) | 保留原有十五个 tag，提供网页方法和本轮材料 |
| [modules.ts](modules.ts) | 校验顺序与模块格式，读取 tag、能力、详细描述和内容，生成两份导航 |
| [window.ts](window.ts) | 拼装 system / user，并注入当轮数据与工具说明 |

system 模块文件使用以下结构：

```text
#identity
能力：【说明本模块解决什么问题】
详细描述：
具体规则或材料正文。
```

user 模块在详细描述后增加内容段：

```text
#userInput
能力：【当前请求，任务入口】
详细描述：
说明这一栏的含义和使用边界，加载后进入 system 的 User 清单。

内容：
{{data}}
```

user/skill.md 同样拆分：用途和边界说明进入 system，具体网页操作方法保留在内容段并随 #skill 进入 user。system 模块文件格式保持不变，渲染时正文与能力合并到同一清单项。

目录中的名字是不含 .md 的文件名，不携带能力描述。编号从 1 连续递增，必须与目录文件一一对应。模块 tag、能力和正文只在模块文件维护，避免能力描述重复维护。

加载结果包含 systemOrder / userOrder，以及保存模块元数据与正文的 systemSlots / userSlots。systemInventory 和 userInventory 从顺序和能力元数据生成。最终 system 先输出 `# System 栏目清单`，每项 tag --能力之后直接跟该模块的详细正文，baseTools 注入常驻工具说明；再输出 `# User 栏目清单`，每项 tag --能力之后直接跟详细描述。system 正文已经合并在对应清单项内，不再额外拼接一份；user 仅保留 tag 与内容段。

execution 专注任务推进；toolProtocol 负责调用、返回和错误处理协议；boundaries 负责授权、来源与证据边界。网页方法直接写在 [user/skill.md](user/skill.md)，随 #skill 渲染；没有独立 skills 目录或 ContextModules.skill 字段。

工具 schema 和说明仍由 [服务工具定义](../tools/definitions/) 提供，常驻说明进入 #baseTools，动态说明进入 #tools。输出协议、工具调用参数和三层记忆行为保持原有设计。

修改后运行 `bun run scripts/sync-context-examples.ts`，同步阶段示例中的导航、正文与 7/15 栏目数组。脚本只刷新真正的 schema，保留实际 tool_calls 的参数数据；再次运行结果应相同。然后运行 `bun run check`。

历史类数据（用户输入、目标历史、三层记忆、工具记录、观察摘要）按旧到新排列，新增记录追加末尾；最近窗口从尾部选取后仍保持原顺序。contextSummary 中历史事实和已完成进展数组遵守同样约定，由模型在提交整个汇总时维护；runtime 不对任意汇总数组猜测排序。待办和工具队列按执行顺序，选项与排名保留其业务含义。
