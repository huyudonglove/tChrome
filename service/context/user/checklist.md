<checklist>
能力：【Execution Checklist】

详细描述：
当前 turn 的执行清单，顶层 turnId 表示清单所属轮次。尚无清单时为 null。用 checklist.set 提交或替换条目，用 checklist.update 更新 index 对应项的 status（todo|doing|done）或 text。同一 turn 内可反复更新。本 turn 结束后 Runtime 清空为 null，下一次新 turn 从空开始。清单是执行进度提示，不是目标本身；目标仍看 <goal>。

内容：
{{data}}
</checklist>
