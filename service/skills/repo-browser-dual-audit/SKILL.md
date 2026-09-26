TAGS:
- 联动测试
- 代码
- 浏览器
- 真实浏览器
- 交互
- 取证
- 边界
# 真实浏览器 + 代码双轨验证 (Real-Browser + Code Dual-Track Verification)

在**用户真实 Chrome 标签**（带登录态、扩展、真实 profile、真实渲染能力）里像人一样操作页面，同时读本地源码做双向核对。适用于功能验收、表单与登录流程、上传下载、边界与报错页、空态与异步竞态、渲染与性能、Console 错误、跨页状态保持等场景。

结论口径：**凡依赖登录态、SDK、WebGPU/Canvas、localStorage、扩展注入或视觉呈现的判断，必须真实浏览器实测；只有纯结构扫描（HTTP 状态、路由可达、控制台异常）才允许无头浏览器代跑。**

## 双轨模型

| 轨 | 手段 | 擅长 | 不可信之处 |
| --- | --- | --- | --- |
| 源码轨 | `local.fs_grep` / `fs_read` / `fs_list` / `local.run` | 意图、路由表、校验逻辑、错误分支、API 契约、构建配置 | 读不到运行时状态，判断停留在推断 |
| 真实浏览器轨 | `list_tabs` → `open_url` / `page.*` / `capture_*` / `har` / `see_console` / `page.eval_expr` | 实际渲染、登录态、交互链路、网络与渲染能力、视觉结果 | 单页单次，慢；易被 skeleton 误导 |

联动的核心价值在**对照**：先从源码写出「这一步应该发生什么」的预期，再在真实浏览器里执行并断言；两者不一致的地方就是缺陷（或代码与设计不符），本身就是最有价值的发现。

## 源码轨：先形成预期

1. **入口与路由清单**：抽路由表 `path:`，再抽 header/footer/卡片上的 `to=`、`href=`、按钮 `onClick`，与路由表对账 → 快速暴露死链、未注册路由、单复数不一致。
2. **流程预期**：对要测的流程读组件本身——表单字段与校验规则、提交接口、成功/失败分支、错误文案、空态与骨架屏、权限守卫（`RequireAuth`、重定向）、占位实现（placeholder、mock、TODO）。
3. **契约与依赖**：API 前缀与 baseURL、代理配置（vite proxy target）、SDK/第三方域、鉴权 header 注入位置。
4. **对照后端可达性**：`curl` 直连后端与经 dev server 代理各跑一次，区分「应用 bug」与「环境不通」。

## 真实浏览器轨：像人一样操作

- **选标签**：`list_tabs` / `tabs.current` 拿 tabId，优先用用户已打开的目标站标签；`open_tab` 可后台新开但一般不激活。
- **导航与等待**：`open_url` 导航；`wait_network` 等接口安静再读，`wait_text` / `wait`（id/selector/role±name±states）等具体条件。别用静态抓文本判断加载完成——常停在 skeleton。
- **看结构**：`page.get_summary`（规模）→ `page.list_interactive_elements` / `find_on_page` / `page.get_by_role`（定位）→ `page.inspect_element` / `inspect_region`（细节）。
- **做交互**：优先复合工具 `page.click_role` / `fill_role` / `click_text` / `select_role` / `fill_submit` / `submit_wait` / `combo_select` / `date_select` / `drag_to_id`；多匹配必须 `matchIndex` 或收窄 name。
- **做验收**：`page.assert`（结论级）、`page.recheck`（观察级）、`wait_response`（接口级）、`har`（全量请求流）。
- **做取证**：`capture_viewport` 视口、`capture_som` 一屏多控件角标图、局部控件用 `capture_page(mode=element)`。
- **读环境**：`page.eval_expr` 读 cookie / localStorage / IndexedDB / 渲染能力（如 `navigator.gpu`、`webgl` 参数、`s3d.rendererCapabilities`）；`fingerprint.read` 看 UA、时区、viewport；必要时 `fingerprint.apply` 模拟目标环境。
- **读运行时**：Console 错误（`see_console`，需页面已注入监听）、DOM 快照差分（`effects.domChange`）、`pageerror`、请求失败清单。
- **有副作用的操作**（提交表单、上传文件、删除、对外发消息、涉及账号资金）必须有用户对该动作的明确授权；先核对参数，执行后闭环断言（列表出现新记录 / 成功提示 / 表单关闭），不把「点了」当「成了」。

## 通用验证场景与手法

- **功能验收**：源码写预期 → 真实标签执行 → 断言 UI + 接口 + 状态三方一致。
- **表单与登录**：空值/边界值/非法值/超长输入逐项试；看校验提示、按钮 disabled 态、提交后错误定位；登录态用 `eval_expr` 读 cookie/localStorage 对账。
- **上传下载**：真实标签触发选择，观察进度、失败重试、落库后详情页能否取回；下载用 HAR 确认响应而非只看提示。
- **边界与报错页**：不存在的 id/slug/用户名、未知路由、占位路由、无结果搜索词、未登录访问受保护页、非法参数、嵌套子路由。逐条问：有 404 或空态吗、标题合理吗（常见「裸 id 当标题」）、给出下一步动作吗。
- **空态与数据差异**：有数据 / 无数据 / 加载中 / 加载失败四种态都要看；无数据时是否给引导动作。
- **异步与竞态**：快速连点、导航中改 URL、请求未返回时切页；看是否重复请求、旧响应覆盖新状态。
- **跨页状态保持**：滚动位置、筛选条件、分页、主题切换在导航后是否保留。
- **渲染与性能**：Canvas/WebGL/3D 页面用 `eval_expr` 探尺寸、像素、上下文是否创建成功（脚本状态不足以证明画面成立时必须截图）；首屏骨架与最终态差异。
- **响应式与多视口**：`fingerprint.apply` 改 width/height 验证断点，配合截图。
- **第三方依赖**：统计、SDK、CDN 失败要区分「外网不通」与「应用缺陷」，先剔除噪声再下结论。

## 硬规则（都是踩过的坑）

- **无头 ≠ 真实**。playwright `channel:'chrome', headless:true` 是全新 profile：无 cookie、无 token、无扩展。实测 shining3dReact 无头下 `/3dgs`、`/collections`、`/featured-models` 稳定 `Unable to load …` 被误报 P0，真实 Chrome 三页全有数据；根因是无头未登录 + `/api/sdk/cloud/auth/connect` 502，业务请求根本没发出。**无头结论只能当线索。**
- **脚本接不上真实浏览器就别硬凑**。先探 `lsof -iTCP:9222 -sTCP:LISTEN` + `curl /json/version` + `connectOverCDP`；若 9222 在 LISTEN 但 `/json/version` 404，说明该 Chrome 走扩展注入桥，脚本无法复用登录态 → 分工：无头做批量速筛，真实标签做有状态结论。
- **批量脚本工程细节**：复用单个 context；逐条即时打印（末尾一次性 `console.log` 会因缓冲区丢掉全部输出）；导航超时 12s；输出超 4000 字符会被外置，跑完用摘要脚本压成「只留非 2xx 与 error 行」。
- **等加载再断言**：`wait_network` 超时返回 `ok:false` 但仍带页面文本，文本可用；抓文本常停在 `Loading models...`，最终可能是 `No models here.`。
- **死链判定看 href 实际值**：指向外站的入口不是死链；grep 不到路由不等于不可达（政策页可能另有注册机制，要查清）。
- **未跑的门禁要说明**：缺 chromium 的 e2e、因缺后端而未验的登录态流程，都属于未覆盖项，不能算通过。
- **不要凭 <toolIO> 里显示的 arguments 判断调用是否成形**。会话时间线展示的 `arguments` 是缩写投影（如 `{"task": true}`、`{"notes": "x"}`、`{"output": "ask"}`），不是实际 payload；据此得出的「参数没传、ok:true 但没落库」结论是错的。验证写法是否落库，正确做法是用一个唯一标记（如 `PROBE-2-EXACT-STRING`）写入后去 `ledger.json` grep 读回。实测：完整参数的 notes.write/observation.write/reflect.write 全部正常落库，漏必填会如实返回 `missing_required`/`wrong_type`。

## 收口

每条结论标注来源：**真实浏览器实测 / 源码核对 / 无头线索 / 推断未验证**。给优先级，写清未覆盖项与需要的授权。冲突时以真实浏览器为准，并把差异原因（登录态、profile、扩展、端口、渲染能力）写成一条独立发现。

关键观察（页面状态、脚本结论、截图发现）用 `observation.write` 固化，避免后续压缩后丢失证据。
