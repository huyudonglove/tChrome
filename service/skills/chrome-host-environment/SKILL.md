SUMMARY: Chrome 宿主环境排查：按故障线索确认实际 Profile 和配置，用运行时行为验证判断。
# Chrome 宿主环境

当页面工具无法解释休眠、权限或下载行为，或目标位于受限特权页面时，使用宿主文件和进程证据补充调查。普通网页操作无需先检查浏览器全部配置。

## 选择证据

先确认正在使用的浏览器、操作系统和 Profile；不要把 Default 当成已确认的当前 Profile。按需通过 catalog_add 加载 local_fs_read 等宿主工具，路径中的主目录或环境变量展开为绝对路径。

| 系统 | Chrome 配置位置 |
| --- | --- |
| macOS | ~/Library/Application Support/Google/Chrome/<Profile>/Preferences；同级用户数据目录的 Local State |
| Linux | ~/.config/google-chrome/<Profile>/Preferences；同级用户数据目录的 Local State |
| Windows | %LOCALAPPDATA%\Google\Chrome\User Data\<Profile>\Preferences；同级用户数据目录的 Local State |

只读取与当前问题有关的字段。已有返回沿 callId 用 evidence_search 的 keyword 或 blockId 取回；记录确认的路径、字段值和仍需验证的判断。

## 将配置与现象对照

- 后台标签丢失 DOM 或调试连接：检查休眠现象及 performance_tuning.high_efficiency_mode.state、site_exceptions 等相关设置。
- 弹窗或剪贴板失败：结合实际权限错误，查看 profile.content_settings.exceptions 下对应站点规则。
- 下载流程阻塞：查看 download.prompt_for_download，并核验实际下载行为。
- 无障碍树异常：accessibility.screen_reader_detected 等字段可作为线索，仍需检查当前页面树与实际渲染。

字段及含义可能随 Chrome 版本和策略变化；字段缺失不能直接证明功能关闭，磁盘值也不等于当前运行时已经生效。用实际行为或浏览器设置界面确认影响，证据已足够时继续任务。

## 调整与验证

配置修改依据用户授权和 <boundaries>。Chrome 运行时可能覆写磁盘配置，部分字段还有完整性校验；优先通过受支持的设置界面或启动参数调整，不在运行期间直接改 Preferences 或 Local State。调整后复现原操作，确认目标现象是否改变；失败时根据新证据继续定位。

分析副本与笔记放在 <overview> 的服务数据目录，仅保留任务需要的信息，不把配置中的敏感内容整份写进回复。
