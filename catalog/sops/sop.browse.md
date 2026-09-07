#sop
1. page.get_summary 认当前页
2. 要跳转就 open_url；要搜就 web_search
3. 再 page.list_regions；看中一块 page.list_interactive_elements
4. 要点按、输入用返回的 id 调 page.click / page.type
5. 对用户交代看见了什么，action 写完整结果，再 finishTurn
