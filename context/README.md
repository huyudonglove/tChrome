# 上下文目录（维护者入口）

本文件面向人，不加载到模型窗口。模型导航与唯一模块顺序来源是 [System 栏目清单](system-slots.md) 和 [User 栏目清单](user-slots.md)。加载器按清单编号行顺序读取同名模块；调整顺序只改清单，编号须从 1 连续递增。清单与目录必须一一对应，缺失、重复或未列出的模块会报错。

## 模块、功能与归属

下表是维护入口，不参与排序或装配。栏目功能以两份清单为准。

| 模块 | 功能 | 归属 | 文件 |
| --- | --- | --- | --- |
| `#baseTools` | 提供常驻基础工具的用途、参数、返回与状态变化。 | system：固定规则；baseTools 注入常驻工具说明 | [baseTools.md](system/baseTools.md) |
| `#environment` | 说明运行环境与可用能力。 | system：固定规则；baseTools 注入常驻工具说明 | [environment.md](system/environment.md) |
| `#execution` | 定义任务推进、结果判断、错误处理、授权、等待用户与结束任务的通用执行规则。 | system：固定规则；baseTools 注入常驻工具说明 | [execution.md](system/execution.md) |
| `#identity` | 说明助手身份与职责范围。 | system：固定规则；baseTools 注入常驻工具说明 | [identity.md](system/identity.md) |
| `#output` | 定义过程说明、最终答复和追问的表达格式。 | system：固定规则；baseTools 注入常驻工具说明 | [output.md](system/output.md) |
| `#contextSummary` | 汇总目标、进展、阻碍与下一步。 | user：运行时参考数据；skill 注入网页方法 | [contextSummary.md](user/contextSummary.md) |
| `#conversationMemory` | 保留会话事实、偏好与决定。 | user：运行时参考数据；skill 注入网页方法 | [conversationMemory.md](user/conversationMemory.md) |
| `#currentPage` | 提供最近观察的页面信息，判断操作对象与页面状态。 | user：运行时参考数据；skill 注入网页方法 | [currentPage.md](user/currentPage.md) |
| `#currentTab` | 确定用户发话时的起始标签。 | user：运行时参考数据；skill 注入网页方法 | [currentTab.md](user/currentTab.md) |
| `#goal` | 明确当前工作目标，判断进展与完成情况。 | user：运行时参考数据；skill 注入网页方法 | [goal.md](user/goal.md) |
| `#goalHistory` | 记录旧目标，帮助理解方向变化。 | user：运行时参考数据；skill 注入网页方法 | [goalHistory.md](user/goalHistory.md) |
| `#notes` | 维护工作清单、候选项和中间数据。 | user：运行时参考数据；skill 注入网页方法 | [notes.md](user/notes.md) |
| `#observation` | 提供历史执行摘要与详细证据回查入口。 | user：运行时参考数据；skill 注入网页方法 | [observation.md](user/observation.md) |
| `#projectMemory` | 提供项目背景、术语与长期约束。 | user：运行时参考数据；skill 注入网页方法 | [projectMemory.md](user/projectMemory.md) |
| `#skill` | 提供网页操作方法与注意事项。 | user：运行时参考数据；skill 注入网页方法 | [skill.md](user/skill.md) |
| `#toolIO` | 提供工具调用、返回与错误，判断实际执行结果。 | user：运行时参考数据；skill 注入网页方法 | [toolIO.md](user/toolIO.md) |
| `#tools` | 提供当前已加载动态工具的用法。 | user：运行时参考数据；skill 注入网页方法 | [tools.md](user/tools.md) |
| `#turnMemory` | 保留阶段进展、临时发现与待处理事项。 | user：运行时参考数据；skill 注入网页方法 | [turnMemory.md](user/turnMemory.md) |
| `#userInput` | 明确本轮用户请求。 | user：运行时参考数据；skill 注入网页方法 | [userInput.md](user/userInput.md) |
| `#userInputHistory` | 提供历史用户请求，帮助理解指代与条件变化。 | user：运行时参考数据；skill 注入网页方法 | [userInputHistory.md](user/userInputHistory.md) |

## 配置与装配职责

| 入口 | 功能 | 归属 |
| --- | --- | --- |
| [skills/skill.web.md](skills/skill.web.md) | 网页操作方法，进入 user `#skill` | 上下文方法 |
| [tools/groups.json](../tools/groups.json) | `baseToolsIds` 常驻基础工具、`coreToolIds` 初始动态工具 | 工具加载分组 |
| [tools/index.json](../tools/index.json) | browser / service 分类，供发现可加载工具 | 工具目录 |
| [tools/](../tools/) | 每个 JSON 保存完整 schema；function.description 是唯一工具说明来源 | 工具 API |
| [modules.ts](../service/context/modules.ts) | 读取清单、模块和 skill；按清单渲染 | 上下文加载层 |
| [registry.ts](../service/tools/registry.ts) | 读取根目录 tools/ 的定义、分类和分组，生成工具说明 | 工具层 |
| [window.ts](../service/context/window.ts) | 纯投影数据并拼装 system / user；两份清单原文仅放 system 一次 | 窗口层 |
| [messages.json](../service/runtime/messages.json) | 空回复、未调用结束工具时的运行提示；按需进入 toolIO | 运行层 |

工具 API 名称 `catalog.add` 与 `list_browser_tools` 保持不变。新增工具时同时维护定义、发现分类与必要的加载分组。运行提示不属于工具配置，也不在加载器内硬编码。

说明分工：两份清单只解释栏目功能；user 模块只放材料；execution 放通用执行、授权与证据规则；output 统一表达格式及 `reason` 写法；网页方法放在 skill；各工具用法放在 `function.description`。工具参数 `reason.description` 只引用 `#output`，工具注册表原样返回工具定义，不再追加另一份写作要求。

修改后运行 `bun run scripts/sync-context-examples.ts`，用当前加载器和窗口装配函数同步阶段示例中的窗口与工具定义，再运行 `bun run check` 验证。同步脚本不调用模型、浏览器或运行中的服务。

工具 API 定义位于仓库根 `tools/`；本目录只维护窗口正文、栏目顺序与 skill。工具注册表提供 schema 和说明，Context 不读取工具目录、不执行工具，也不维护执行状态。

记忆展示每层取最近 8 条。超过窗口阈值时，turn / conversation 优先展示 summary，无摘要时使用归一空白后的前 80 字；project 不做摘要压缩。投影不修改磁盘记忆、memoryIds 或 toolIds。旧 toolIO 的 observation 归档由 Runtime 完成，UI 消息展示由 `service/presentation/` 完成。
