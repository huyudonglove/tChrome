TAGS:
- canvas
- webgl
- 富图形
- 存储穿透
# Canvas 与 WebGL 应用操作 (Canvas & WebGL)

Canvas 2D、WebGL 等页面（在线绘图、看板、小游戏）将内容直接画在像素画布上，缺少常规 DOM 节点和无障碍树，无法用元素 ID 或角色定位。优先穿透数据模型；画面证据用截图。`execute_javascript`、`capture_page`、`press` 等按需 `catalog.add`。

## 检查底层数据与存储

很多画布应用在内存或本地存储中保留结构化数据（Redux、Zustand、Pinia、`localStorage` 等）。

1. 先检查页面存储（如 `localStorage.getItem(...)`），直接读图形数据或状态
2. 部分场景直接改数据并触发重绘，比模拟鼠标轨迹更直接、准确

## 脚本注入与状态监听

### 拦截 Canvas 绘制方法

页面加载时注入脚本，重写 `CanvasRenderingContext2D.prototype.fillText` 或 WebGL 渲染方法，捕获画布上的文字与坐标：

```javascript
const origFillText = CanvasRenderingContext2D.prototype.fillText;
CanvasRenderingContext2D.prototype.fillText = function(text, x, y) {
  window.__canvas_text_cache = window.__canvas_text_cache || [];
  window.__canvas_text_cache.push({ text, x, y, time: Date.now() });
  return origFillText.apply(this, arguments);
};
```

### 控制动画与刷新

快速变动的动画或游戏，可通过脚本控制 `requestAnimationFrame`，或调用页面内部暴露的方法，实现按步推进。

## 视觉标注与模拟操作

### 标注截图与局部切片

没有 DOM 的界面上：

- `capture_page(mode=som)` 获取带角标的截图，辅助判断点击位置
- 核验局部细节时用 `capture_page(mode=element, selector="canvas")` 查看切片

### 模拟连续鼠标与键盘

- 绘制或拖拽按完整时序执行：`pointerdown` → `pointermove`（平滑移动）→ `pointerup`
- 键盘用 `press(key, tabId)`，两次按键间隔约 100~200ms，避免事件被页面丢弃

操作后结合截图与任务完成条件验证；证据不足时继续核实，不宣称成功。
