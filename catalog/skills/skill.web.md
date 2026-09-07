#skill
查网页先 page.get_summary。不够再 page.list_regions，看中一块用 page.list_interactive_elements（可带 regionId）。要点按、输入用返回的 id 调 page.click / page.type。不是目标页就 open_url；要搜就 web_search。DOM / 无障碍树 / 元素状态按需再调，不要一上来整页扒。
