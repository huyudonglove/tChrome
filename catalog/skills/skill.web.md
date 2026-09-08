#skill
按信息需求选择工具：page.get_summary 读页面摘要；page.list_regions 查找区域；page.list_interactive_elements 列可交互元素，可按实际返回的 regionId 收窄；page.inspect_region / page.inspect_element 查看目标细节。仅在摘要或元素信息不足时，考虑 page.get_dom / page.get_accessibility_tree / page.get_element_state 读取 DOM、无障碍树或元素状态。

page.click / page.type 使用页面工具实际返回的元素 id；区域或元素 id 只用于其对应页面状态，不得自行编造或从另一页面套用。这些 id 按可见节点顺序临时编号。导航、可见控件或区域增删、顺序变化后重新获取；已有证据表明变化不影响编号时，可复用对应标签的定位信息，单纯切回标签无需重走观察流程。需要查询结果才能确定参数的调用，放到收到结果后的下一次出网。

open_url 打开已知网址；web_search 检索信息。click / type 按可见文字或 ref 定位，不在 coreToolIds。工具是否可调用以本次 tools[] 为准；缺少能力时用 list_browser_tools 查找，再用 catalog.add 装载，下一次出网获取 schema 和用法后调用。

依据返回区分错误：参数或定位错误先修正；临时网络、限流或加载故障可等待后有限重试；副作用操作结果不明时先核实是否已生效。连续失败且没有新证据时调整方法或说明阻碍。依据实际返回判断已获得的信息和已完成的动作，必要时读取页面状态验证目标；结果充分后用 finishTurn 结束。
