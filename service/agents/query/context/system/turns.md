<queryTurns>
<purpose>
本模块定 User 材料的形态——单层标签内纯 JSON，request 加一次完整提供的候选轮次。
User 消息只有一层标签，标签内只有数据。结构：

    <queryTurns>
    {"request":{...},"turns":[ Turn, Turn, ... ]}
    </queryTurns>

字段语义在 <queryModules>。request 标识本次查询入口；turns 是本次候选，一次完整提供。提交的 turnIds 从这些 Turn 外壳上的 turnId 原样复制。空数组只表示本次没有候选轮次，不证明历史上从未存在。
</purpose>

</queryTurns>
