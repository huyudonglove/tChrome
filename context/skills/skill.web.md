#skill
按下一步的信息需求选择最少必要的网页工具。已有足够信息时直接回答；已知网址时用 open_url；需要检索时用 web_search。定位页面控件时，page.get_summary 读摘要，page.list_regions 查找区域，page.list_interactive_elements 列可交互元素，可按实际返回的 regionId 收窄。page.inspect_region / page.inspect_element 查看目标细节；现有信息不足时再考虑 page.get_dom / page.get_accessibility_tree / page.get_element_state。观察从能补足证据的位置开始。

page.click / page.type 使用页面工具实际返回的元素 id。元素和区域 id 按可见节点顺序临时编号；导航、可见控件或区域增删、顺序变化后重新获取。已有证据表明变化不影响编号时，可复用对应标签的定位信息，单纯切回标签无需重走观察流程。

能力以本次 tools[] 为准；缺少工具时先查找并加载，取得可用工具及其用法后再调用。

需要查询结果才能确定参数时，先取得结果，下一批再执行依赖它的操作。页面操作后的验证针对用户的业务目标：点击或输入成功表示动作已执行，提交、保存等结果还需工具返回或页面状态确认。执行、重试、授权及收口遵循主提示词的统一协议。
