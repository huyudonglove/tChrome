# 图片存储与模型输入

截图工具返回的 PNG/JPEG data URL 经 runtime 处理后，二进制保存到会话目录 `images/img_01.png|jpg`，图片 ID 由统一会话计数器分配，相同图片去重。内容哈希保存在内部 `images/index.json`，用于读取校验，不进入模型引用。单张最多20 MiB；工具返回、toolIO、事件、归档和 provider.md 仅保存 id、相对路径、格式、尺寸及字节数。

每次主模型请求先按最近一次模型返回的工具批次选择图片，再进入文本压缩和裁剪判断。同批产生的图片全部携带，逐张标明 callId、图片 ID 和路径；旧批次只保留 toolIO 中的本地引用。无图片批次或新用户回合不附带历史图片。ChatMessage.images 携带本批次引用，Provider 在发送 HTTP 请求时读取并校验文件，构造 Chat 的 text/image_url 或 Responses 的 input_text/input_image；Base64 只出现在发送给模型的请求中。provider.md 单独记录图片引用，不记录请求里的编码。文本上下文字符阈值不计图片的模型 token 用量。

此链路支持工具截图供模型观察；不提供侧栏上传、粘贴图片的入口。实际视觉能力由上游模型和网关决定。图片引用统一使用短 ID，不读取旧长哈希 ID。删除会话会删除其图片文件，其他会话不能借引用读取它。
