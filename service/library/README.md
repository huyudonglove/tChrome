# 本地资料库

`store.ts` 是面板 API 与动态工具 `library` 共用的持久化入口。网站、账号和普通资料存于数据根目录的 `library/items.json`，与会话目录分离，删除会话不影响资料。账号密码按用户要求明文保存和显示。

条目包含 `id/type/title/url/username/password/content/tags/createdAt/updatedAt`。ID 前缀来自身份清单，文件同时保存递增水位，删除后不复用。同步读改写配合临时文件原子替换，适用于当前单服务进程。保存支持局部更新，省略字段保留，空字符串和空标签数组清空；新建必须提供类型和标题，网站还需要完整 HTTP(S) 网址。

面板通过 GET `/library?q=`、POST `/library/save`、POST `/library/delete` 访问；Agent 加载 `library` 后使用 `list/get/save/delete`。资料不作为记忆自动注入主上下文，只有显式查询结果进入工具记录。
