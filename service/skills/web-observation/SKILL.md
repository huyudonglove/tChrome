SUMMARY: 网页观察与操作：按目标选择定位能力，执行交互，用页面、接口和截图反馈验证结果。
# 网页观察与操作

常驻页面操作方法。先明确要操作的对象和预期结果；目标与授权明确时直接操作。页面概况、控件列表、截图和脚本分别回答不同问题，不必每次从整页观察重新开始。动态能力按需 catalog_add，取得 schema 后调用。

需要专项方法时按问题 skill_load：表单与组件状态用 spa-state-sync，接口与后台任务用 api-causality-flow，画布用 canvas-webgl-probing，宿主联调用 host-browser-coordination。浏览器配置问题可用 chrome-host-environment；已有方法足够时直接执行。

## 按缺口定位

- 不熟悉页面时，用 page_get_summary 获取标题、地址和区域；已知目标时直接定位相关控件。
- 用 page_list_interactive_elements 找控件，用 page_list_regions / page_inspect_region 看相关区域结构。已知角色与名称时，可直接用 page_click_role / page_fill_role / page_select_role 等复合工具。
- 多个匹配时依据实际结果收窄名称、区域或指定 matchIndex；不要猜编号或默认第一个就是目标。
- 表格、列表中的编辑或删除按钮，先用目标行的唯一文本确定行，再定位行内按钮。虚拟列表未命中时检查搜索、筛选或滚动位置，不能据当前 DOM 推断整个数据集不存在。

元素 e_、区域 r_ 编号绑定实际节点，同一节点重排不改变编号。导航或节点替换后，旧编号不能代替新节点；失效时重新定位受影响目标，不必重查所有控件。跨标签操作显式传入目标 tabId，编号须来自对应页面证据；切回标签本身不要求重新观察。

## 执行并检查反馈

用 page_click_text、page_fill_submit 等复合工具缩短已明确的交互链路。需要确认可操作状态时加载 wait，按 id、selector 或 role/name 等待具体条件；用 page_assert 验收当前状态，不把断言当等待。

点击需要等待响应时，优先用 page_submit_wait 在点击前建立监听。wait_response 只等后续匹配响应，不回查已经结束的请求；不要先提交后用它追查旧响应。页面加载完成、HTTP 成功或点击成功都只是证据的一部分，按用户目标核对业务字段或页面结果。

自定义下拉、日期面板和级联菜单，先打开浮层，再定位实际选项。输入被恢复或提交值不符时，利用控件校验和事件反馈调整；需要脚本时参考 SPA 技能，不假定直接设置 value 就能同步组件状态。

提交后未出现预期结果，先看相关错误提示、aria-invalid 或实际返回；修正明确问题后继续。成功提示、表单关闭或列表新增项是否足以证明完成，取决于目标行为，不能把任意一个信号当成通用成功条件。重复有副作用的动作前先确认上次是否生效。

## 用截图回答视觉问题

结构化结果适合核验文字、字段与状态；截图适合位置、布局和画面。Canvas、WebGL 等任务按验收需要结合两者，不要求每次操作都截图。

capture_page 的选择：

- element：看清已定位的小控件；ref 与 selector 二选一，返回 image 和 element_rect / capture_rect。
- viewport / full_page：检查视口或整页布局。
- som：视口内可交互控件带角标，并返回 marks。按 badge 找对应 marks 中的 id，再用页面工具操作；不把角标本身当元素编号。可用 roles、maxMarks 限定标注范围。

需要更多细节时再对目标做 element 截图，不把“先整页、再局部”设为每次必经步骤。只有本次随请求附带的图片可供观察；更早批次保留路径，核验当前画面应重新截图。截图中的状态也要与任务完成条件对照，不能仅凭画面变化宣称成功。

## 保留证据供下一步使用

工具结果在 <calls>，需要持续引用的页面状态、脚本结论或截图发现，用 observation_write(type, result, tabId?) 记入 <observations>，Runtime 不自动摘录。观察记录提示从 {{observationFirst}} 次起，后续按 {{observationGate2}}、{{observationMin}} 收紧；按实际提示处理。

业务批次按执行规则写 workspace_write，记录已确认事实、失败原因和下一步；后续复用这些结果。缺原文时用 evidence_search 沿 callId 或 pageId 搜索 keyword、读取 blockId，不重做已完成的业务动作。已提取结论且不再需要正文的大观察，可用 page_clear_result 清理对应 pageId 的正文，保留身份与归档链路。

失败反馈用于选择下一次操作：定位错就修定位，状态未就绪就等目标条件，业务报错就查对应原因。满足验收条件后完成任务；不能验证的部分如实说明。
