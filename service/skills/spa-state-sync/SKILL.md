SUMMARY: 单页应用（SPA）状态与交互处理：表单事件、虚拟列表与浮层定位。
# 单页应用状态与交互

React、Vue、Angular 等页面会在动作后更新组件和内部状态。先执行已明确的动作，再根据工具结果或页面变化判断下一步；只有目标、状态或结果仍不确定时才补查。不要为一次输入预先遍历所有组件。

## 输入后看反馈

已知元素编号时用 `page_type(tabId, id, text, reason)`；知道角色和名称时用 `page_fill_role(tabId, role, text, reason)`，按需加 `name`、`clearBeforeType`、`pressEnter`。多匹配时收窄目标或依据已有结果指定 `matchIndex`，不猜第一个。

输入工具会模拟交互，但具体控件是否接受仍以返回值和应用反馈为准。输入被恢复、提交值不符或出现校验错误时，检查该控件的格式、受控状态或事件要求，只调整这一处。

确需脚本填写已授权表单时，可调用原生 setter 并派发输入事件，例如：

```javascript
const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
setter.call(inputEl, "目标文本");
inputEl.dispatchEvent(new Event("input", { bubbles: true }));
inputEl.dispatchEvent(new Event("change", { bubbles: true }));
```

`inputEl` 必须来自实际定位；文本域需使用 `HTMLTextAreaElement` 的 setter。此方法不保证适用于所有组件，执行后核对组件反馈。脚本保存后再用 `execute_javascript(tabId, filename, reason)` 执行，不传内联 `code`。不要为了方便读取或控制页面而修改令牌、权限、持久化业务数据或无关应用状态。

## 等待目标状态

有加载过程时用 `wait` 等待具体条件，传入必需的定位参数（如 `tabId`）；`reason` 是否必需以当前 schema 为准。例如可用 `role`、`name`、`states:{attached:true}`，或 `selector`、`visible:true`。超时参数是 `timeoutMs`；它不是传 `ms` 的固定延时工具。已出现目标就直接操作，不额外等待。

`page_recheck` 适合查看当前状态，`page_assert` 用于核验任务要求。超时后根据当前反馈修正定位、检查错误或继续合理的下一步，不重复启动同一业务动作。

## 虚拟列表与浮层

虚拟列表只渲染可见部分。未找到目标行时，先按已知排序、搜索条件或滚动位置缩小范围，将目标移入视口，再定位行内控件。不要把当前 DOM 未命中当作整个数据集不存在。滚动、筛选后编号失效时，重新定位受影响的目标即可。

下拉菜单、日期面板和弹窗常挂在页面根部。点击触发器后在当前页面或弹窗范围定位选项，不继续只搜触发器的子节点。利用实际角色、名称和所在行区分同名控件。

普通 `querySelector` 不穿透 Shadow DOM。可访问开放的 `shadowRoot`，也可使用页面实际暴露的无障碍节点；关闭的 shadow root 不能按开放节点假定读取。操作后用用户所需的值、状态或可见结果验证，截图核验布局，结构化返回核验数据。
