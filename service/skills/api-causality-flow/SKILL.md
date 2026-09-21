TAGS:
- http
- api
- 网络
- 签名
- 下载
# 接口请求与异步任务处理 (API & Async Tasks)

前端数据与状态通常由网络接口驱动。自动化操作结合接口返回做等待与取证，比纯 UI 延时更稳定。`page.submit_wait`、`page.assert` 常驻；`wait_response`、`network.grep` 及带 `heartbeatSec` 的长耗时工具按需 `catalog.add`。

## 接口等待与数据提取

### 等待接口返回而非固定延时

表单提交、搜索、翻页等操作不要依赖固定 `sleep`：

- 用 `page.submit_wait(..., urlContains="/api/submit")` 点击并等待特定接口响应
- 或在操作前后配合 `wait_response(urlContains, status=200)` 精确捕获接口返回

### 直接提取接口响应数据

复杂表格或图表常由后端 JSON 驱动。页面 DOM 复杂或有虚拟列表遮挡时，用 `network.grep(urlContains, keyword)` 检索接口响应中的业务字段或 ID，直接取数。

## 异步任务与长耗时操作

### 识别异步模式

导出报表、音视频处理等长耗时任务，提交接口往往只返回 `taskId` 或 `status: "processing"`。

### 状态检查与等待

1. 记录提交接口返回的任务 ID
2. 用页面元素状态 `page.assert(role, name, states={enabled:true})` 或轮询接口确认进度
3. 耗时较长的后台操作可开启 `heartbeatSec` 心跳机制，避免长时间阻塞；结束后用 `job.status` / `job.stop` 查询或停止

## 请求抓取与本地处理

页面不便直接导出大量数据时：

1. 通过 CDP 监听获取带鉴权信息的请求
2. 由本地命令（如 Python 脚本）执行批量拉取与数据清洗
3. 处理后的文件保存在服务数据目录绝对路径下
