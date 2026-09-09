# 上下文模块

本模块保留 system / user 分层。目录文件只决定加载顺序；能力导航由模块元数据生成，详细规则和工作材料来自模块正文。

| 入口 | 职责 |
|---|---|
| [system-slots.md](system-slots.md) | 仅编号文件名，例如 `1. identity`；对应 system/ 中的文件 |
| [user-slots.md](user-slots.md) | 仅编号文件名；对应 user/ 中的文件 |
| [system/](system/) | identity、environment、execution、toolProtocol、boundaries、output、baseTools 七个规则模块 |
| [user/](user/) | 保留原有十五个 tag，提供网页方法和本轮材料 |
| [modules.ts](modules.ts) | 校验顺序与模块格式，读取 tag / capability / body，生成两份导航 |
| [window.ts](window.ts) | 拼装 system / user，并注入当轮数据与工具说明 |

模块文件使用以下结构：

```text
#identity
能力：【说明本模块解决什么问题】
详细描述：
具体规则或材料正文。
```

目录中的名字是不含 .md 的文件名，不携带能力描述。编号从 1 连续递增，必须与目录文件一一对应。模块 tag、能力和正文只在模块文件维护，避免能力描述重复维护。

加载结果包含 systemOrder / userOrder，以及值为 `{tag, capability, body}` 的 systemSlots / userSlots。systemInventory 和 userInventory 从顺序和能力元数据生成。最终 system 依次包含 `# System 栏目清单`、`# User 栏目清单`、详细 system 正文；user 保留 tag 和详细描述/数据，不重复能力标签。

execution 专注任务推进；toolProtocol 负责调用、返回和错误处理协议；boundaries 负责授权、来源与证据边界。网页方法直接写在 [user/skill.md](user/skill.md)，随 #skill 渲染；没有独立 skills 目录或 ContextModules.skill 字段。

工具 schema 和说明仍由 [服务工具定义](../tools/definitions/) 提供，常驻说明进入 #baseTools，动态说明进入 #tools。输出协议、工具调用参数和三层记忆行为保持原有设计。

修改后运行 `bun run scripts/sync-context-examples.ts`，同步阶段示例中的导航、正文与 7/15 栏目数组。脚本只刷新真正的 schema，保留实际 tool_calls 的参数数据；再次运行结果应相同。然后运行 `bun run check`。
