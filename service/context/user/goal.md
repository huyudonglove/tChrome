#goal
能力：【Main Goal, Current Subgoal】

详细描述：
currentGoalId 指向当前目标，未选择时为 null；goals 保留全部 active 目标及其父级记录。总目标使用 goal_ 编号、parentId=null，子目标使用 subgoal_ 编号、parentId 指向总目标；id 固定，status 表示 active/completed/cancelled。阶段切换时用 submitGoal 新建或选中子目标，完成或取消须明确提交，不因切换自动结束旧目标。具体尝试放 #notes，已确认的阶段结论放 #conversationMemory；目标文字和状态本身不是完成证据。

内容：
{{data}}
