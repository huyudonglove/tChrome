# Canvas 与 WebGL 应用操作 (Canvas & WebGL)
TAGS: canvas, webgl, 富图形, 存储穿透

Canvas 2D、WebGL 等页面（如在线绘图工具、看板、小游戏）将内容直接绘制在像素画布上，缺少常规 DOM 节点和无障碍树，无法直接通过元素 ID 或角色定位。

## 1. 检查底层数据与存储

- **优先查看数据模型**：
  - 很多画布应用在内存或本地存储中保留了结构化数据（如 Redux、Zustand、Pinia 或 `localStorage`）。
  - 可以先检查页面存储（如 `localStorage.getItem(...)`），直接读取图形数据或状态；
  - 部分场景下直接修改数据并触发页面重绘，比模拟鼠标轨迹绘制更直接、准确。

## 2. 脚本注入与状态监听

- **拦截 Canvas 绘制方法**：
  - 在页面加载时通过注入脚本，重写 `CanvasRenderingContext2D.prototype.fillText` 或 WebGL 渲染方法，获取绘制在画布上的文字和坐标：
    ```javascript
    const origFillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text, x, y) {
      window.__canvas_text_cache = window.__canvas_text_cache || [];
      window.__canvas_text_cache.push({ text, x, y, time: Date.now() });
      return origFillText.apply(this, arguments);
    };
    ```
- **控制动画与刷新**：
  - 对于快速变动的动画或游戏，可通过脚本控制 `requestAnimationFrame` 或调用页面内部暴露的方法，实现按步推进。

## 3. 视觉标注与模拟操作

- **使用标注截图与局部切片**：
  - 在没有 DOM 的界面上，调用 `capture_page(mode="som")` 获取带角标的截图，辅助判断点击位置；
  - 需要核验局部细节时，使用 `capture_page(mode="element", selector="canvas")` 查看局部图像。
- **模拟连续鼠标与键盘操作**：
  - 绘制或拖拽操作需要按照完整时序执行：`pointerdown` → `pointermove`（平滑移动）→ `pointerup`；
  - 模拟键盘按键使用 `press(key, tabId)`，两次按键之间保持 100~200ms 间隔，避免按键事件被页面丢弃。
