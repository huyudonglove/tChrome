#tools
用途与来源：Turn.assembled.toolIds 中已加载动态工具的用法。选择浏览器或服务工具前读取，用法结合实际 tools[] schema 确定参数；缺能力时通过 list_browser_tools 和 catalog.add 查找、加载，下一次出网才能使用。该槽由 Runtime 更新，名称出现于历史记录不等于本次已加载。
来源：对应 catalog/tools/*.json 的 function.description。这里只是 user 参考说明，不是 role=tool 消息；常驻工具仅在 system #baseTools。

新 Turn 从 coreToolIds 重新加载；此前 Turn 添加过的工具不保证仍可用。压缩时也可能裁去未使用的动态工具。catalog.add 更新 Turn.assembled.toolIds，下一次出网才带新增 schema；不要在添加工具的同一批调用它。

{{data}}
