<compressionModules>
能力：【Archive Fields In Turns】

详细描述：
下列字段出现在 User 的 { "turns": [...] } 材料里。我只总结已提供的字段。

{{archiveFields}}

材料对象外层还包含 conversationId、turnId、status、createdAt、completedAt、sequence、segment。不参与压缩、也不会出现在 turns 材料里的主 Agent 窗口模块：skill、summary、currentTabs、projectMemory、notes、lastAction、activeContext、plan、currentQuery、tools。

Sample（一次请求只含一个完整轮次的骨架，仅示例）：

    {
      "turns": [
        {
          "conversationId": "cv_01",
          "turnId": "tn_01",
          "status": "completed",
          "createdAt": "...",
          "completedAt": "...",
          "userInput": { "id": "input_01", "turnId": "tn_01", "userInput": "打开导出页", "submittedAt": "..." },
          "toolIO": [
            { "callId": "call_02", "turnId": "tn_01", "name": "page_get_summary",
              "arguments": { "tabId": 12, "reason": "读概况" },
              "return": { "stage": "complete", "totalChars": 18, "text": "{\"ok\":true}" } }
          ],
          "observations": [
            { "id": "page_01", "turnId": "tn_01", "callId": "call_02", "tabId": 12, "type": "page_get_summary",
              "result": { "ok": true, "description": "支持 CSV" } }
          ],
          "workspace": [
            { "id": "ws01", "turnId": "tn_01", "boundId": "b02", "callId": "call_02", "callIds": ["call_02"],
              "op": "读了导出页概况", "value": "页面支持 CSV" }
          ],
          "memoryWrites": [],
          "queryHistory": [],
          "reflection": { "turnId": "tn_01", "items": [{ "id": "rf_01", "text": "已确认页面支持 CSV；未下载文件二次核验。", "focus": "证据" }] },
          "stopReason": { "kind": "reply", "text": "1. 列表已出现新记录\n2. 提交成功\n3. 无需回滚" },
          "sequence": { "turn": 0, "batch": 2 },
          "segment": { "complete": true }
        }
      ]
    }

同轮增量 Sample（segments 是同轮切块；这里的 summaries 是同轮已有摘要，没有 turnId，不是提交参数）：

    {
      "turns": [
        {
          "turnId": "tn_03",
          "segments": [
            { "conversationId": "cv_01", "turnId": "tn_03", "status": "completed", "toolIO": [], "reflection": null, "stopReason": { "kind": "tool", "name": "page_click", "callId": "call_08" } }
          ],
          "summaries": [{ "tag": "导出", "userRequest": "导出本月报表", "actions": "打开导出页", "result": "页面支持 CSV" }]
        }
      ]
    }
</compressionModules>
