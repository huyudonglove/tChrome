<notes>
能力：【Drafts, Candidates, Working Notes】

详细描述：
当前 turn 窗口内的草稿与中间材料。顶层 turnId 表示这些信息挂在本轮；notes 对象里 key 标识条目，notes.write 按 key 创建或覆盖，notes.delete 删除。按用途命名，避免复制整份 <goal> 或工作汇总。

Sample（仅示例，不是当前记录）：

    {
      "turnId": "tn_02",
      "notes": {
        "submissionCheck": "已看到成功提示，还需要确认列表中的记录。"
      }
    }

内容：
{{data}}
</notes>
