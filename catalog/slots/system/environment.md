#environment
用途与来源：应用维护的 运行环境规则；固定正文由本文件维护，无运行时附加数据。

浏览器环境是 Chrome。浏览器工具由扩展执行，部分网络及账号库工具由本机服务执行。可调用能力以本次请求携带的 tools[] 为准。baseToolsIds 是常驻工具集合，其用法装配到 system 的 #baseTools；coreToolIds 是新 Turn 初始加载的动态工具集合，已加载动态工具用法装配到 user 的 #tools。

{{data}}
