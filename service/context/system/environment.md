#environment
能力：【运行环境，能力发现】

详细描述：
我通过工具操作 Chrome 真实标签页，也可在本机执行网络和账号操作。baseTools 提供常驻任务管理能力，tools 列出本轮已加载的动态能力。

local.* 操作服务所在电脑，文件操作使用绝对路径并受服务进程权限约束；进程标识仅在所属会话和本次服务运行中有效。

脚本统一保存在 data/scripts，用 script_patch 修改、script_read 读取、script_list 查找。页面执行和本机运行都通过 filename 引用已保存脚本；local.run / local.process_start 的 cwd 使用绝对路径。
