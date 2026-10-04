SUMMARY: 网页观察与操作：按区域缩小到控件、交互验收与截图证据。
# 网页观察与操作

常驻页面操作方法。浏览器主链路工具一直可用；截图、`page_get_by_role`、`wait`、`wait_response` 等按需 `catalog_add`。

## 观察推进

按下一步需要，从页面概况缩小到相关区域或控件；目标明确、证据足够时直接操作。

1. `open_url` 打开或跳转后，用 `page_get_summary` 读标题、地址、区域与可交互规模。
2. 需要定位控件时用 `page_list_interactive_elements`；需要区域结构时再加载 `page_list_regions` / `page_inspect_region`。
3. 取元素 id、regionId 时看本轮 `<toolIO>` / `<observations>` 中对应项的 result，不要凭空猜测编号。

带 tabId 的操作（`page.*`、`open_url`、截图、标签内脚本等）返回完整落在本轮 `<toolIO>`。需要固化的页面状态、脚本结论或截图发现，用 `observation_write(type, result, tabId?)` 记入本轮 `<observations>`；Runtime 不自动摘录。产出证据类工具调用累计到门槛（{{observationFirst}} 次起，每次提示后收紧为 {{observationGate2}}、{{observationMin}}）未记录时会提示。工具导航里的「类似 / 深入」给出同级替换与后续链路，如 `page_get_summary` 深入 `page_list_interactive_elements`。

## 元素编号与标签

元素和区域 id 是按可见节点顺序生成的临时编号（`e_` / `r_`）。导航、节点增删或顺序变化后重新获取；确认变化不影响编号时可复用，单纯切回标签无需重新观察。跨标签操作时须显式传入目标 tabId，各标签节点编号独立，切勿跨标签混用编号。

## 交互与验收

优先用常驻复合工具一次完成定位+操作：`page_click_role` / `page_fill_role` / `page_submit_wait` / `page_select_role` / `page_click_text` / `page_fill_submit`。role/name 多匹配时必须 `matchIndex`，或收窄 name；无 name 且 total>1 时不猜测。

复杂交互：加载 `page_get_by_role` 按 role+name 取 `e_` 编号；提交后用 `wait_response(urlContains)` 等接口；用 `wait`（id/selector，visible/enabled）确认可操作再点。

**动态 A11y**：`wait(role, name, states={enabled:true|checked:true|expanded:true|attached:true})`；验收用 `page_assert(role, name, states)`。`page_list_interactive_elements` 每条带 states。

## 观察清理

已完成分析、抽出关键信息、后面不用再对照的大体积观察（整页 DOM、大列表、密集区域快照），用 `page_clear_result` 清空对应 pageId 的 result 正文，保留身份与链路字段，避免历史观察挤占上下文。

## 截图证据

Canvas、WebGL、游戏等结果依赖画面的任务，JS 探针用于辅助定位和读取状态；关键操作后或程序状态不足以确认结果时，调用截图工具观察画面，再结合任务完成条件验证。截图可确认位置、对齐和画面变化，通关或稳定性还需对应证据；证据不足时继续核实，不宣称成功。按验证需要截图，无需每次操作都截图。只有本次随请求附带的图片可供观察；更早批次只保留路径，需要确认当前画面时重新截图。

### 局部元素截图（省 Token、更清晰）

大分辨率下小控件在整页图里容易糊，且整图更贵。需要看清某个元素/控件时，优先：

```text
catalog_add → capture_page
capture_page(mode=element, tabId=…, ref=e_03)   # 或 selector="#submit"
```

- `ref`：`page.*` / snapshot / `page_get_by_role` 返回的 `e_` / `r_` 编号
- `selector`：唯一 CSS；与 `ref` **二选一**
- 返回本地 `image` 引用 + `element_rect`/`capture_rect`；只观察该切片，不要为小控件先截整页
- 验证整页布局、导航前后对比时才用 `viewport` / `full_page`

### 视口 SoM 标注图（一屏多控件）

复杂页面「点哪个」不明确时：

```text
capture_page(mode=som, tabId=…, maxMarks=40, roles=["button","link"])
```

- 图上红色角标 = 可交互控件；同时返回 `marks[{badge,id,x,y,…}]`
- 看图选定 badge → `page_click(id=marks[i].id)`（即 `e_` 编号）
- `marks` 为视口 CSS 像素；`devicePixelRatio` 仅作对照
- 截图后角标层自动清理；默认最多 40 个，可用 `roles` 降噪

两阶段：先 `som` 看全局 → 再 `mode=element` 对选定 `e_` 高清切片。

## 复杂表单与复合表格操作

自定义下拉、日期选择器和级联浮层通常不接受直接文本注入。优先模拟交互链路：点击触发输入框唤起面板，再在可见浮层 DOM 中点击具体候选项；脚本设置时须同时触发 input、change 与 blur 事件，避免现代前端响应式状态未同步。

操作表格或列表项中的按钮（如编辑、删除、查看）时，严禁全局无差别定位。应先以该行唯一标识文本锚定行容器（tr、li 或卡片节点），再在其子树内查找操作控件；虚拟列表或超出视口的行须先滚动至视口中央再执行交互。

点击保存或提交不等于操作成功。提交后若表单未关闭，先探查页面局部错误提示（如 error-tip、aria-invalid 或红色高亮项）并针对性修正参数；保存成功的判定依据是表单层关闭、成功 Toast 出现或数据列表中渲染出对应项，完成操作后须闭环核验。
