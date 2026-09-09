# 工具定义

本目录独立于 `context/`，保存工具 API 的唯一 schema 和说明来源。

- `<工具名>.json`：工具名称、`function.description`、参数 schema。
- `index.json`：动态工具的 browser / service 分类。
- `groups.json`：常驻工具和初始动态工具分组。

`service/tools/registry.ts` 读取定义并提供 schema 与说明；上下文只接收说明文本。`service/tools/schema.ts` 校验调用，Runtime 对所有模型响应统一执行校验后调度。服务端执行在 `service/tools/`，Chrome 执行在 `extension/tools/`。工具返回结构化结果与 effects，`service/runtime/effects.ts` 统一应用状态和持久化。

新增工具时维护定义、分类和必要的分组，并在对应执行端实现。修改说明后运行 `bun run scripts/sync-context-examples.ts` 更新示例，再运行 `bun run check`。
