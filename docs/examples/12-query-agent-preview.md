# 模块归档与查询 Agent：完整数据模拟

> 这是实现前讨论时的历史模拟，包含当时的接口与字段。当前实现和边界请看 [07 模型压缩与委托查询](07-compress.md)，实际 System/User 示例见 03 和 04。

这是待实现方案的虚构数据，`context.query` 是拟定名称。模块目录、查询 Agent 和下面的响应结构尚未接入实际运行。未调用模型，也未修改真实会话数据。

## 1. 主 Agent 看到的 User

保留现有 17 个栏目顺序。摘要带可读 tag，完整内容隐藏归档 ID。此处较早的两条用户原话已由摘要覆盖，历史原文窗口只留下较新的输入，避免重复覆盖。tag 不要求唯一；主 Agent 可以复制它，也可以用自己的话描述主题。

```text
#skill

## 网页观察与操作

按下一步的信息需求选择最少必要的网页观察，由概况逐步缩小到相关区域或控件；已有明确目标和足够证据时直接操作，不必每次重走完整观察流程。各工具的能力、参数和返回见工具说明。

元素和区域 id 按可见节点顺序临时编号；导航、可见控件或区域增删、顺序变化后重新获取。已有证据表明变化不影响编号时，可复用对应标签的定位信息，单纯切回标签无需重走观察流程。

页面验证针对用户的业务目标：点击或输入成功只表示动作已执行，提交、保存等结果还需工具返回或页面状态确认。

#userInput

核对一下任务 42 的负责人和状态，然后告诉我结果。

#userInputHistorySummary

[
  {
    "tag": "任务42／负责人调整／状态限制",
    "summary": "用户要求将任务 42 的负责人改为李明，保持待处理状态；修改后重新读取详情核对。"
  }
]

#userInputHistory

[
  "保存之后再确认一次。"
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

page.get_summary：读取当前页面摘要，可传 tab 指定标签。
context.query：委托查询 Agent 查找历史原文。
参数：module（待查询模块）、tag（主题或语义线索）、question（需要核实的具体问题）。
返回：匹配记录的原文及必要的时间背景；未找到时明确返回未找到。不会重新执行历史工具或刷新网页。

```

## 2. 本地按模块存放

以下为拟定目录。演示路径不是现有文件。归档的完整内容与清单分开保存；目录不存大段原文。

```text
conversations/cv_demo/
  compression/
    userInputHistory/
      index.json
      records/
        cmp_input_001.json
        cmp_input_002.json
      sources/
        input_001.json
        input_002.json
        input_003.json
    pageObservedHistory/
      index.json
      records/
      sources/
    conversationMemory/
      index.json
      records/
      sources/
    toolIO/
      index.json
      records/
      sources/
```

`index.json`（用户输入模块）：

```json
{
  "module": "userInputHistory",
  "entries": [
    {
      "id": "cmp_input_001",
      "tag": "任务42／负责人调整／状态限制",
      "description": "任务 42 的最初修改要求：只改负责人，状态保持待处理。",
      "level": 1,
      "createdAt": "2026-09-11T05:03:00Z"
    },
    {
      "id": "cmp_input_002",
      "tag": "任务42／验收方式／重新核对",
      "description": "后续补充：保存后重新读取详情，不仅凭保存成功提示报告完成。",
      "level": 1,
      "createdAt": "2026-09-11T05:05:00Z"
    }
  ]
}
```

`records/cmp_input_001.json`（一次压缩的内容、tag 和来源）：

```json
{
  "id": "cmp_input_001",
  "tag": "任务42／负责人调整／状态限制",
  "description": "任务 42 的最初修改要求：只改负责人，状态保持待处理。",
  "level": 1,
  "createdAt": "2026-09-11T05:03:00Z",
  "module": "userInputHistory",
  "summary": "用户要求任务 42 的负责人改为李明，状态保持待处理。",
  "sources": [
    {
      "kind": "userInput",
      "id": "input_001"
    },
    {
      "kind": "userInput",
      "id": "input_002"
    }
  ]
}
```

`sources/input_002.json`（保持完整的原始记录）：

```json
{
  "id": "input_002",
  "turnId": "tn_02",
  "userInput": "只修改负责人，状态保持待处理。",
  "submittedAt": "2026-09-11T05:01:00Z"
}
```

实际实现时可引用已有的不可变原始记录存储，无需再复制一份正文；图中的 sources 表示模块的原文来源集合。文件路径由 runtime 根据合法 ID 解析，不由模型指定。

## 3. 主 Agent 发起查询

主 Agent 不需要知道 cmp_input_001 或 input_002，也不必准确复制 tag。

```json
{
  "name": "context.query",
  "arguments": {
    "module": "userInputHistory",
    "tag": "任务42／负责人调整／状态限制",
    "question": "用户是否允许修改状态？需要当时的原话。"
  }
}
```

## 4. runtime 给查询 Agent 的输入

查询 Agent 只读取指定模块的目录，以及本次查询条件。大型目录应按层级和候选范围分批提供，避免把完整历史重新塞入上下文。

```json
{
  "module": "userInputHistory",
  "tag": "任务42／负责人调整／状态限制",
  "question": "用户是否允许修改状态？需要当时的原话。",
  "catalog": [
    {
      "id": "cmp_input_001",
      "tag": "任务42／负责人调整／状态限制",
      "description": "任务 42 的最初修改要求：只改负责人，状态保持待处理。",
      "level": 1,
      "createdAt": "2026-09-11T05:03:00Z"
    },
    {
      "id": "cmp_input_002",
      "tag": "任务42／验收方式／重新核对",
      "description": "后续补充：保存后重新读取详情，不仅凭保存成功提示报告完成。",
      "level": 1,
      "createdAt": "2026-09-11T05:05:00Z"
    }
  ]
}
```

查询 Agent 返回内部匹配结果：

```json
{
  "status": "matched",
  "ids": [
    "cmp_input_001"
  ]
}
```

本例第一项直接包含修改限制；第二项主要涉及验收方式，因此无需返回。问题涉及两者时，可以返回两个 ID。目录证据不足时允许继续查阅候选内容，而不是把关键词命中当成确定匹配；仍找不到则返回 `status=not_found, ids=[]`。

## 5. runtime 读取并返回主 Agent

runtime 校验 ID 确实属于该模块，读取压缩记录的来源关系，再读取完整原文。多条匹配按来源时间排列，同一来源只返回一次。模型不生成或改写原文。

主 Agent 最终收到：

```json
{
  "status": "found",
  "module": "userInputHistory",
  "matches": [
    {
      "tag": "任务42／负责人调整／状态限制",
      "content": [
        {
          "submittedAt": "2026-09-11T05:00:00Z",
          "userInput": "把任务 42 的负责人改成李明。"
        },
        {
          "submittedAt": "2026-09-11T05:01:00Z",
          "userInput": "只修改负责人，状态保持待处理。"
        }
      ]
    }
  ]
}
```

由此可回答：用户明确要求“只修改负责人，状态保持待处理”，没有授权修改状态。这里保留时间是为了说明原话先后，并没有把内部 ID 再暴露给主 Agent。

## 6. 摘要再次压缩时

如果两份一级摘要后续被二级摘要覆盖，旧文件继续保留。二级记录示意：

```json
{
  "id": "cmp_input_101",
  "module": "userInputHistory",
  "tag": "任务42／修改约束与验收",
  "level": 2,
  "summary": "任务 42 只修改负责人为李明，保持待处理，并在保存后重新核对详情。",
  "sources": [
    {
      "kind": "compression",
      "id": "cmp_input_001"
    },
    {
      "kind": "compression",
      "id": "cmp_input_002"
    }
  ]
}
```

User 只展示未被覆盖的摘要。查询 Agent 可以沿目录层级筛选；选中二级记录后，runtime 按来源关系展开到原始记录，去重后返回。覆盖关系和索引更新在文件成功落盘后由 runtime 提交。

本例结果较小，可以一次返回完整原文。大量命中时应先让查询 Agent 缩小范围或分批读取，返回结果明确说明是否完整，避免一次查询又撑满主 Agent 的上下文。

## 7. System 中需要的查询说明

> 历史摘要按模块提供 tag 和摘要正文。需要核实被压缩内容时，调用 context.query，提供模块、主题线索与具体问题。tag 按语义匹配，不要求精确一致。查询结果来自历史记录，不代表当前页面状态；未找到不代表该事实不存在。内部目录与记录 ID 由查询 Agent 和 runtime 管理。

这份说明是拟定内容，尚未写入实际 System 模块。
