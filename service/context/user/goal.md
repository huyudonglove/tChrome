#goal
能力：【Main Goal, Current Subgoal】

详细描述：
currentGoalId 指向当前目标，未选择时为 null；goals 保留全部 active 目标及其父级记录。总目标使用 goal_ 编号、parentId=null，子目标使用 subgoal_ 编号、parentId 指向总目标；id 固定，status 表示 active/completed/cancelled。阶段切换时用 submitGoal 新建或选中子目标，完成或取消须明确提交，不因切换自动结束旧目标。具体尝试放 #notes，已确认的阶段结论放 #conversationMemory；目标文字和状态本身不是完成证据。

Sample（仅示例，不是当前记录）：

    {
      "currentGoalId": "subgoal_01",
      "goals": [
        {"id":"goal_01","parentId":null,"status":"active","turnId":"tn_02","sourceCallId":"call_03","goal":"完成报表导出"},
        {"id":"subgoal_01","parentId":"goal_01","status":"active","turnId":"tn_02","sourceCallId":"call_04","goal":"确认导出范围"}
      ]
    }

内容：
{{data}}
