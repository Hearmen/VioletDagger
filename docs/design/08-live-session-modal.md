# LiveSessionModal：实时只读日志设计

需求依据为 requirements.md 3.1/3.3/3.5；页面集成见 07，日志协议见 06，生命周期见 03，日志来源见 04。本文描述目标设计，现有代码可能尚未同步。

## 1. 定位与目标

保留 LiveSessionModal 组件名，产品名称为“Session 实时日志”。用途是观察协作过程与排障；不提供原生 CLI 接管、终端输入、PTY、resize 或 xterm。人类指导通过房间 Composer，暂停/终止通过编排器控制。关闭弹窗仅关闭日志订阅。

AgentRail 的 running/stopping sessionId 打开弹窗。固定目标为 (roomId, sessionId)，不能跟随 agent 下一次 session。已打开弹窗在 session 结束后保留供查阅；完整消息和生命周期复盘使用 SessionDetailModal。

## 2. 组件职责

| 层 | 责任 |
|---|---|
| RoomDashboardPage | 固定打开目标、房间订阅、状态刷新、终止 RPC |
| LiveSessionModal | 头部、日志、连接状态、终止操作与错误 |
| SessionLogView | stdout/stderr 分色的纯文本展示、滚动、复制、内存窗口 |
| useSessionLog | 日志 WS、快照/增量去重、连接状态与释放 |

内部 props：target 包含 roomId/sessionId/agentId/startedAt；snapshot 包含 outcome/endedAt/exitCode/exitCause/exitWarning；另有 roomConnected、onTerminate(target)、onClose。不新增 RPC。

首次状态来自 AgentRail；roomStatus 时刷新。若该 agent 已空闲或切换下一 session，读取固定 session 的 getSessionDetail 元数据。不得把返回 rawLog 再重复加入实时日志。所有异步结果校验 target 键和请求序号，迟到响应不能覆盖新目标或已确认终态。

## 3. 布局与交互

沿用居中 modal 外壳：最大宽 1100px、最大高 86vh；头部展示 agent、sessionId、耗时、outcome、连接状态、终止与关闭按钮。提示区展示清理失败、断线、历史截断和日志读取错误；主体为可选择复制的纯文本日志。

运行时长在 endedAt 后冻结。默认跟随最新日志；用户上滚时保持位置并提示新增内容，点击“回到底部”恢复跟随。stdout/stderr 是来源标签，stderr 不自动判为任务失败。ANSI 仅作安全的显示清理，不执行控制序列，不渲染为 HTML，不解析答案。

Esc、点击遮罩本体或关闭按钮关闭弹窗；dialog 标注、焦点约束与关闭后焦点恢复遵循通用 modal。没有 CLI 键盘快捷键冲突，不捕获按键发送到服务端。

## 4. 状态与日志通道

| 场景 | 展示 |
|---|---|
| 建连中 | 连接中，保留已存在画面 |
| ready.source=live | 实时只读日志 |
| ready.source=snapshot | 日志快照；非终态时提示实时连接不可用 |
| stopping | 人工终止中，仍接收剩余日志 |
| cleanup_failed | 清理未确认，保留 stopping，允许重试终止 |
| end 帧 | 日志流结束；重新读取业务状态 |
| WS 无 end 即断开 | 连接已断开，保留内容，提示重新打开 |
| 业务终态 | 展示服务端 outcome 与退出信息，隐藏终止按钮 |

日志流结束与业务完成分别处理；快照读完不代表进程完成，exitCode 非零也不能代替 outcome。房间 WS 和日志 WS 独立：房间断线则禁用终止 RPC，日志可继续；日志断线不影响房间状态和终止操作。

## 5. 数据与资源生命周期

先安装日志消费者再建立 /logs?mode=live 连接。按 offset 顺序显示并去重；状态刷新不重建连接，不重放历史。服务端 ready.truncated 或客户端窗口裁剪时必须提示“仅显示部分日志，完整记录请查看详情”。

浏览器日志窗口上限建议 1 MiB，按完整事件裁剪；避免持续运行无限增长。关闭、切换目标、roomDeleted、页面卸载时注销订阅、关闭 WS、清理计时器。旧回调不得操作新目标，重复挂载与释放幂等。

日志 WS 不自动重连，关闭重开重新获得最近快照与增量。end 后保留已显示日志。后端历史日志格式兼容由 04/06 处理，前端只消费统一 data 帧。

## 6. 人工终止

running/stopping 可请求 terminateAgentSession({sessionId})，即使 room 已 completed 仍保留操作。房间连接不可用或同目标请求 pending 时禁用按钮。

请求后不乐观标记 terminated；服务端先置 stopping，确认退出后才结算。RPC 成功刷新固定目标；失败显示 toast 与弹窗内错误、重新读取状态，保留可重试入口。若同时收到终态，则显示终态而不是继续提示可终止。

关闭弹窗不撤销已发送的终止请求，页面继续处理其结果。终止不暂停 room，同 agent 可被再次派发，但本弹窗仍停留在原 session。

## 7. 竞态与验证

- 点击后进程先退出：接受 snapshot 回放并读取最终状态。
- agent 开始下一次调用：目标不变，输入能力始终不存在，终止不能改指向新 session。
- end 与 roomStatus 乱序：按固定目标状态结算，不从日志推断。
- 服务重启丢失句柄：展示快照，不伪造已完成。
- roomDeleted：关闭弹窗并回列表，不再读取删除的数据；删除清理失败则保留现场。
- 验收覆盖日志去重/截断、滚动锚定、双通道断线、终止重试、迟到请求、资源释放及无输入/resize 消息。
