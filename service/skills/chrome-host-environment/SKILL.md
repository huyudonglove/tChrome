TAGS:
- chrome
- 配置
- 宿主
- 只读
# Chrome 本机宿主环境感知 (Host Environment)

扩展沙箱限制访问 `chrome://settings` 或受特权页面隔离时，切换宿主物理视角，用 `local.fs_read`（需 `catalog.add`）读取磁盘上的 Chrome 配置。调用时把下表 `~` 展开为本机主目录绝对路径；分析产物写在服务数据目录（见 `<overview>`）。

## 核心配置文件路径

- **macOS**
  - Profile 级：`~/Library/Application Support/Google/Chrome/<Profile>/Preferences`（默认 `Default`）
  - 全局/实验项：`~/Library/Application Support/Google/Chrome/Local State`
- **Linux**：`~/.config/google-chrome/<Profile>/Preferences`
- **Windows**：`%LOCALAPPDATA%\Google\Chrome\User Data\<Profile>\Preferences`

## 关键排查字段

- **后台休眠 (Memory Saver)**
  - `performance_tuning.high_efficiency_mode.state`：启用自动休眠时，长时间后台标签可能被挂起卸载，导致 DOM 丢失与 CDP 调试断开。
  - 排除域名白名单：`performance_tuning.high_efficiency_mode.site_exceptions`
- **权限与弹窗白名单 (Site Settings)**
  - `profile.content_settings.exceptions.popups` / `clipboard`：确认目标站点是否受弹窗拦截或剪贴板隔离阻碍。
- **静默下载 (Downloads)**
  - `download.prompt_for_download`：为 `false` 时下载不弹系统保存窗，避免阻塞操作链路。
- **无障碍树增强 (Accessibility)**
  - `accessibility.screen_reader_detected` 或无障碍高亮配置，辅助确认内核 A11y 树分发状态。

## 操作边界

- 配置路径使用展开后的绝对路径；改写 Preferences / Local State 需用户明确要求。
- 排查笔记、导出副本放在服务数据目录，不落在代码仓库。
- **只读探测为准**：Chrome 运行时常驻内存，退出或特定事件时会覆写磁盘文件，且部分安全字段含 HMAC 校验。严禁在浏览器运行期间直接篡改磁盘 JSON；环境调整优先提示用户在浏览器界面或启动参数中设置。
