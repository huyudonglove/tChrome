TAGS:
- spa
- 表单
- 前端
- 事件
# 单页应用 (SPA) 状态与交互处理

在 React、Vue、Angular 等现代单页应用中，输入框和组件通常由框架内部状态管理。直接修改 DOM 属性（如 `input.value = "..."`）不会触发框架状态更新，容易导致提交时数据丢失。

## 1. 表单输入与事件触发

- **使用原生 Setter 触发事件**：
  - React 等框架重写了输入框的 `value` setter。如果必须通过 JavaScript 直接修改输入框，需要调用原生原型链方法并派发事件：
    ```javascript
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    nativeInputValueSetter.call(inputEl, "目标文本");
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    inputEl.dispatchEvent(new Event("change", { bubbles: true }));
    inputEl.dispatchEvent(new Event("blur", { bubbles: true }));
    ```
- **优先使用复合输入工具**：
  - 优先使用 `page.fill_role`、`page.type` 等工具，这些工具通过 CDP 协议模拟真实键盘输入，能自动触发框架的响应式更新。

## 2. 虚拟列表滚动与定位

- **视口外元素未渲染**：
  - 虚拟表格或长列表（如 Ant Design Table、ag-Grid）只渲染当前视口可见的行，视口外的元素不会出现在 DOM 中。
- **操作步骤**：
  1. **滚动到目标位置**：先定位到滚动容器，通过 `element.scrollTo(...)` 或按键滚动将目标行移入视口；
  2. **等待元素出现**：调用 `wait(role, name, states={attached:true})` 确认目标行已挂载；
  3. **精确定位行内控件**：先根据行的唯一文本找到行容器（如 `tr`），再在行内查找操作按钮，避免全局匹配点错行。

## 3. 弹窗、下拉菜单与 Shadow DOM

- **脱离父节点的弹窗浮层**：
  - 下拉选择框（Select）、日期选择器、模态弹窗通常直接挂载在 `document.body` 下，脱离了触发按钮原本的 DOM 结构；
  - 操作步骤：先点击触发按钮唤起菜单，再在页面全局范围内按名称查找并点击弹出的选项，不要在原触发按钮内部寻找选项。
- **Shadow DOM 查找**：
  - 普通 `querySelector` 无法直接穿透 `shadowRoot`。如果页面使用了 Web Components，需要访问 `el.shadowRoot`，或优先使用基于无障碍树（A11y）的定位工具直接操作。
