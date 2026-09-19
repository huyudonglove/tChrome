# 现代 SPA 状态同步与事件合成 (SPA State Sync & Event Dispatch)

在 React、Vue、Angular 等现代前端单页应用（SPA）中，表单输入与控件通常由框架的受控状态（Controlled State）或虚拟 DOM 管理。直接修改 DOM 属性（如 `input.value = "..."`）不会触发框架内部状态更新，常导致提交时数据丢失或校验失败。

## 1. 受控表单与动态输入同步机制

- **标准原型链 Setter 穿透**：
  - React 等框架重写了 HTMLInputElement 的 `value` setter。纯 JS 脚本赋值时，必须调用原型链原生方法，随后显式派发合成事件：
    ```javascript
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    nativeInputValueSetter.call(inputEl, "目标文本");
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    inputEl.dispatchEvent(new Event("change", { bubbles: true }));
    inputEl.dispatchEvent(new Event("blur", { bubbles: true }));
    ```
- **复合工具优先法则**：
  - 优先使用 `page.fill_role`、`page.type` 等经过 CDP 物理输入协议包装的工具，自动模拟原生按键序列与焦点事件，天然触发框架响应式管线。

## 2. 虚拟列表与动态视口滚动 (Virtual List)

- **视口外节点懒加载与回收**：
  - 复杂表格或长列表（如 Ant Design Table、ag-Grid、TanStack Virtual）仅在 DOM 中保留当前可见行，视口外元素未挂载。
- **定位与操作 SOP**：
  1. **容器滚动先行**：先定位到滚动容器元素，通过 `element.scrollTo({ top: ..., behavior: 'smooth' })` 或按键 `PageDown`/`ArrowDown` 将目标项滚动进入视口中央；
  2. **等待渲染沉降**：调用 `wait(role, name, states={attached:true})` 确认行容器及操作控件已挂载到 DOM/A11y 树；
  3. **局部锚定交互**：先以唯一主键/标识锁定行容器（`tr`/`div[role="row"]`），再在子树内调用 `page.click_role` 执行操作，严禁全局贪婪匹配。

## 3. 浮层、级联组件与 Shadow DOM

- **动态挂载浮层（Portal / Modal）**：
  - Select 下拉菜单、DatePicker、Tooltip 通常渲染在 `document.body` 根节点的 Portal 容器中，脱离原本父组件 DOM 结构；
  - 操作 SOP：先点击触发框唤起浮层，再使用全局可访问名定位弹出的浮层选项，切勿在触发框内部寻找 option 节点。
- **Web Components 与 Shadow DOM 穿透**：
  - 常规 `querySelector` 无法穿透 `shadowRoot`。探查时需递归遍历 `el.shadowRoot`，或使用支持穿透的 CSS 深度选择器，或优先借助浏览器内核自动展平的 A11y 树直接定位。
