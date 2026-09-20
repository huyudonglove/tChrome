## 回复格式（本地侧栏）

侧栏用 GFM + HTML 渲染 finishTurn.text。**扩展 CSP 禁止内联 JS**：`onclick` / `javascript:` 一律不执行（属性会被去掉）。后续上下文与压缩使用同一 text。

### 展示

- 标题、列表、表格 `| |`、图片 `![](url)`、代码、链接 `[文字](https://…)`
- 展示用 HTML（div/style 等）可以

### 可点击（必须用 data-\*，禁止 onclick）

| 目标 | 写法 |
|---|---|
| 打开链接 | `[文字](https://…)` 或 `<button data-open-url="https://…">` |
| 复制 | `<button data-copy="文本">复制</button>` |
| **随机抽一条** | `<button data-action="pick" data-items="内容A\|内容B\|内容C" data-target="outId">抽取灵感</button>` 且页面有 `<div id="outId">…</div>` |
| **计数 +1** | `<button data-action="count" data-target="cntId">功德 +1</button>` 且有 `<span id="cntId">0</span>` |
| 置为固定文案 | `<button data-action="set" data-value="你好" data-target="outId">` |

`data-target` 是**同一条回复内**的元素 id。不要写 `onclick`、`onerror` 或依赖 `document.getElementById` 的脚本。

### 示例：灵感胶囊（可用）

```html
<div>
  <div id="capsule-out">点击下方按钮抽取</div>
  <button data-action="pick" data-target="capsule-out" data-items="🎯 突破：打破常规|🪐 火星日落是蓝色的|🎲 灵感指数 99.8%">抽取灵感</button>
  <span id="merit">0</span>
  <button data-action="count" data-target="merit">功德 +1</button>
</div>
```

### 互动组件（iframe，可跑 JS）

复杂交互（onclick 动画、计数、随机抽签等）请包在：

```html
<tchrome-widget>
  <!-- 完整 HTML+JS，可含 script / onclick -->
  <button onclick="...">抽取灵感</button>
</tchrome-widget>
```

侧栏会把块 POST 到本机服务，在 **iframe（独立页面上下文）** 里加载 `http://127.0.0.1:18788/widget/...`，**不走扩展 CSP**，脚本可执行。

| 写法 | 侧栏行为 |
|---|---|
| `[文字](https://…)` / `data-open-url` | 新标签打开 |
| `<tchrome-widget>…HTML+JS…</tchrome-widget>` | **iframe 内可点击/可脚本** |
| 无包装的 `<button onclick>` | 仍不会执行（扩展 CSP） |

轻量动作仍可用 `data-action` / `data-copy`（见上），不必进 iframe。
