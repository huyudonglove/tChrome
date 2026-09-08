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

缺少能力时，Agent 可以查找工具目录并增量装载工具。

历史记录支持渐进式读取：`record.inspect` 查看长度与结构，`record.search` 按字面搜索定位，`record.read` 按字符范围精读。部分返回提供范围、`hasMore` 和 `nextOffset`，可连续读取；需要全文时使用 `tool.detail` / `observation.detail`。这些读取结果不再被统一截断，且只读取已存记录，不刷新网页。

### 执行记录与记忆

本机保存会话账本、每轮状态、模型请求与回复、工具参数和返回结果。模型可以写入工作笔记及 turn / conversation / project 三层记忆；当前 project 记忆仍按会话保存，并非跨会话共享。

上下文达到 200,000 字符阈值时触发压缩处理，较早工具记录和记忆转为摘要，详细结果可以回查。

## 架构

```text
Chrome Side Panel（React + TypeScript）
              │ 用户输入 / 会话展示 / 停止
              ▼
本机 Bun 服务（127.0.0.1:18788）
  Runtime ── Prompt / Context ── Provider ── UUAPI
      │                           Chat Completions + SSE
      │ 工具请求与结果
      ▼
Chrome Background Worker ── 浏览器工具 ── 网页
```

- 扩展只请求本机服务，不直接连接模型服务。
- 模型密钥保存在本机服务配置中。
- 后台 worker 拉取并执行浏览器任务；关闭侧栏不等于停止任务。
- `subagent/` 是预留目录，当前未接入子 Agent。

## 快速开始

### 环境

- [Bun](https://bun.sh/)（项目使用 Bun 安装依赖、运行服务、测试和构建）
- Chrome 135 或更新版本
- 可用的 UUAPI API Key

当前默认模型为 `gemini-3.7-flash`，接口为 `https://uuapi.net/v1`，通过官方 OpenAI SDK 调用 Chat Completions。

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
```

需要代理时，在同一文件中配置实际可用的代理地址，例如：

```dotenv
HTTPS_PROXY=http://127.0.0.1:7892
```

仅在该代理确实运行时使用此配置。修改服务配置后需要重启服务。`.env` 已被 Git 忽略。

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
extension/          Chrome 侧栏、后台 worker、浏览器工具
service/
  runtime/          Agent 循环、账本、存储、压缩和浏览器桥
  prompt/           读取 catalog、装配提示词
  context/          上下文窗口
  tools/            参数处理、schema 校验和工具执行
  provider/         UUAPI 模型接入
  subagent/         预留
catalog/
  packs/            Agent 固定规则
  skills/           网页能力与操作方法
  tools/            工具定义
  assemble.json     装配配置
  window.system.md  system 模板
  window.user.md    user 模板
docs/               数据协议和分阶段示例
scripts/            扩展构建脚本
```

运行数据默认保存在：

```text
~/Library/Application Support/tChrome/
```

其中包含会话账本、事件日志、`provider.md` 模型交互记录、Turn、记忆、观察摘要及工具完整返回。

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
