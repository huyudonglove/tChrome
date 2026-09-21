TAGS:
- spa
- 表单
- 前端
- 事件
# 单页应用 (SPA) 状态与交互处理

React、Vue、Angular 等单页应用中，输入框和组件由框架内部状态管理。直接改 DOM 属性（如 `input.value = "..."`）不会触发框架状态更新，容易导致提交时数据丢失。优先用常驻输入工具 `page.fill_role` / `page.type`（CDP 真实键入，可触发响应式更新）；`wait` 等动态工具按需 `catalog.add`。

## 表单输入与事件触发

### 优先使用复合输入工具

`page.fill_role`、`page.type` 通过 CDP 模拟真实键盘输入，能自动触发框架响应式更新。能走工具时不要改 DOM。

### 必须脚本注入时用原生 Setter

React 等框架重写了输入框的 `value` setter。脚本直接改值时，须调用原生原型链方法并派发事件：

```javascript
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
nativeInputValueSetter.call(inputEl, "目标文本");
inputEl.dispatchEvent(new Event("input", { bubbles: true }));
inputEl.dispatchEvent(new Event("change", { bubbles: true }));
inputEl.dispatchEvent(new Event("blur", { bubbles: true }));
```

## 虚拟列表滚动与定位

虚拟表格或长列表（Ant Design Table、ag-Grid 等）只渲染视口可见行，视口外节点不在 DOM 中。

1. **滚动到目标位置**：定位滚动容器，用 `element.scrollTo(...)` 或按键滚动，把目标行移入视口。
2. **等待元素出现**：`wait(role, name, states={attached:true})` 确认目标行已挂载。
3. **精确定位行内控件**：先以行唯一文本找到行容器（如 `tr`），再在行内查找操作按钮，避免全局匹配点错行。

## 弹窗、下拉与 Shadow DOM

### 脱离父节点的浮层

Select、日期选择器、模态弹窗通常直接挂载在 `document.body` 下，脱离触发按钮的 DOM 结构。

操作：先点击触发按钮唤起菜单，再在页面全局范围内按名称查找并点击弹出选项，不要在原触发按钮内部找选项。

### Shadow DOM

普通 `querySelector` 无法直接穿透 `shadowRoot`。页面使用 Web Components 时，访问 `el.shadowRoot`，或优先用基于无障碍树（A11y）的定位工具直接操作。
