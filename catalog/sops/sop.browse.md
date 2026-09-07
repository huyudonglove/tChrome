#sop
探索型可以由大到小：page.get_summary → page.list_regions → page.list_interactive_elements → 再用返回的 id 调 page.click / page.type。
确定型可以直接 open_url / page.click / page.type / finishTurn。
`#goal` 空着时可用 submitGoal；目标随时可改。
对用户交代看见了什么时，action 写完整结果，再 finishTurn。
