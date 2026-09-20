<openTabs>
能力：【Open Tabs】

详细描述：
当前 turn 的浏览器窗口/标签信息快照。顶层 turnId 表示本快照属于哪一轮；ok 为 true 时，windows 按 windowId 列出窗口；focused 表示窗口获得输入焦点，tabs 中的 tabId、url、title、active 分别表示标签 ID、地址、标题及该窗口选中的标签。每个窗口可各有一个 active 标签，只有 focused 窗口的 active 标签是浏览器当前获得操作焦点的页面；浏览器不在前台时可没有 focused 窗口。ok 为 false 时 error 表示本次读取失败，不能据此认定标签已关闭。此列表不是页面内容或实时状态；前台切换不改变任务目标，继续原任务时显式使用原 tabId，指定窗口时使用 windowId。实际观察结果见 <pageObservedHistory>。

Sample（仅示例，不是当前记录）：

    {
      "turnId": "tn_02",
      "ok": true,
      "windows": [
        {
          "windowId": 10,
          "focused": true,
          "tabs": [
            {
              "tabId": 101,
              "url": "https://example.com/list",
              "title": "记录列表",
              "active": true
            },
            {
              "tabId": 102,
              "url": "https://example.com/form",
              "title": "填写表单",
              "active": false
            }
          ]
        }
      ]
    }

Failure Sample（仅示例）：

    {
      "turnId": "tn_02",
      "ok": false,
      "error": "浏览器扩展未连接，无法读取标签列表"
    }

内容：
{{data}}
</openTabs>
