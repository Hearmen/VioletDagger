# Web 前端设计

React + Vite。只消费 `06-orchestrator-api.md` 的 REST + WebSocket 接口，不直接碰存储/编排器核心。

**开发环境联调**：前端开发服务器（Vite，默认 `localhost:5173`）与后端（默认 `localhost:4200`，端口取自 `VIOLETDAGGER_HTTP_PORT`，见 `vite.config.ts`）是两个独立进程/端口。为避免引入 CORS 处理（`06-orchestrator-api.md` 本身没有为此设计任何 CORS 头，属于不必要的复杂度），开发模式下由 Vite dev server 做同源代理：`vite.config.ts` 配置 `server.proxy`，把 `/api` 开头的请求（含 WebSocket 升级，`ws: true`）转发到后端端口，前端代码里写的相对路径（`fetch('/api/...')`、`new WebSocket('ws://.../api/...')`）不需要关心后端实际跑在哪个端口。生产构建后静态文件由谁在什么端口托管、是否和后端同源部署，属于部署阶段的选择，不在本设计范围内。注意 Vite 会给"浏览器↔Vite"的 WS 套接字挂 error 监听并原样打 error：浏览器刷新/关页/切走时这条连接常被 RST，于是刷出 `ws proxy socket error: read ECONNRESET`——这是 dev 噪音（与后端/代码无关），`vite.config.ts` 用 `customLogger` 只过滤这一类（ECONNRESET/EPIPE 的 ws proxy 错误），其余错误照常打印。

**不引入 CSS 框架/UI 组件库、不新增运行时依赖**：样式用手写全局 CSS + CSS 变量实现。日志使用纯文本 SessionLogView，无需 xterm 或终端 addons。交互式 PTY 属于下一版本，本版本不做。

## 1. 信息架构

- `/`：RoomListPage——房间列表 + 新建房间。
- `/rooms/:roomId`：RoomDashboardPage——单个房间的完整工作视图。

房间视图是**单屏多面板看板**：agent 状态、消息流、记忆视图、事件树四个面板同屏常驻，页面本身不滚动，每个面板各自内部滚动。**不设标签页**——需求 3.1 要求"实时看着这一切发生"，切走一个面板就会漏掉实时更新，所以四个面板必须同时可见（狭窄屏幕下退化为纵向堆叠，见第 3 节）。

## 2. 视觉体系（深色技术仪表盘）

纯深色、面板化、等宽字体承载标识符与数字。所有颜色、间距走 `:root` 上的 CSS 变量（`src/styles/theme.css`），组件内不写魔法值。

设计令牌：

| 变量 | 值 | 用途 |
|---|---|---|
| `--bg` | `#0a0c12` | 应用底色 |
| `--panel` | `#10141c` | 面板背景 |
| `--panel-head` | `#151a24` | 面板标题栏 |
| `--border` | `#1f2733` | 常规分隔线/边框 |
| `--border-strong` | `#2c3646` | 选中/hover 边框 |
| `--text` | `#d7dee8` | 主文本 |
| `--text-muted` | `#7b8797` | 次要文本 |
| `--text-faint` | `#4d5766` | 时间戳/占位 |
| `--accent` | `#8b5cf6` | 主强调色（violet，呼应项目名） |
| `--accent-soft` | `rgba(139,92,246,.14)` | 选中背景/聚焦光晕 |
| `--ok` | `#3fb950` | active / completed outcome |
| `--warn` | `#d29922` | paused / passed / stuck |
| `--danger` | `#f85149` | error / terminate / challenge |
| `--info` | `#58a6ff` | verify / hypothesis |
| `--mono` | `ui-monospace, "SF Mono", Menlo, monospace` | 标识符、时间、日志 |
| `--radius` | `6px` | 统一圆角 |
| `--gap` | `10px` | 面板内元素间距 |
| `--pad` | `12px` | 面板内边距 |

- UI 文本用系统 sans 栈；`agentId`、`sessionId`、`#N`、时间、已运行时长、日志内容一律 `--mono`。
- 时间统一展示为本地 `HH:mm:ss`，悬浮 `title` 给完整 ISO 时间；跨天或详情里用相对时长（如 `2m 15s`）。
- **agent 身份色**：`colorForAgent(agentId)` 对 `agentId`（**agent 实例标识**，见 `00-overview.md`）做稳定 hash 映射到色相，`hsl(h 65% 62%)`。同一实例在 agent 卡片、消息头像、事件树节点上颜色一致；同一 agent 的不同实例因标识不同而得到不同色相。
- **保留作者身份**：`authorId === 'human'` 固定 violet + "人类"标识；`authorId === 'system'` 固定 `--text-muted` + "系统"标识（系统错误消息）。两者都不参与身份色 hash。
- **状态色**：room `active`→`--ok`，`paused_limit`/`paused_manual`→`--warn`，`completed`→`--text-muted`；agent `running`→其身份色，`idle`→`--text-faint`，`stopping`→`--warn`，`stuck`→`--warn`（图标 + 卡片描边）；**已停用派发**的 agent 整卡降为 `--text-muted` + "已停用派发"。
- **消息类型徽标**：每种 `MessageType` 一个双色（前景 + 半透明背景）小徽标：`fact` 绿、`hypothesis` 蓝、`boundary` 橙红、`open_question` 琥珀、`chain` 紫、`exploring` 青、`propose_completion` 翠绿高亮、`endorse` 绿、`challenge` 红、`verify` 蓝。无 `type` 的纯聊天不显示徽标。
- 面板标题栏统一：左侧标题 + 数量徽标，右侧可选动作，`position: sticky; top: 0`。

## 3. 布局骨架（可拖动分隔条）

`RoomDashboardPage` 是 CSS Grid，三个尺寸**可拖动调整**：左栏宽度、右栏宽度、中列"记忆 / 消息流"的上下高度。

```
┌───────────────────────────────────────────────────────────┐
│ RoomHeader（房间名 / 状态 / session 计数 / 连接 / 控制）      │
├──────────┊─────────────────────────────┊──────────────────┤
│ AgentRail┊ MemoryPanel                 ┊ EventTreePanel   │
│ （左栏）  ┊                             ┊（右栏）          │
│          ┊╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┊                  │
│          ┊ MessageStreamPanel           ┊                  │
│          ┊  ├ 消息列表（滚动）            ┊                  │
│          ┊  └ Composer（固定底部）         ┊                  │
└──────────┴─────────────────────────────┴──────────────────┘
   ↑ vsplit1        ↑ hsplit          ↑ vsplit2
```

Grid 用 5 列 × 4 行，分隔条各占一条细轨道（`--splitter: 5px`）：

```css
.dashboard {
  height: 100vh;
  display: grid;
  grid-template-columns: var(--agents-w) var(--splitter) minmax(0, 1fr) var(--splitter) var(--events-w);
  grid-template-rows: auto var(--memory-h) var(--splitter) minmax(0, 1fr);
  grid-template-areas:
    "header  header  header  header   header"
    "agents  vsplit1 memory  vsplit2  events"
    "agents  vsplit1 hsplit  vsplit2  events"
    "agents  vsplit1 messages vsplit2 events";
}
```

- 可变轨道：`--agents-w`（默认 240px）、`--events-w`（默认 400px）、`--memory-h`（默认 `round(40vh)`，px）。
- 三个 `Splitter`（`role="separator"`，`aria-orientation`）：`vsplit1` 调整左栏宽、`vsplit2` 反向调整右栏宽、`hsplit` 调整记忆面板高。用 Pointer Events 实现（`pointerdown` 里 `setPointerCapture`，`pointermove` 按增量派发 `onDrag(delta)`，`pointerup/cancel` 结束），拖动中给 `<body>` 加 `user-select: none`。
- 限幅：`agents-w` 160–420、`events-w` 260–720、`memory-h` 120 到（视口高 − 消息区最小 160）之间夹住。
- 持久化：三个尺寸写入 `localStorage`（key `vd.dashboard.layout`），刷新复用；读不到或非法则用默认（`memory-h` 依当前视口算）。
- 分隔条常规 1px 边框色，hover/拖动时 `--accent` 高亮，`cursor: col-resize`/`row-resize`。
- 断点：`<1280px` 默认列宽收窄（200/340）；`<1024px` 退化为单列纵向堆叠（**隐藏分隔条**、取消固定高、页面恢复滚动），消息列表固定高 `55vh`，AgentRail 变横向滚动条。堆叠顺序：header → agents → memory → messages → events。
- 每个面板 = `.panel`（标题栏 + 可滚动 body，`min-height: 0; overflow: auto`）。面板之间靠分隔条/边框分隔，不叠加卡片阴影。
- 面板 body 的滚动条**始终可见**，避免 macOS 覆盖式滚动条导致"看不到还有内容"。实现注意：Chromium 只要看到 `scrollbar-width` 就会**忽略 `::-webkit-scrollbar` 自定义样式**、退回覆盖式滚动条；所以 `scrollbar-width`/`scrollbar-color` 只能用 **Firefox 专属的 `@supports (-moz-appearance: none)`** 包住，Chromium/Safari 一律走 `::-webkit-scrollbar` 自定义样式。**不要再写 `@supports not selector(::-webkit-scrollbar)`**——Chromium 对该条件判定为真，会误加 `scrollbar-width`，正是"记忆面板没有滚动条"这个 bug 的成因。

## 4. RoomHeader

顶栏，`grid-area: header`，`position: sticky`。左侧：返回房间列表的链接、房间名（`GET /api/rooms/:id`）、状态徽标、`currentSessionCount / maxSessions`（`--mono`）、以及该房间的工作目录 `workdir`（`--mono`、`--text-faint`、单行截断 + 悬浮 `title` 给完整路径）。右侧按状态渲染控制：

- `active`：`Pause`；其余非 `completed`：`Resume`（`paused_limit` 时弹输入框要求填 `additionalSessions`，必填不可提交；`paused_manual` 直接调用，见 `03-orchestrator-core.md` 第 4 节）；非 `completed` 恒有 `Confirm Completion`（`--danger` 描边 + 二次确认弹窗）。
- `completed`：pause/resume/confirm 控制隐藏，顶栏显示"已结束 · 只读"，并保留一个 `Delete Room` 按钮（`--danger` 描边 + 二次确认弹窗）——只有 completed 房间可删；删除成功后跳回 `/`。
- 连接状态：`disconnected` 时顶栏下方压一条 `--danger` 且不可关闭的提示条"连接已断开，正在重连…"；`connecting` 时右侧一个呼吸圆点。
- **`propose_completion` 提醒**：已加载消息中存在 `propose_completion` 且房间未 `completed` 时，顶栏下方再压一条可关闭的 `role="alert"` 提醒条"有 agent 提议完成这个房间"，并提供跳转到该消息的锚点。用户关闭后，直到下一条新的 `propose_completion` 到达前不再出现。该提醒由前端从已加载消息流派生，不需要额外接口或状态管理；消息流分页导致更早的提议不在窗口内时不显示，这是可接受的降级。

## 5. AgentRail

`grid-area: agents`，每个 agent 一张卡片：

```
● claude            [running]        ⟳
  session #7（点击查看）· 已运行 02:13
  [activeExploringSummary，两行截断]
  [终止]
```

- 状态点用身份色/状态色；`state` 徽标 `running`/`stopping`/`idle`。
- `running`/`stopping` 且 `sessionStartedAt` 存在时，本地每秒 tick 显示 `已运行 HH:mm:ss`（系统不做超时判定，这是人类判断"跑太久"的唯一依据，需求 3.3）。
- `sessionId` 徽标可点击（`running`/`stopping` 才有）→ `LiveSessionModal`（实时只读日志，见 §10.1）；`终止` 按钮调用 `terminateAgentSession({ sessionId })`（需求 3.5：操作对象是具体 session，不是 agent）。只要 session 仍为 running/stopping 就保留"终止"，包括已 completed 的房间。
- `stuck` 时整卡描边 `--warn` + `⚠` 图标，`title="这个 agent 可能卡住了，要不要看看"`（不自动处理，只提示）。
- **派发启停**：卡片显示 `enabled`；`enabled === false` 时整卡降为 `--text-muted` + "已停用派发"，`failureCount > 0` 时显示 `连续失败 ×N`。每张卡有一个启用/停用按钮，调用 `setAgentEnabled({ agentId, enabled })`（`03-orchestrator-core.md` §6）。连续 3 次失败会被核心自动停用，需人类点启用重新入队。
- 卡片左侧用 agent 身份色 3px 描边，扫一眼即可按颜色区分。

## 6. MessageStreamPanel

`grid-area: messages`，纵向 flex：消息列表 `flex: 1; overflow: auto`，Composer 固定在底部。

消息行里的 `#N` 是 **room 内消息 id**（见 `00-overview.md`/`01-storage.md`），不是全库编号；点击 `↳ #N` / `引用 #N` 会定位并高亮该消息。

消息行（`MessageRow`）：

```
◐ claude   [fact]                      12:34:56
  内容（保留换行，长内容换行不截断）
  ↳ 引用 #3   [chain 的 referencedMessageIds chips]
```

- 头像圆点用身份色；`human` 用固定 violet + "人类"标识，`system` 用 `--text-muted` + "系统"标识。
- 行左侧 3px 竖条：被选为 `targetMessageId` 时 `--accent` + 光晕。无 `type` 的纯聊天正常显示，只是没有类型徽标。
- `propose_completion` 渲染为整行高亮卡片（翠绿左边框 + "提议完成"徽标），并配合第 4 节的顶栏提醒条一起构成需求 3.5/7 的"前端提醒"，复用已有 `newMessage` 推送，不需要额外接口。
- **目标选择**：点击消息行 = 设为发送目标（`targetMessageId`），再点一次取消；Composer 顶部显示"正在回复 #id ✕"，并据此浮出反应类选项（见 §7）。
- **滚动锚定**：新消息到达时，若视口距底部 ≤ 80px 则自动贴底；否则不打断阅读，在右下角浮出"↓ N 条新消息"按钮，点击回底。进入房间时定位到底部。
- **向上翻页**：滚动到顶时用 `listMessages({ cursor: nextCursor })` 加载更早一页，前插后用 `prevScrollHeight` 补偿保持滚动位置；`nextCursor === null` 时顶部显示"没有更早的消息了"。

## 7. Composer

固定在消息面板底部：

- **默认即纯聊天**：初始只有文本框 + 发送按钮，发出的消息 `type` 为空；纯聊天仍是实质消息、照常触发派发检查（`03-orchestrator-core.md` 1.1）。类型选择器默认折叠，覆盖发任务 / 补充指令 / 闲聊等绝大多数场景。
- **类型选择器按需展开**：文本框左侧一个不显眼的"＋ 类型"按钮，点击展开；选中后按钮显示该类型徽标，可一键清除回到纯聊天。
- **人类可选类型只含需求 3.5 举的这几项**：`fact` / `hypothesis`（始终可选）+ `open_question`（提问；目标可选表示"追问"某条消息）。agent 专有记忆类型（`boundary` / `chain` / `exploring` / `propose_completion`）不提供入口——它们是 agent 工作的产物，由 agent 经 MCP 写入。
- **选中目标消息后追加反应类选项**：点选一条消息（§6"目标选择"）后，选择器自动展开并追加 `endorse` / `challenge` / `verify`；取消目标（再点该消息或点 ✕）时移除这三项，已选中的反应类型一并清空。
- `06-orchestrator-api.md` 的 `postHumanMessage` 签名不变（仍接受全部 `type`），仅前端不给其余类型的入口。
- `content` 用自适应高度 `textarea`（最多 8 行后内部滚动）；`Ctrl/Cmd + Enter` 发送。
- 调用 `postHumanMessage({ content, type?, targetMessageId? })`（`referencedMessageIds` 仅 `chain` 使用，人类 UI 不产生，接口仍接受）；成功后由 `newMessage` 推送自然带回，**本地不做乐观插入**。发送成功后清空输入与选择状态。
- `completed` 房间：Composer 整块替换为"房间已结束，只读"提示条，不渲染输入控件（满足需求 7）。

## 8. MemoryPanel

中列上方一行。数据仍只来自 `getMemoryView()`（全文，`06-orchestrator-api.md` 不变），但展示改为**总线 + 逐级下钻**的渐进式结构（需求 3.5）——语义是"先给索引，用户点了才展开内容"。三个层级：

1. **记忆总线**（常驻顶部，不可折叠）：各类别的索引 chips 横排，每个 chip 显示类别名 + 计数；计数直接由当前 `getMemoryView()` 返回的各分组数组长度派生（`exploring` 显示 `active`/`completed` 两个计数）。默认**不展开任何类别**。
2. **类别层**（点击某个 chip 后，在该类别下方内联展开）：展示该类别的条目列表——每条一行，含类型徽标、作者（身份色）、`HH:mm:ss`、`summary`；再点该 chip（或收起按钮）折叠回总线。
3. **条目层**（点击类别层里的某条）：展开这条的全文（不截断，`white-space: pre-wrap`）、`targetMessageId` 的 `↳ #id` 跳转，以及挂在它上面的注解信息。

- 分组展示顺序仍固定：`facts` → `hypotheses` → `chains` → `boundaries` → `openQuestions` → `exploring`（前端 chip 的渲染顺序，与 `MemoryViewPayload` 的字段声明顺序无关，见 `02-memory-management.md`）。
- 允许同时展开多个类别（各自独立折叠），但初始态是全部折叠——"渐进式"指按需展开，不做懒请求。
- 带 `targetMessageId` 的 `↳ #id` 点击后在消息流里滚动定位并短暂高亮该消息。
- 面板 body 始终显示细滚动条（见 §3），内容过长时可滚动查看，不截断。**实现坑**：`.memory-view` 既是滚动容器又是 flex 列容器，而 `.memory-group` 带 `overflow:hidden`——按 flex 规范后者的"自动最小尺寸"失效，会被 `flex-shrink` 压扁、内容被裁掉。必须禁止子项收缩：`.memory-view > * { flex: 0 0 auto; }`。
- `exploring` 类别（需求 4.6/3.5）：条目层按 `authorId` 分组、组内按 `createdAt` 倒序。`exploringStatus === 'active'` 正常展示（青色徽标 + 作者身份色）；`'completed'` 整条降为 `--text-muted` + "已完成"标签，若带 `exploringNote` 一并展示。**保留可见、不从视图消失**。
- 实时更新（见第 13 节）：收到 `newMessage`/`memoryUpdate`/`roomStatus` 后重拉 `getMemoryView()`——总线计数随之刷新；已展开的类别与条目保持展开状态、内容就地更新。

## 9. EventTreePanel

右栏，独占一列全高（`grid-area: events`）。`getEventTree().sessions`（按 `startedAt` 排序）与从消息流里筛出的人类消息（`sessionSeq === null`，按 `createdAt`）合并成一条**竖直时间线**（新在下），默认贴底。人类消息与消息流共用同一份已加载的 `messages` 状态，所以 `newMessage` 推送追加后事件树自动同步；`listMessages` 是分页的，时间线只覆盖已加载窗口内的历史。

- session 节点：`#seq · agentId（身份色）· outcome 徽标 · 起止时间`，展开显示该 session 的 `messages`（类型徽标 + 内容摘要），仅包含正式房间消息；点击节点标题 → `getSessionDetail({ sessionId })` 打开 `SessionDetailModal`（**复盘视图**，元数据 + 消息列表 + 只读日志回放；running session 也走这里，只是日志为当前快照，见 §10.2）。注意与 AgentRail 的 `LiveSessionModal`（§10.1，实时只读日志）是**两个不同的入口、两种不同的内容**。
- outcome 配色：`completed`→`--ok`、`passed`→`--warn`、`error`→`--danger`、`terminated`→`--accent`、`running`→身份色呼吸、`stopping`→等待色。
- 人类消息节点：无 outcome 徽标，用 human 色 + "人类"标签，与 session 节点在样式上明显区分（需求 3.5）。
- **关联线**：每个节点带 `data-message-id`；反应类消息（`endorse`/`challenge`/`verify`，以及带 `targetMessageId` 的 `open_question`）和带 `referencedMessageIds` 的 `chain`，在节点旁用一层绝对定位的 SVG（贝塞尔曲线）连到目标节点；目标不在当前树内（未加载）时跳过。连线颜色取源消息类型徽标色，选中目标时高亮。这些关联线不改变按 session 组织的主结构。
- 空态：没有任何 session 时显示"还没有任何 session"。

## 10. Session 视图

RoomDashboardPage 分别持有 liveSession 与 sessionDetail，目标固定为 (roomId, sessionId)。共用 modal 外壳：遮罩、居中卡片（最大 1100px/86vh）、Esc/遮罩/关闭按钮；关闭仅释放浏览器资源，不终止 session。

### 10.1 LiveSessionModal

独立设计见 [08-live-session-modal.md](08-live-session-modal.md)。产品名"Session 实时日志"，AgentRail 的 running/stopping sessionId 打开，显示持续只读日志及人工终止操作。无终端输入、resize、PTY 或 xterm。新 session 不替换打开的旧目标。

### 10.2 SessionDetailModal

事件树点击任意 session 打开 getSessionDetail，展示元数据/outcome、正式消息列表、生命周期记录和只读日志快照。running/stopping 同样使用快照，标签"尚未结束 · 日志快照"。

日志使用 SessionLogView 与 useSessionLog(mode=replay)。快照 end 帧不代表业务结束；结果依据 RPC。生命周期中展示人工终止、清理尝试、信号与失败/退出事实。roomStatus 更新时重拉打开目标的详情；rawLog 不重复写入日志 WS 视图。

## 11. RoomListPage

`/`，纵向：顶部品牌栏 + 房间网格 + 新建房间面板。

- 房间网格：每张卡片显示 `name`、状态徽标、`createdAt`（相对时间，如"3 分钟前"），点击进入 `/rooms/:id`；空态显示"还没有房间，创建一个吧"。**`completed` 的卡片额外显示 `Delete` 按钮**（`--danger` 描边 + 二次确认弹窗，说明"将级联删除 session、记忆、事件树、信息流与磁盘日志，不可恢复"）；删除调用 `DELETE /api/rooms/:id`，成功后刷新列表；非 `completed` 卡片不显示该按钮。
- 新建房间面板：`name` 输入框；agent chips 来自 `GET /api/agents`，**可重复点击以加入同一 agent 的多个实例**——每个 chip 显示当前已加入数量（如 `codex ×2`），点击 +1；下方"已加入实例"区按加入顺序展示将要生成的实例标识（单个显示 `codex`，多个显示 `codex-1`/`codex-2`……，与 `01-storage.md` 的规则一致），每条可单独移除、也可清空某 agent 的全部实例。`schedulingMode` 只有 `sequential`，渲染为唯一可选且已选中的选项（其他模式预留位置但禁用，需求 3.3）。另有**可选的 `maxSessions` 数字输入框**（label「session 上限」，`min=1`，placeholder 显示默认值 20）：留空表示用服务端默认值；填了就必须是正整数，否则提交时在表单内联报错、不发请求。以及**可选的 `workdir` 文本输入框**（label「工作目录」，placeholder 提示"默认：服务端目录"）：留空用服务端默认；填了随 `POST /api/rooms` 提交，路径是否存在/是目录由服务端校验（`06`），失败在表单内联报错。提交 `POST /api/rooms`（`agentIds` 按加入顺序、允许重复；数组里是注册表 key；`maxSessions` 仅在填写时带上），成功后跳 `/rooms/:id`；失败在表单内联 `role="alert"`。
- **不可用 agent**：`GET /api/agents` 返回 `available`/`unavailableReason`；`available=false` 的 chip 禁用并悬浮展示原因（`07 §17`）。
- **创建后不可变**：参与的 agent 名单（含实例划分）、`schedulingMode` 与 `maxSessions` 在创建时确定，创建后不能增减或更改（需求 3.5；`maxSessions` 之后只能靠房间内 `resumeRoom` 追加）。

## 12. useRoomSocket(roomId)

连接 `/api/rooms/:roomId/ws`。对外暴露：

```typescript
{
  call<T>(method: string, params?: object): Promise<T>;  // RPC，按 06 第 2 节的 {id, method, params} 信封，Promise 在收到匹配 id 的响应时 resolve/reject
  subscribe(event: 'newMessage' | 'memoryUpdate' | 'roomStatus' | 'roomDeleted', handler: (data: any) => void): () => void; // 返回取消订阅函数
  connectionState: 'connecting' | 'connected' | 'disconnected';
  reconnectCount: number; // 每次（含重连）onopen 递增，供页面重拉全量状态
}
```

- **队列必须跨重连存活**：连接未建立（含断开期间）发出的 `call()` 保留在队列，`onopen` 后按序 flush；不许静默丢弃或让 Promise 永不 settle。
- **重连后必须重拉全量状态**：`disconnected` 后固定间隔（2 秒）自动重连；每次 `onopen`（含重连）后由 `RoomDashboardPage` 订阅 `reconnectCount` 触发一次全量刷新（`getRoomStatus()` / `getMemoryView()` / 不带 cursor 的 `listMessages()`），服务端不补发。

### 12.1 useSessionLog(roomId, seq, mode)

```typescript
function useSessionLog(roomId: number, seq: number, mode: 'live' | 'replay'): {
  onData(cb: (chunk: LogChunk) => void): () => void;
  source: 'live' | 'snapshot' | null;
  truncated: boolean;
  ended: boolean;
  error: string | null;
  connectionState: 'connecting' | 'connected' | 'disconnected';
};
```

连接 06 第 2.1 节 /logs 端点，全程只读，不暴露 sendInput/resize。先安装消费者再建立连接，按 offset 去重。关闭释放资源，不自动重连，重开窗口重新拉取。供 LiveSessionModal 的 live 和 SessionDetailModal 的 replay 共用。日志正文的 ANSI/控制序列在展示层清理（`src/utils/ansi.ts`），不执行、不渲染为 HTML。

## 13. 实时事件的消费

四种推送事件的消费方式不同（`data` 格式见 `06-orchestrator-api.md` 第 2 节——WS 连接本身已按房间绑定，推送都不重复携带 `roomId`）：

- **`newMessage`**：`data` 是完整 `Message` 对象——MessageStreamPanel 直接 append 到列表末尾（同一份 `messages` 状态也让 EventTreePanel 的人类消息节点同步更新）；若 `message.type != null`，MemoryPanel 增量刷新（直接重新调用一次 `getMemoryView()`），并重新拉一次 `getEventTree()`。
- **`memoryUpdate`**：`data` 是 `{ messageId }`——收到后重新调用 `getMemoryView()`。
- **`roomStatus`**：`data` 是 `{}`（纯信号）——收到后重新调用 `getRoomStatus()`，并刷新 `GET /api/rooms/:id`、`getEventTree()`。session 结束时 `roomStatus` 一定会到，但 `newMessage` 不一定（`passed` 不产生消息，`error` 会插入一条 system 消息）。人工终止请求、清理进度/失败、`setAgentEnabled` 也触发 roomStatus；当前打开的 SessionDetailModal 按该信号重拉详情；LiveSessionModal 按 08 第 2/8 节刷新固定目标状态。
- **`roomDeleted`**：`data` 是 `{}`——终态推送。收到后若 `LiveSessionModal`/`SessionDetailModal`（日志）还开着先关闭，然后 `navigate('/')` 回房间列表。

这个设计是刻意的：高频、体积小、已经现成的数据（单条消息）直接推全量内容；低频、需要聚合计算的数据（房间状态、记忆视图、事件树）只推信号，由前端按需拉。日志输出是另一条独立的高频数据通道（日志 WS），刻意不混进这条房间 WS。

## 14. 对外依赖

前端只消费 `06-orchestrator-api.md` 的接口，不直接碰存储/编排器核心。`GET /api/agents` 的数据来自 `04-agent-invocation.md` 的 `AgentRegistry`（服务启动时加载进内存），服务端已实现。

```typescript
// 06-orchestrator-api.md REST
GET /api/rooms, GET /api/rooms/:id, POST /api/rooms, DELETE /api/rooms/:id, GET /api/agents

// 06-orchestrator-api.md WS RPC
listMessages, postHumanMessage, getMemoryView, getRoomStatus, getEventTree,
getSessionDetail, terminateAgentSession, setAgentEnabled, pauseRoom, resumeRoom, confirmCompletion

// 06-orchestrator-api.md WS 推送
newMessage, memoryUpdate, roomStatus, roomDeleted

// 06-orchestrator-api.md 日志 WS（第 2.1 节）
GET /api/rooms/:roomId/sessions/:seq/logs?mode=live|replay
```

## 15. 错误、加载与连接状态

- **初次加载**：面板级骨架屏（消息列表 3 条占位、记忆分组占位、事件树占位）；`GET /api/rooms/:id` / `getRoomStatus` 失败时顶栏下压一条 `role="alert"` 错误条，不影响其余面板渲染。
- **RPC 动作失败**（发送、终止、启停 agent、pause/resume/confirm）：右下角 toast 栈，`role="alert"`，展示 `error.message`，约 5 秒自动消失，可手动关闭。"调用失败必须让人看到，不能静默吞掉"。
- **REST 失败**（RoomListPage 拉列表 / 建房间表单 / 删除房间）：失败时在列表/表单旁内联展示错误文案；删除失败用 toast 展示错误，不跳转、不刷新。
- **日志连接失败**（第 10 节）：在 `LiveSessionModal` / `SessionDetailModal` 中保留已显示日志并展示错误提示，不静默空白。
- **连接断开**：见第 4 节顶栏提示条，重连成功后隐藏。

## 16. 组件与文件落点

```
src/
├── styles/theme.css             # 设计令牌（第 2 节）
├── styles/dashboard.css         # 布局与面板样式（第 3 节）
├── utils/ansi.ts                # 日志 ANSI/控制字符显示清理
├── pages/RoomListPage.tsx
├── pages/RoomDashboardPage.tsx  # 取代原 RoomPage
├── components/
│   ├── Panel.tsx                # 标题栏 + 滚动 body 的通用面板壳
│   ├── RoomHeader.tsx
│   ├── AgentRail.tsx            # 取代 AgentStatusBar（含派发启停）
│   ├── MessageStreamPanel.tsx   # 取代 MessageStreamTab（含 MessageRow）
│   ├── Composer.tsx             # 从 MessageStream 拆出的发送框
│   ├── MemoryPanel.tsx          # 取代 MemoryPanelTab（总线 + 逐级下钻）
│   ├── EventTreePanel.tsx       # 取代 EventTreeTab（含关联线）
│   ├── LiveSessionModal.tsx     # AgentRail 入口：实时只读日志（第 10.1 节）
│   ├── SessionDetailModal.tsx   # 事件树入口：元数据 + 消息列表 + 只读回放（第 10.2 节）
│   ├── SessionLogView.tsx        # 纯文本日志，两个 modal 共用
│   ├── Splitter.tsx             # 可拖动分隔条（第 3 节）
│   └── ToastStack.tsx
├── hooks/useRoomSocket.ts
├── hooks/useSessionLog.ts  # 日志 WS 连接（第 12.1 节）
├── hooks/useDashboardLayout.ts  # 面板尺寸状态 + localStorage 持久化（第 3 节）
└── api/{rest.ts,types.ts}
```

`*Tab` 后缀组件统一改名为 `*Panel`；`test/` 下对应测试同步更新，并新增布局、Composer 目标/类型选择、EventTree 人类消息穿插与关联线、MemoryPanel 总线/逐级下钻、LiveSessionModal 实时日志（`mode=live` 只读）、SessionDetailModal 复盘视图（`mode=replay` 只读回放、running 也走 replay）、删除房间、多实例建房间、agent 派发启停的测试。

## 17. Agent 可用性与停用

- `GET /api/agents` 返回 `available`/`unavailableReason`；不可用 agent 禁止选择并展示原因。
- 生命周期事件与执行日志不进入消息/记忆面板；SessionDetailModal 单独展示生命周期记录。
- AgentRail 展示 `enabled`/`failureCount`：连续失败被自动停用的 agent 需人类点"启用"才重新入队（`03-orchestrator-core.md` §6）；停用不终止正在运行的 session。
- 删除房间清理失败时展示错误并留在原页面，保留日志、记录及打开的弹窗。
