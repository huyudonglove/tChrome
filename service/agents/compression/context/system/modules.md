<compressionModules>
能力：【Archive Fields In Turns】

详细描述：
下列字段出现在 User 的 { "turns": [...] } 材料里（Runtime 按主注册表 `service/context/modules.json` 中 compress=true 组装）。

- turnId（必读）：本轮 ID，摘要里原样复制。
- conversationId / status / createdAt / completedAt：会话与收尾时间；completedAt=null 表示未提供收尾时间。
- sequence: {turn, batch}，只用于排序。
- segment: {complete, batchIds?}。complete=true 表示整轮或最终剩余；false 表示增量片段，不能当成整轮。
- summaries（可选）：同轮此前已压缩的摘要；合并重复表述，仍每轮独立。
- segments（可选）：同轮连续增量材料数组。
- userInput: {id, turnId, userInput, submittedAt}——用户原话。缺省不表示用户没说话。
- goalChanges: 目标快照数组，含 id、parentId、status、goal、sourceCallId。
- toolIO: 工具调用数组。每项 callId/batchId/name/arguments；return 为 {stage, totalChars, text}。text 是账本正文；超量时可能是 externalized 摘要（含 preview/path/totalLines/lineWidth），不能假装看过全文。
- pageObservations: 页面观察数组。每项 id/turnId/callId/tabId/type/result。type 是工具名，result 是该次返回；与同 callId 的 toolIO 两份都读，不推断页面当前状态。
- memoryWrites: 会话记忆写入数组（memoryId、text、sourceCallId…）。记忆不能覆盖用户原话或执行证据。
- queryHistory: 历史查询数组；结论写入 result，不复制长原文。
- output: 本轮收尾。kind=reply → text；ask → question；error → faultCode；tool → name/callId；null 表示暂无收尾。

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
