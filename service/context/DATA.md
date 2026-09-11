# User 数据清单

`data-schema.json` 汇总模型可见的 15 个插槽结构；修改投影时同步更新它。`../identity/catalog.json` 统一维护 ID 字段、前缀及编号范围。Schema 的 ID 定义引用由此生成的 `tchrome:identity`；使用 `data-schema.ts` 的 validateUserData 校验，不重复维护前缀正则。模块提示词解释含义，本清单约束数据结构，不注入提示词。

验证对象使用不带 `#` 的模块名。`skill`、`tools` 保留文本，其余插槽取 JSON 解析后的值；全部模块必须存在，空数组用 `[]`，空对象槽按下表处理。它不是带 Markdown 标签的完整 User 文本，也不是磁盘存储格式。

| 模块 | 数据结构 | 身份字段 |
| --- | --- | --- |
| `skill` | 字符串 | 无 |
| `userInput` | `{id, turnId, userInput}` | `id` |
| `conversationHistorySummary` | `[{sumId, turnId, tag, userRequest, actions, result}]` | `sumId` |
| `userInputHistory` | 用户输入记录数组 | `id` |
| `goal` | `{id, turnId, sourceCallId?, goal}` 或 `null` | `id` |
| `goalHistory` | 目标记录数组 | `id` |
| `currentPage` | `{id?, turnId?, callId?, tab, url, title, description}` 或 `null` | 有观察来源时带 `id` |
| `pageObservedHistory` | 页面观察数组，`id / turnId / callId` 必填 | `id` |
| `projectMemory` | `[{memoryId, turnId, sourceCallId?, sourceConversationId?, text}]` | `memoryId`（`lm_`） |
| `conversationMemory` | 同上 | `memoryId`（`mm_`） |
| `notes` | 字符串键值对象，空值为 `{}` | 键名 |
| `toolIO` | `[{callId, turnId, batchId?, name, arguments, return}]` | `callId` |
| `queryHistory` | 查询记录数组 | `queryId` |
| `currentQuery` | 查询记录或 `null` | `queryId` |
| `tools` | 字符串 | 工具名 |

查询记录统一为 `{queryId, turnId, sumId, module, intent, status, records, sourceCallId?, nextCursor?, detail?}`。`records` 直接保存原模块记录，不新增通用 `id`，不加 `content` 包装；身份字段沿用原记录。查询自身的 `turnId` 与结果记录的 `turnId` 分别表示发起轮次和来源轮次。`status` 为 `complete / partial / not_found / error`。

工具投影的 `return` 为 `{stage, result}`；查询原始工具记录时也允许 `{stage, totalChars, text}`。工具参数、解析后的结果和图片对象属于工具协议，不限制其内部业务 ID。查询原记录允许已有时间和来源字段；查询记录可包含历史查询记录、带 turnId 的最终输出，以及指定摘要的各层来源摘要。超长原记录以身份字段和 fragment:{offset,totalChars,text} 返回；text 是原记录 JSON 的连续字符片段，通过 nextCursor 续页，按 offset 拼接可恢复原文。单次 records 的紧凑 JSON 最多 2000 字符。

Schema 检查字段类型、必填项、ID 格式及已知记录结构，拒绝未声明的顶层模块和记录字段。编号至少两位，前缀来自 ID 清单。Schema 不检查编号唯一性、自增状态、引用是否存在或查询是否命中，也不实现查询链路及 2000 字符门禁；这些由 Runtime 验证。
