<queryTurns>
能力：【User Query Payload】

详细描述：
User 消息只有一层标签，标签内只有数据。结构：

    <queryTurns>
    {"request":{...},"turns":[ Turn, Turn, ... ]}
    </queryTurns>

字段语义在 <queryModules>。request 标识本次查询入口；turns 是本次候选，一次完整提供。提交的 turnIds 从这些 Turn 外壳上的 turnId 原样复制。空数组只表示本次没有候选轮次，不证明历史上从未存在。
</queryTurns>
