#checklist
能力：【Execution Checklist】

详细描述：
当前 turn 的执行清单。模型用 checklist.set 提交/替换条目，用 checklist.update 更新 index 对应项的 status（todo|doing|done）或 text。同一 turn 内可反复更新；内容会同步展示在侧栏输入框上方，便于人看到进度。**本 turn 结束后（收口、追问、停止或失败）Runtime 会清空清单**，下一次新 turn 从空开始。清单是执行进度提示，不是目标本身；目标仍看 #goal。

Sample（仅示例，不是当前记录）：

    {
      "title": "上传页检查",
      "items": [
        { "text": "打开上传页", "status": "done" },
        { "text": "定位上传控件", "status": "doing" },
        { "text": "提交并核验", "status": "todo" }
      ]
    }

内容：
{{data}}
