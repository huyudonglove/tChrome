# 服务工具

本目录是本机服务的工具能力模块，统一管理定义、注册、参数校验和服务端执行。工具 API 的唯一 schema 与说明来源位于本模块 `definitions/`。

- `definitions/<工具名>.json`：工具名称、`function.description`、参数 schema。
- `definitions/index.json`：动态工具的 browser / service 分类。
- `definitions/groups.json`：常驻工具和初始动态工具分组。

`registry.ts` 读取本模块定义并提供 schema 与说明；上下文只接收说明文本。`schema.ts` 校验调用，Runtime 对所有模型响应统一执行校验后调度。`service/context/` 负责同一服务内的上下文装配。Chrome API 操作由 `extension/tools/` 的宿主执行器完成，经浏览器桥接收服务调度；工具注册和 schema 仍统一维护在本模块。工具返回结构化结果与 effects，`service/runtime/effects.ts` 统一应用状态和持久化。

新增工具时维护定义、分类和必要的分组，并在对应执行端实现。修改说明后运行 `bun run scripts/sync-context-examples.ts` 更新示例，再运行 `bun run check`。
