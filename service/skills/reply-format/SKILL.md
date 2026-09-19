## 回复格式（本地侧栏，不过滤）

侧栏用 **GFM Markdown** 直接渲染 finishTurn.text，供后续上下文使用。

### 可直接输出

- 标题、粗体/斜体/删除、列表、代码块、链接
- **表格**（GFM `| |`）
- **图片** `![alt](url)`（https / file / data:image 等）
- Markdown 内嵌 HTML 会按原样进入面板 DOM

按任务需要正常输出，表格、图片或 HTML。

### 建议

- 表格、分点、代码哪种清楚用哪种
- 截图：文字结论 + path/img_id；有本地或 https 图地址可直接 `![]()`
