<compressionModules>
能力：【Archive Fields In Turns】

详细描述：
下列字段出现在 User 的 { "turns": [...] } 材料里。我只总结已提供的字段。

{{archiveFields}}

不参与压缩、也不会出现在 turns 材料里的主 Agent 窗口模块：skill、当前 userInput 槽、conversationHistorySummary、goal（active 视图）、openTabs、projectMemory、notes、lastAction、checklist、currentQuery、tools。

Sample（一批材料含两个 turn 的骨架，仅示例；真实批次可能更多轮）：

    {
      "turns": [
        {
          "turnId": "tn_01",
          "status": "completed",
          "userInput": { "id": "input_01", "turnId": "tn_01", "userInput": "打开导出页", "submittedAt": "..." },
          "toolIO": [
            { "callId": "call_02", "name": "page.get_summary",
              "return": { "stage": "complete", "text": "{\"ok\":true}" } }
          ],
          "pageObservations": [
            { "id": "page_01", "callId": "call_02", "type": "page.get_summary",
              "result": { "ok": true, "description": "支持 CSV" } }
          ],
          "output": { "kind": "reply", "text": "页面支持 CSV。" },
          "sequence": { "turn": 0, "batch": 2 },
          "segment": { "complete": true }
        },
        {
          "turnId": "tn_02",
          "status": "completed",
          "userInput": { "id": "input_02", "turnId": "tn_02", "userInput": "记下 CSV 偏好", "submittedAt": "..." },
          "toolIO": [
            { "callId": "call_04", "name": "memory.write",
              "return": { "stage": "complete", "text": "{\"ok\":true}" } }
          ],
          "memoryWrites": [
            { "memoryId": "mm_01", "turnId": "tn_02", "text": "用户偏好 CSV", "sourceCallId": "call_04" }
          ],
          "output": { "kind": "reply", "text": "已记下 CSV 偏好。" },
          "sequence": { "turn": 1, "batch": 3 },
          "segment": { "complete": true }
        }
      ]
    }
</compressionModules>
