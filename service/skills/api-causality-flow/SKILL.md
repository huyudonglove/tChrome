# 接口级因果流与异步任务编排 (API Causality & Async Orchestration)

复杂 Web 任务中，前端界面变化往往由底层网络请求严格驱动。将 UI 操作与网络接口解耦、以接口因果链为锚点，是消除竞态条件、实现高确定性自动化的核心手段。

## 1. 接口拦截与网络因果锚定 (Network Causality)

- **交互-响应闭环契约**：
  - 表单提交、异步检索或分页切换等操作，严禁依赖无意义的固定延时（如 `sleep(3000)`）。
  - 必须采用「点击并等待确定性响应」模式：
    - 使用 `page.submit_wait(id, urlContains="/api/submit")` 一步完成提交与响应拦截；
    - 或在触发操作前后配合 `wait_response(urlContains, status=200)` 精确捕获后端返回。
- **关键数据精准提取 (Network Grep)**：
  - 列表刷新或复杂图表数据通常由 JSON 响应直接驱动。当页面 DOM 渲染复杂或存在虚拟化遮蔽时，直接使用 `network.grep(urlContains, keyword)` 在接口响应体中检索业务字段或订单 ID，实现秒级高保真取证。

## 2. 异步轮询与长任务指数退避 (Polling & Exponential Backoff)

- **异步任务生命周期识别**：
  - 导出报表、音视频转码、AI 生成等长耗时任务，提交接口仅返回 `taskId` 或状态 `status: "processing"`。
- **稳态感知与智能重试**：
  1. **首期探测**：拦截提交接口返回的标识 ID（`jobId` / `taskId`）；
  2. **状态轮询与状态断言**：通过 `page.assert(role, name, states={enabled:true})` 或接口监听监控进度；
  3. **动态心跳分流**：长时间无 UI 变化的后台任务，启用 `heartbeatSec` 心跳机制，释放调度线程并在任务就绪后回调唤醒，避免阻塞 Agent 上下文。

## 3. 请求签名、脱水提取与宿主穿透

- **突破浏览器端沙箱与跨域限制**：
  - 当页面禁止跨域提取数据或需要离线批处理时，通过 CDP 监听截获带 Cookie / Token 签名的目标请求元数据；
  - 将脱水后的请求体、Header 与 URL 分流至本机宿主层（`local.run` / Python / Bun）执行大规模并行下载或数据清洗，结果落盘后再同步回浏览器或本地资料库。宿主 cwd 与落盘路径使用服务数据目录绝对路径（见 `<overview>`），不要写入代码仓库。
