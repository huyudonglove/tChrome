# extension

GUI。Side Panel + background。样式对标 telance，组件放 `ui/`。浏览器执行器及测试放在 `tools/`，后台从 `tools/browser-tools.js` 导入；构建仍输出 `dist/background.js`。

面板只请求本机服务 `http://127.0.0.1:18788`：`GET /health`，`POST /turn` `{userInput, submittedAt}`。发送时 `ping` 唤醒 worker。worker 独立每秒拉 `GET /tool-request`，跑完交 `POST /tool-result`；任务运行期间保持 worker 活跃，alarms 用于休眠后恢复。关闭侧栏不影响调度，重新打开后根据服务端 running 状态恢复消息刷新和停止按钮。密钥和落盘不在这里。

`bun build`（仓库根 `bun run scripts/build-extension.ts`）把扩展打进 `dist/`。Chrome 加载的是 **`dist/`**，不是本目录源码。清单为本目录 `manifest.json`，构建时拷贝为 `dist/manifest.json`；改权限或图标后重新 build，再在 `chrome://extensions` 加载/重载 `dist/`。

更新后需在 `chrome://extensions` 重新加载扩展，使新增的 `storage` 和 `alarms` 权限生效。

`extension/tools/` 是 Chrome 宿主执行层，调用 tabs、scripting、debugger 等 API。统一工具注册、参数定义与校验位于 `service/tools/`，扩展从浏览器桥接收已调度请求。

原生对话框通过 Chrome Debugger 的 Page 事件记录，通过 `Page.handleJavaScriptDialog` 处理。`handle_dialog` 接受 `action: "accept" | "dismiss"`、必填 `tabId` 和可选 `promptText`，直接处理已经弹出的 alert、confirm、prompt 或 beforeunload，无需提前调用本工具。确认可能触发提交或离开页面，默认 execution=serial。执行时无弹窗返回 `no_dialog`，其他处理失败返回 `dialog_handle_failed`。

`see_diag` 在浏览器层读取标签和弹窗状态，不执行页面脚本。`dialog.status` 为 `open`、`closed` 或 `unknown`：分别表示捕获到未关闭弹窗、已确认关闭、当前状态无法确认。连接调试器前已出现的弹窗不一定补发开启事件，因此 `unknown` 不能解释为无弹窗；仍可使用 `handle_dialog` 处理。`wait_new_tab` 只等调用后的新标签创建，不等待原生对话框。


工具定位与截图：`snapshot_page` / `find_on_page` 返回与 page.* 同一套 `e_01` 编号，可供 `click` / `type` / `page.*` 使用；区域为 `r_01`。编号共用扩展持久计数器，跨标签、导航和 worker 重启不复用；同一节点在重复观察中保持编号。导航或元素移除后编号失效，不会回退点击其他控件；文本匹配多项时要求先查找并指定 id。`find_on_page` 搜索全部可见交互控件，再限制返回数量，不附带整页正文。`page_find` 使用 `window.find` 选中并滚动到文本，不打开 Ctrl+F 面板。

`capture_page` 的 viewport 模式截可视区；full_page 模式使用 CDP 捕获已渲染的整页内容，不滚动触发懒加载或展开独立滚动容器。单边超过 16000 或总面积超过 3200 万像素时明确失败。`list_downloads` 列出最近下载；`wait_download` 必须指定 downloadId，等待下载完成、中断或超时。

构建工具源码和 schema 时会生成执行器指纹。扩展与服务每次派发工具前核对版本；不一致时不执行工具，并在侧栏提示重新打包、重启服务和重新加载扩展，避免新版说明与旧实现混用。


`capture_page` 的 element 模式真正裁剪指定元素：`ref` 使用查找工具返回的稳定引用，`selector` 使用唯一匹配的 CSS 选择器，二者互斥。支持可视区外已渲染元素，不滚动页面；返回文档 CSS 坐标及实际裁剪范围，图片像素尺寸随屏幕像素比变化。

`save_pdf` 通过 Chrome 的 Page.printToPDF 生成打印版 PDF，下载到本机并确认下载完成后返回绝对路径。文件名相对浏览器下载目录，重名自动改名；下载仍进行时返回 pending 和 downloadId，可继续 wait_download，不重复打印。工具历史不包含 PDF/base64。

验证码工具检查受支持组件及其 frame，点击实际可访问的勾选控件，不能用点击 iframe 代替。`see_captcha` / `wait_captcha` 的检测成功不等于验证成功；`solve_captcha` 仅在唯一组件出现非空响应字段且状态可确认时成功。仅勾选、多组件、无法访问的 frame 或图像拼图挑战不会假报通过，返回 requiresUser 交给用户处理；工具不返回响应令牌。

`execute_javascript` 的模型参数为 filename 和必填 tabId。服务从数据目录 scripts 读取已保存的 .js/.mjs/.cjs 文件，再将脚本交给扩展执行；扩展负责在目标页面主环境求值。模型先保存脚本并确认成功；若用 script_patch 保存，须在执行之前的调用完成，同批补丁与执行由 Runtime 拒绝。

控制台日志仅在调用 `see_console` 时向目标页面注入监听；扩展启用和普通页面打开不自动注入。日志从开启时开始采集，刷新或导航后需重新开启；无法读取开启前的日志。
