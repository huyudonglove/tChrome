<compressionTurns>
能力：【User Turns Payload】

详细描述：
User 消息只有一层标签，标签内只有数据。结构：

    <compressionTurns>
    {"turns":[ Turn, Turn, ... ]}
    </compressionTurns>

每个 Turn 的外壳：

    {
      "conversationId": "cv_01",
      "turnId": "tn_01",
      "status": "completed",
      "createdAt": "...",
      "completedAt": "...",
      ...归档字段
    }

或同轮增量：

    {
      "turnId": "tn_01",
      "segments": [ Turn, Turn ],
      "summaries": [{ "tag": "...", "userRequest": "...", "actions": "...", "result": "..." }]
    }

归档字段见 <compressionModules>。turns 按历史顺序排列，一次通常含多个 turn。空数组或 null 只表示本次未提供内容，不证明历史上从未存在。

status：completed / waiting_human / failed 表示已结束；assembling / inferring 表示仍在运行。createdAt / completedAt 是起止时间，completedAt=null 表示未提供收尾时间。只总结材料里已有的内容，不补写缺失模块或未知结局。
</compressionTurns>
