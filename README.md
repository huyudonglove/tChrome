# tChrome

**面向网页任务的 AI 执行助手：用户交代目标，Agent 根据页面反馈决定下一步，浏览器执行操作，本机账本记录过程。**

tChrome 运行在 Chrome 侧边栏。它不要求用户预先画好流程，而是围绕一份持续更新的任务工作单，边观察网页、边选择工具，直到完成、需要用户补充信息、用户停止或执行出错。

## 与普通工作流的区别

普通工作流提前编排执行路径，tChrome 在执行中根据反馈形成路径。区别不是有没有接入 AI，而是谁决定下一步。

| | 预编排工作流 | tChrome |
|---|---|---|
| 事先定义 | 步骤、顺序和分支 | 目标、规则和可用工具 |
| 下一步由谁决定 | 流程图与条件判断 | 模型根据页面和工具结果判断 |
| 适合的任务 | 固定、重复、规则明确的业务 | 目标明确、具体网页操作路径不确定的任务 |
| 主要取舍 | 可预测性强，成本容易控制 | 更灵活，但可能绕路或误判 |

例如“查清这款商品的官网价格”：固定工作流需要配置网站、定位和取值步骤；tChrome 可以查看搜索结果、判断型号、进入相关页面，信息不足时询问用户。这是使用场景示例，不是对任意网站完成率的保证。

## 核心设计

### 结构化任务工作单

上下文不是不断追加的聊天记录。系统按栏目装配规则、网页 Skill、用户输入、目标、当前页面、笔记、记忆和工具结果，生成一份 system 消息与一份 user 消息。

用户每次输入开启一个 Turn；一个 Turn 内可以多次请求模型、执行工具。工具循环沿用当轮装配配置，并更新执行结果及相关状态。

### 模型判断，Runtime 管理执行

当前由一个 Agent 统一处理聊天和网页任务，没有固定的 Planner / Task 多角色流水线。

模型选择下一步；Runtime 负责工具队列、状态更新、落盘、停止及错误处理。一次模型回复可以提交多个工具调用，Runtime 按顺序执行并记录结果。

### 页面与工具按需展开

核心网页工具支持读取摘要、查找区域、列出交互元素、查看细节、点击和输入。已有足够信息时可以直接使用目标工具，不要求每次走完固定观察流程。

初始加载核心网页工具和发现入口。`list_browser_tools` 返回尚未加载的动态工具名称，包含浏览器、网络和本地工具；`catalog.add` 加载所选工具，下一次模型请求才收到完整说明和 schema。

本地 `local.*` 工具支持文件读写、目录搜索、复制移动删除、命令执行、后台进程管理与系统打开。命令使用绝对工作目录，默认30秒超时、最长300秒；进程按会话隔离，停止或删除会话会终止对应进程组。`execute_javascript` 通过 Chrome Debugger 在页面主环境执行，支持 Promise 和结构化结果，断线或超时不自动重放。

截图图片单独保存在会话目录的 `images/` 中，工具和模型日志只记录引用。发送模型请求时再读取图片并构造 `image_url`，每次最多携带本轮未归档记录中最近4张图片。当前支持工具截图输入，侧栏尚无上传或粘贴图片入口。

`#currentPage` 表示本轮最新已知页面；`#pageObservedHistory` 按旧到新记录本轮工具返回的页面观察，两者都不是实时页面监控。

常驻 `context.query(module, tag, question?)` 将主题交给查询 Agent 语义匹配本会话对应模块目录，由 runtime 校验内部 ID、沿来源关系读取原文并去重，按原顺序返回。主 Agent 无需提供记录 ID。只检索已压缩归档；支持多条或 not_found，单次原文内容上限 30,000 字符，超过时返回 partial 和遗漏数量，不截断单条原文。请缩小主题或问题后再查；单条原文本身超过上限时也会明确返回 partial。查询不会刷新页面。

### 执行记录与记忆

本机保存会话账本、每轮状态、模型请求与回复、工具参数和返回结果。模型通过 `notes.write` 维护草稿、候选和中间材料，通过 `memory.write` 保存两层记忆：

- `conversationMemory`：本会话值得保留的过程事实、偏好和决定，跨轮保留，删除会话时删除。
- `projectMemory`：独立于会话的长期记忆，所有会话共享读取，删除来源会话后仍保留。

原 `turnMemory` 已合并至会话记忆，旧数据自动迁移。当前目标由 `goal` 管理，草稿与中间材料由 `notes` 管理，值得保留的事实与决定写入 `conversationMemory`。

每次发送主模型前，Runtime 检测 System + User 文本长度；达到 200,000 字符时，分别调用独立 LLM 压缩请求处理 userInputHistory、pageObservedHistory、conversationMemory 和 toolIO。前三个模块保留最近 3 条原文，toolIO 保留最近 2 个调用批次。压缩只改变窗口覆盖关系，账本和本地完整原文保持不变。各层连续摘要累计达到 20,000 字符后生成更高层摘要，旧摘要与来源关联继续保留。 每个模块在 LLM 输出校验成功、完整来源与摘要落盘后，才原子更新目录索引。失败或取消不推进该模块覆盖关系，原文继续可用；同一轮中此前成功提交的其他模块可以保留。索引是提交点，中断可能留下未被索引引用的文件。

## 架构

```text
Chrome Side Panel（React + TypeScript）
              │ 用户输入 / 会话展示 / 停止
              ▼
本机 Bun 服务（127.0.0.1:18788）
  Runtime ── Prompt / Context ── Provider ── UUAPI
      │                           Chat Completions + JSON
      │ 工具请求与结果
      ▼
Chrome Background Worker ── 浏览器工具 ── 网页
```

- 扩展只请求本机服务，不直接连接模型服务。
- 模型密钥保存在本机服务配置中。
- 后台 worker 拉取并执行浏览器任务；关闭侧栏不等于停止任务。

## 快速开始

### 环境

- [Bun](https://bun.sh/)（项目使用 Bun 安装依赖、运行服务、测试和构建）
- Chrome 135 或更新版本
- 可用的 UUAPI API Key

当前默认模型为 `gemini-3.8-flash`，接口为 `https://uuapi.net/v1`，通过官方 OpenAI SDK 调用 Chat Completions。

### 1. 获取代码与安装依赖

```bash
git clone git@github.com:huyudonglove/tChrome.git
cd tChrome
bun install
```

### 2. 配置模型服务

在 `service/` 下创建 `.env` 文件，填写：

```dotenv
UUAPI_API_KEY=your_api_key
UUAPI_REASONING_EFFORT=high
```

推理强度默认 `high`，支持 `low`、`medium`、`high`，通过请求字段 `reasoning_effort` 发送。上游是否实际采用取决于模型和网关支持。

首次启动默认直连。需要代理时，在同一文件中配置实际可用的代理地址，例如：

```dotenv
HTTPS_PROXY=http://127.0.0.1:7892
```

代理地址本身不会自动开启代理；在侧栏打开代理开关即可，关闭即直连。选择保存在本地，服务重启后恢复；没有保存设置时也可通过 `TCHROME_PROXY_MODE=proxy` 显式启用。修改服务配置后需要重启服务。`.env` 已被 Git 忽略。

也可选择 ShiningSpace 的 Responses API（`grok-4.6`），在 `service/.env` 配置：

```dotenv
TCHROME_PROVIDER=shiningspace
SHININGSPACE_API_KEY=your_api_key
SHININGSPACE_REASONING_EFFORT=high
```

其接口为 `https://ai.shiningspace.com:8090/v1/responses`，支持工具与图片请求。会话列表右下角的设置中可切换 provider，从下一次模型请求起生效并保存到 `connection.json`；两套密钥独立保留。`TCHROME_PROVIDER` 仅决定尚未保存选择时的默认值。

### 3. 构建扩展并启动服务

在项目根目录执行：

```bash
bun run build
bun run service
```

服务启动后保持终端运行。本机健康检查地址：<http://127.0.0.1:18788/health>。健康检查只表示本机服务可访问，不代表模型调用成功。

### 4. 加载 Chrome 扩展

1. 打开 `chrome://extensions`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择本项目的 `dist/` 目录。
4. 点击 tChrome 扩展图标打开侧栏，输入任务。

修改扩展代码后，重新运行 `bun run build`，并在扩展管理页重新加载 tChrome。修改服务代码后，重启 `bun run service`。

## 开发命令

| 命令 | 用途 |
|---|---|
| `bun install` | 安装依赖 |
| `bun run service` | 启动本机服务 |
| `bun run build` | 构建 Chrome 扩展到 `dist/` |
| `bun run test` | 运行自动化测试 |
| `bun run check` | 运行测试及扩展构建，不包含独立 TypeScript 类型检查 |

自动化测试覆盖 Agent 循环、工具参数解析、Provider 重试、会话展示、浏览器工具、停止行为、来源隔离及 Markdown 渲染安全。测试通过不等于真实模型和任意网页端到端任务均已通过。

## 目录

```text
service/                  本机服务，按职责组织
  runtime/                循环、账本、持久化、证据归档与浏览器桥
  skills/                 独立 Skill 目录、启用清单与加载器
  memory/                 两层记忆读写、迁移与窗口投影
  compression/            独立 LLM 压缩、归档目录与语义查询
  images/                 截图文件存储、引用校验与模型图片输入
  context/                模块描述、规则加载与文本组装
    system/               固定规则与常驻工具插槽
    user/                 请求、状态、记忆与动态工具插槽
    system-slots.md       system 编号文件名加载顺序
    user-slots.md         user 编号文件名加载顺序
    README.md             维护入口，不进入模型窗口
  tools/                  工具注册、校验与服务端执行
    definitions/          schema、groups.json 分组与 index.json 分类
  provider/               模型通信、重试与响应解析
  presentation/           会话消息与列表的纯展示投影
extension/                Chrome 宿主
  background.ts           接收服务请求并调度浏览器工具
  tools/                  依赖 Chrome API 的宿主执行器及测试
  sidepanel/              面板入口
  ui/                     通用组件和样式
docs/                     数据协议与阶段示例
scripts/                  构建与示例同步
```

运行数据默认保存在：

```text
~/Library/Application Support/tChrome/
```

其中 `conversations/<会话ID>/` 保存会话账本、事件日志、`provider.md` 模型交互记录、Turn、会话记忆、分模块压缩目录及工具完整返回；`memory/project/` 独立保存共享长期记忆。

## 安全与当前边界

- 这是调用远程模型的本地执行助手，不是完全离线系统。装配进模型上下文的用户输入、页面信息和工具结果会发送到模型服务。
- 扩展申请网页访问、调试器、Cookie、下载及剪贴板等权限，用于对应浏览器工具。使用前应理解这些权限的范围。
- 本机服务默认仅监听回环地址，并拒绝外部网页来源和跨站请求。默认允许 Chrome 扩展来源；可在 `service/.env` 设置 `TCHROME_EXTENSION_ORIGIN=chrome-extension://<扩展 ID>`，只允许指定扩展来源。
- 来源隔离不等于本机进程身份认证，本机程序仍可直接访问服务。
- 本地执行记录可能包含页面和用户输入中的敏感信息，分享日志前应检查并脱敏。
- 当前是单 Agent 实现。已有执行记录不等于已实现可靠的任意断点续跑；长任务完成率、成本优势和复杂网页适应性仍需实际验证。

## 文档

- [字段与接口协议](docs/schema.md)
- [数据存储与执行循环](docs/data.md)
- [分阶段数据示例](docs/examples/01-normalize.md)
- [服务说明](service/README.md)
- [扩展说明](extension/README.md)

Provider 负责模型通信、重试和响应解析。所有接入返回均由 `service/runtime/loop.ts` 的 `validateCompletion` 统一调用 `service/tools/schema.ts`，按当前工具 schema 检查参数、工具名和收口工具顺序，再由运行循环推进状态。工具定义保存在 `service/tools/definitions/`，由同模块的 `registry.ts` 读取，Context 仅接收工具说明并装配窗口。`presentation/` 的纯函数负责会话展示，存储层读取数据后调用投影，保留持久化和命令职责。

运行提示独立维护在 `service/runtime/messages.json`，由运行层按需写入工具记录。

目录先按运行端划分，再按职责划分：`service/context/`、`service/tools/`、`service/skills/` 和 `service/memory/` 都是本机服务能力，正文和定义与其实现放在同一模块；`extension/tools/` 仅负责依赖 Chrome API 的宿主执行，由服务注册表发现并经浏览器桥调度。

上下文保留 system / user 分层。两份目录只列编号文件名；system 模块使用 tag、能力和详细描述格式；user 模块另设内容段。system 先输出 `service/context/overview.md` 总纲，串联规则、材料、判断与行动，再输出 System 栏目清单，每项 tag --能力后直接跟详细正文（含 baseTools 工具说明），再输出 User 栏目清单，每项能力后直接跟详细描述；user 保留十六个 tag 的内容段和数据。Skill 正文独立维护于 `service/skills/<name>/SKILL.md`，Runtime 根据 `service/skills/index.json` 每轮加载后注入 `#skill`；context 中只保留模块说明和占位符。
