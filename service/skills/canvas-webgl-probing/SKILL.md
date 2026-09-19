# Canvas / WebGL 富图形与游戏化探查 (Canvas & WebGL Probing)

Canvas 2D、WebGL、三维看版及基于物理引擎的 Web 应用（如 Figma、Excalidraw、2048、在线游戏）将所有图形直接绘制至像素位图，脱离了标准 DOM 与 A11y 语义树，属于自动化中的「语义黑盒」。

## 1. 底层存储与状态总线直接穿透 (Store Piercing)

- **穿透渲染黑盒，直取业务模型**：
  - 现代富图形应用大多采用单一状态树（Redux、Zustand、Pinia 或 `localStorage` 底座）驱动渲染。
  - 优先探查宿主存储层（如 Excalidraw 的 `localStorage.getItem("excalidraw")`），直接读取画布元素拓扑或游戏得分状态矩阵；
  - 状态写入反哺：构造标准 JSON 拓扑注入存储层并派发系统事件或刷新，实现毫秒级工业架构图重绘，远胜低效物理绘制。

## 2. 原型链 Hook 与实时状态探针 (API & Context Hooking)

- **Canvas 绘制上下文拦截**：
  - 在页面初始化阶段通过脚本 Hook `CanvasRenderingContext2D.prototype.fillText` 或 WebGL 渲染循环，实时捕获屏幕文字、精灵坐标及碰撞体数据：
    ```javascript
    const origFillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text, x, y) {
      window.__canvas_text_cache = window.__canvas_text_cache || [];
      window.__canvas_text_cache.push({ text, x, y, time: Date.now() });
      return origFillText.apply(this, arguments);
    };
    ```
- **游戏循环与时钟劫持**：
  - 针对高帧率复杂动画或游戏，可注入脚本劫持 `requestAnimationFrame` 或挂载全局控制器，实现逐帧单步步进与启发式算法决策。

## 3. 混合视觉定位与连续物理时序 (Hybrid Vision & Input Sequence)

- **Set-of-Marks (SoM) 与高清切片协同**：
  - 纯画面无 DOM 场景下，调用 `capture_page(mode="som")` 自动提取离散高亮角标降低模型空间推理负担；
  - 局部关键区域使用 `capture_page(mode="element", selector="canvas")` 获取高保真图像核验细节。
- **物理指针拖拽与按键时序**：
  - 绘图与拖拽必须遵循完整鼠标时序：`pointerdown` → `pointermove`（多点平滑插值）→ `pointerup`；
  - 游戏交互使用 `press(key, tabId)` 模拟键盘物理下发，按键间隔控制在 100~200ms 之间，避免事件被前端节流丢弃。
