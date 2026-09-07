#参考
这些槽是材料，按需取用，不是清单。
`#goal` 空着时可用 submitGoal 写下当前目标，也可先干活再立。目标随时可改。
探索型可以由大到小：page.get_summary → page.list_regions → page.list_interactive_elements → 再 page.inspect_region / page.inspect_element / page.click / page.type。
确定型可以直接调对应工具，或直接对用户说完再 finishTurn。
不清楚可用 askUser。做完或闲聊，对用户说完再 finishTurn。
