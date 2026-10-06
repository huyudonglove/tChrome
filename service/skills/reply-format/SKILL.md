SUMMARY: 侧栏回复呈现：按信息需要选择 Markdown、轻量按钮或 iframe 组件，并区分展示与真实执行。
# 侧栏回复格式

finishTurn.text 必须是非空的最终答复，同一 text 进入侧栏、上下文和压缩链路。先写清结果、依据和未完成项，再选择有助于用户理解或操作的呈现形式。

## 选择呈现能力

- 普通解释、结果和步骤使用 GFM：段落、列表、表格、代码、链接和图片。
- 排版需要时可用展示用 HTML。扩展 CSP 禁止内联脚本和事件属性，普通 HTML 中的 onclick、onerror、javascript: 不执行。
- 打开链接、复制文本和简单本地展示变化使用 data-* 按钮。
- 需要自定义脚本交互时，将完整 HTML 与 JS 放入 tchrome-widget，由独立 iframe 页面运行。

## 轻量交互

| 目的 | 写法 |
| --- | --- |
| 打开链接 | Markdown 链接，或 button 的 data-open-url 属性 |
| 复制文本 | button 的 data-copy 属性 |
| 随机展示一项 | data-action="pick"、data-items="选项一&#124;选项二"、data-target="result" |
| 数字加一 | data-action="count"、data-target="count" |
| 设置展示文字 | data-action="set"、data-value="新文字"、data-target="result" |

data-target 指向同一条回复内已有元素的 id；计数目标初始内容应为数字。pick 的选项用竖线分隔。所有动态文字正确转义为 HTML 文本或属性，避免引号破坏结构。

这些动作只执行对应的链接、复制或展示逻辑。例如把文字改为“已保存”不会执行保存请求；不要将界面演示当成业务操作已完成。

## iframe 组件

用 <tchrome-widget> 包裹需要运行的完整 HTML 与 JS。侧栏会将组件提交到本机服务，并在独立页面上下文的 iframe 中加载；脚本可以在组件内执行，不自动获得侧栏 DOM 或扩展权限。普通轻量按钮不需要这一层。

依据用户真实数据制作内容；缺失数据应明确说明，不编造结果。组件中涉及真实数据修改或对外操作时，仍遵循任务授权与 <boundaries>。

## 检查实际结果

简单文本检查内容和链接即可。交互组件需要检查目标 id、属性和脚本对应关系；有可用的预览或浏览器环境时，实际操作关键路径，根据报错修正。没有运行过就说明验证范围，不把代码生成成功称为交互已验证。
