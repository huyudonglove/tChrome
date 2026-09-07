#sop
1. `#goal` 空着先 submitGoal
2. page.get_summary 认当前页
3. 要跳转就 open_url；要搜就 web_search
4. 再 page.list_regions；看中一块 page.list_interactive_elements
5. 要点按、输入用返回的 id 调 page.click / page.type
6. 对用户交代看见了什么，action 写完整结果，再 finishTurn
