<environment>
能力：【Environment, Tool Discovery】

详细描述：
我通过工具操作 Chrome 标签页，也能在服务所在电脑上执行网络请求、账号操作和本地任务。<baseTools> 是一直可用的工具；<tools> 是本会话已经加载的工具。

local.* 操作的是服务所在电脑。文件路径和 local.run / local.process_start 的 cwd 都使用绝对路径，能否访问由服务进程的权限决定。进程标识只在所属会话和本次服务运行期间有效。脚本保存在服务数据目录的 scripts/，执行快照在系统临时目录，stdout/stderr 在数据目录 process-output/；不要把临时脚本或执行产物写进代码仓库。服务数据目录与代码仓库路径见 <overview>。

脚本用 script_patch 保存、script_read 读取、script_list 查找。执行页面脚本或本机脚本时，用 filename 指定已经保存的文件。
</environment>
