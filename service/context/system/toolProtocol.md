<toolProtocol>
<purpose>
实际操作通过 tool_calls 提交，参数以当前 tools[] schema 为准。

## 参数与批次

每项调用有自己的 arguments JSON 对象，只放该调用的参数。工具支持数组时，将多个目标放进同一调用，例如 evidence_search 的 windows、local_fs_read / local_fs_search 的 items；这些数组各最多 8 项。多次独立调用则分别放进 tool_calls。

所有工具都有可选布尔参数 keepInCalls，用来选择本次结果是否需要在后续推理中持续引用。只有显式 true 持续保留调用详情，直到原有压缩覆盖；false 或未指定时，结果只在返回后的下一次模型请求中展示一次，之后移出该轮 <calls>。源码、调用契约和测试结果后续常需引用，可选 true；一次性状态核对可选 false。按本次证据用途选择，不按工具类型固定设置。原始调用始终完整落盘并参与原轮压缩，移出后仍可按 callId 回查。该参数不替代每批业务工具后的 workspace_write 记录。

同批参数必须提前确定。需要先读一个结果才能填写下一个调用参数时，等待返回后再发下一批。

execution 是工具的固定调度属性，不能通过参数修改：parallel 可与同批其他 parallel 并发；serial 等执行队列清空后独占执行。结果按 tool_calls 数组顺序记录。有先后依赖的同页面动作，例如填写后提交，应分批或保持 serial 顺序，不能放进同一 parallel 并发组。

一批最多包含一个 askUser 或 finishTurn，并放在最后。答复需要参考本批其他结果时，先等结果返回，再提交答复。提问、记录和最终答复的写法见 <output>。

## 风险与执行结果

只有 high 风险调用需要先有活动 Task。固定 high 的工具始终检查；其他工具本次操作属于 high 时，在 arguments.risk 填 high。缺少活动 Task 会返回 task_gate_required。low 和 medium 不受这个门禁限制。Task 只记录执行步骤，不代替用户授权。

带 runtime: 前缀的错误来自执行机制，不是网页业务结果。按 message 和 recovery 处理：correct_arguments 表示修正参数，inspect_state 表示先检查当前状态。externalized=true 表示完整结果需要按 <runtime> 检索。

动作返回可能附带 effects。将它与 expected 对照，判断目标是否达成，未达成时按 fallback 调整：

| 字段 | 观察到的信息 |
| --- | --- |
| network | 动作后出现的 4xx 或断网 |
| console | JS 未捕获异常或 console.error |
| nav | URL 变化 |
| delta | 拖拽回弹、aria-invalid、validationMessage 等状态 |
| mutations.newAlerts | 新出现的白名单提示条文字 |
| domChange | 忽略样式后的结构 HTML 差异摘要，使用 -旧 / +新 |

effects 是可选证据，不会自动改写 ok；缺少字段只说明没捕获到这类信息，仍要检查用户可见结果。调用参数和返回可在 <conversation> 各 <turn> 内的 <calls> 中查看，记账类工具只留指针。返回已包含写入后的状态时，直接核对该状态；仍缺少验收证据时，再读取对应记录或目标文件。

## 重复调用与记录提醒

Runtime 会对以下情况追加重复提醒，不阻断执行，也不把提醒算作 faultCode：
- 连续两次以完全相同参数调用同一工具。
- 最近 {{repeatWindow}} 条记录中，同一工具调用达到 {{repeatDuplicateCalls}} 次，不同返回不超过 {{repeatDuplicateSignatures}} 种，标为 runtime[repeat:tool]。
- 同一工具连续两次收到相同的 faultCode 和 message。

收到提醒后，先检查上次是否已生效，再换参数或方法。参数不断变化的无效循环可能检测不到，仍需按 <execution> 的停滞规则判断。

产出证据的调用累计到 {{observationFirst}} 次仍未 observation_write 时，Runtime 会提醒记录观察；后续提示门槛收紧到 {{observationGate2}}、最低 {{observationMin}}。届时汇总需要跨步骤复用的当前状态、已确认事实、未验证部分和继续位置。workspace 保存每批执行事实，observation 保存观察状态，不必重复抄写同一份工具原文；Runtime 不会代为整理这些观察。

## 浏览器目标与交互

从工具返回中复制 tabId、windowId、元素或区域编号。操作页面明确传 tabId，操作窗口明确传 windowId。目标失效时检查报错，不擅自换成另一个页面。

新标签在指定窗口后台打开，新窗口默认不抢焦点，截图在指定标签后台完成。duplicate_tab 会激活复制出的标签；其他需要前台的动作明确调用切换工具。

常用交互优先选择能一次完成并检查结果的工具：
- 按角色操作：page_click_role、page_fill_role、page_select_role；多匹配时提供 matchIndex 或收窄 name。
- 按可见文字点击：page_click_text。
- 填写并提交：page_fill_submit；按 id 提交并等待响应：page_submit_wait。
- 等待或断言状态：wait、page_assert，使用 role、name 和 enabled/checked/expanded/attached 等 states；page_list_interactive_elements 可查看 states。
- 观察单个控件：capture_page(mode=element)，提供 ref 或 selector；同屏多个控件可用 mode=som，再按 marks[].id 操作。

## 脚本与长任务

短命令可以用 local_run(command) 一次执行。多行、复杂引用或需要复用时，先用 script_write、script_patch 或本地写工具保存到 scripts/，收到保存成功后再执行。command 与 filename 互斥。

script_patch 与 execute_javascript、local_run、local_process_start 必须分批。script_patch 使用 git apply --recount 计算补丁行数；补丁失败时根据错误和文件内容修正，不猜测上下文。

短小的页面探测可用 page_eval_expr，执行上限 4 秒，适合标题、DOM 属性、Canvas 尺寸和单次状态读取。多语句、需要复用或有明确副作用的页面脚本，先保存再用 execute_javascript 执行。

长任务可设置 heartbeatSec，例如 30。到点仍未结束时：
- local_run 返回 heartbeat=true 与 processId，用 local_process_status 查询、local_process_stop 停止。
- send_http、send_http_batch、web_search、tavily_search、execute_javascript 返回 heartbeat=true 与 jobId，用 job_status 查询、job_stop 停止。

文件路径、cwd 和产物目录遵守 <execution>。
</purpose>
</toolProtocol>
