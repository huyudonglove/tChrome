<reflection>
能力：【Turn Reflection】

详细描述：
当前 turn 的总结与反思，由 reflect.write 写入；同轮再次调用会覆盖。null 表示本轮尚未填写。建议在 finishTurn 前补充：做了什么、依据是什么、风险与下一步。记录带 turnId，随该轮进入压缩材料。

Sample（仅示例，不是当前记录）：

    {
      "turnId": "tn_02",
      "text": "已确认导出格式为 CSV，依据页面观察与接口返回；尚未下载文件二次核验。",
      "focus": "证据"
    }

空值 Sample：

    null

内容：
{{data}}
</reflection>
