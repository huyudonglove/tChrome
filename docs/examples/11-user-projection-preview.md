# User 字段投影模拟

> 这是实现前讨论时的历史模拟，包含当时的接口与字段。当前实现和边界请看 [07 模型压缩与委托查询](07-compress.md)，实际 System/User 示例见 03 和 04。

使用 10-stable-records-preview.md 的同一份虚构数据，按模块精简发送视图。这里只生成设计预览，尚未修改运行时投影逻辑或本地记录。User 栏目名称和顺序保持当前 17 个模块。

本例 User 文本从 3054 字符变为 1530 字符，减少约 49.9%；这是字符比较，不是 token 统计。没有截取原话、页面描述或记忆正文。

## 模拟发送给模型的 User

```text
#skill

## 网页观察与操作

按下一步的信息需求选择最少必要的网页观察，由概况逐步缩小到相关区域或控件；已有明确目标和足够证据时直接操作，不必每次重走完整观察流程。各工具的能力、参数和返回见工具说明。

元素和区域 id 按可见节点顺序临时编号；导航、可见控件或区域增删、顺序变化后重新获取。已有证据表明变化不影响编号时，可复用对应标签的定位信息，单纯切回标签无需重走观察流程。

页面验证针对用户的业务目标：点击或输入成功只表示动作已执行，提交、保存等结果还需工具返回或页面状态确认。

#userInput

核对一下任务 42 的负责人和状态，然后告诉我结果。

#userInputHistorySummary

[]

#userInputHistory

[
  "把任务 42 的负责人改成李明。",
  "只修改负责人，状态保持待处理。"
]

#goal

重新读取任务 42 的详情，核对负责人为李明且状态仍为待处理，报告核对结果。

#goalHistory

[
  "将任务 42 的负责人改为李明，保持待处理状态。"
]

#currentPage

{
  "tab": 7,
  "url": "https://example.com/tasks/42",
  "title": "任务 42",
  "description": "负责人：李明；状态：待处理。"
}

#pageObservedHistorySummary

[]

#pageObservedHistory

[
  {
    "tab": 7,
    "url": "https://example.com/tasks/42",
    "title": "任务 42",
    "description": "负责人：李明；状态：待处理。"
  }
]

#projectMemory

[
  "用户偏好：修改后重新读取详情，再报告结果。"
]

#conversationMemorySummary

[]

#conversationMemory

[
  "用户明确要求任务 42 的状态保持待处理。"
]

#notes

{
  "replyDraft": "核对结果：任务 42 的负责人为李明，状态仍为待处理。"
}

#toolIOSummary

[]

#toolIO

[
  {
    "name": "page.get_summary",
    "arguments": {
      "reason": "核对保存后的任务详情"
    },
    "return": {
      "stage": "complete",
      "result": {
        "ok": true,
        "tab": 7,
        "url": "https://example.com/tasks/42",
        "title": "任务 42",
        "description": "负责人：李明；状态：待处理。"
      }
    }
  }
]

#observation

[]

#tools

page.get_summary：读当前页摘要：标题、地址、区域数、可交互数、标题列表。
参数：可选 tab（目标标签编号）。
返回：ok（是否成功）、title（页面标题）、url（页面地址）、regionCount、interactiveCount、headings、landmarkNames。
affectsPage=false。
```

## 这次精简了什么

- 当前输入和目标直接给正文；历史输入、历史目标、完整记忆用字符串数组，保留每条边界与旧到新顺序。
- 本例页面保留定位和理解需要的 tab、url、title、description，隐藏记录 ID、轮次、时间和来源字段。任务涉及时效或追踪来源时，由对应模块投影保留必要字段。
- 完整工具结果隐藏 callId、turnId、totalChars 和调度标记 affectsPage，保留工具名、reason、实际操作参数和结果状态。结果中的 JSON 直接展示为对象，避免字符串转义嵌套。stage=complete 仍只代表完整性，成功与否继续看结果中的 ok/error。
- 本地记录与关联 ID 均保留；本例展示的是完整内容，因此无需在窗口中暴露查询 ID。工具操作目标的 tab/ref/elementId 等不是归档元数据，不应按“包含 ID”统一删除。

## 需要回查时，ID 才进入视图

下面是另一个虚构场景：工具结果已被截断，必须保留 callId 和截断状态，便于通过现有 record.query(kind=tool) 读取完整结果。该 ID 仅作示例，不能查询本地真实记录。

```json
[
  {
    "callId": "demo_call_long",
    "name": "page.get_summary",
    "arguments": {
      "tab": 7,
      "reason": "检查任务详情"
    },
    "return": {
      "stage": "truncated",
      "text": "这里是已经截断的结果预览……"
    }
  }
]
```

未来摘要可以只暴露一个用于回查的摘要 ID，来源 ID 列表与层级保留在本地，查询工具负责展开。摘要生成与查询仍未实现，下例仅展示待确认的投影形态：

```text
#userInputHistorySummary

[
  {
    "id": "demo_summary_01",
    "summary": "用户要求仅将任务 42 的负责人改为李明，保持状态待处理；保存后重新核对详情。"
  }
]
```

## System 描述也需要同步

正式实现时，System 对各模块的说明应改为描述投影视图，例如“历史输入是按旧到新排列的原话数组；出现回查 ID 时可读取本地完整记录”。不能继续告诉模型每条记录都带 id、turnId 和时间。原始存储结构留在工程文档中。
