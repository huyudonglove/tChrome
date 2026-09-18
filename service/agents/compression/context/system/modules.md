<compressionModules>
能力：【Archive Fields In Turns】

详细描述：
下列字段出现在 User 的 { "turns": [...] } 材料里。我只总结已提供的字段。字段形状如下。

{{archiveFields}}

不参与压缩、也不会出现在 turns 材料里的主 Agent 窗口模块：skill、当前这一轮的 <userInput>、conversationHistorySummary、goal（active 视图）、openTabs、projectMemory、notes、lastAction、checklist、currentQuery、tools。

Sample（一批材料含两个完整轮次的骨架，仅示例；真实批次可能更多轮）：

    {
      "turns": [
        {
          "conversationId": "cv_01",
          "turnId": "tn_01",
          "status": "completed",
          "createdAt": "...",
          "completedAt": "...",
          "userInput": { "id": "input_01", "turnId": "tn_01", "userInput": "打开导出页", "submittedAt": "..." },
          "goalChanges": [],
          "toolIO": [
            { "callId": "call_02", "turnId": "tn_01", "name": "page.get_summary",
              "arguments": { "tabId": 12, "reason": "读概况", "affectsPage": false },
              "return": { "stage": "complete", "totalChars": 18, "text": "{\"ok\":true}" } }
          ],
          "pageObservations": [
            { "id": "page_01", "turnId": "tn_01", "callId": "call_02", "tabId": 12, "type": "page.get_summary",
              "result": { "ok": true, "description": "支持 CSV" } }
          ],
          "memoryWrites": [],
          "queryHistory": [],
          "output": { "kind": "reply", "text": "页面支持 CSV。" }
        },
        {
          "conversationId": "cv_01",
          "turnId": "tn_02",
          "status": "completed",
          "createdAt": "...",
          "completedAt": "...",
          "userInput": { "id": "input_02", "turnId": "tn_02", "userInput": "记下 CSV 偏好", "submittedAt": "..." },
          "goalChanges": [],
          "toolIO": [
            { "callId": "call_04", "turnId": "tn_02", "name": "memory.write",
              "arguments": { "layer": "conversation", "text": "用户偏好 CSV" },
              "return": { "stage": "complete", "totalChars": 12, "text": "{\"ok\":true}" } }
          ],
          "pageObservations": [],
          "memoryWrites": [
            { "memoryId": "mm_01", "turnId": "tn_02", "layer": "conversation", "text": "用户偏好 CSV", "sourceCallId": "call_04", "createdAt": "..." }
          ],
          "queryHistory": [],
          "output": { "kind": "reply", "text": "已记下 CSV 偏好。" }
        }
      ]
    }

同轮增量 Sample（segments 是同轮切块，summaries 是同轮已有摘要）：

    {
      "turns": [
        {
          "turnId": "tn_03",
          "segments": [
            { "conversationId": "cv_01", "turnId": "tn_03", "status": "completed", "toolIO": [], "output": { "kind": "tool", "name": "page.click", "callId": "call_08" } }
          ],
          "summaries": [{ "tag": "导出", "userRequest": "导出本月报表", "actions": "打开导出页", "result": "页面支持 CSV" }]
        }
      ]
    }
</compressionModules>
