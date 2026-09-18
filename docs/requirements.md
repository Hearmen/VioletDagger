# VioletDagger 需求文档

多 agent 协作聊天室系统：新建一个"聊天室"（room），拉入多个异构 agent（Kimi、opencode、Claude、Codex，以及未来可能加入的其他 agent），围绕同一个任务目标，共享信息、各自探索、互相协作，最终沉淀出一份可信的结果。

## 1. 目标与定位

- **核心类比**：这套系统是对"单模型内 spawn 一个 agent、派任务、等结果"这种 subagent 机制的推广——把"单模型的一对多"变成"多模型的多对多"：不同模型（Kimi、opencode、Codex、Claude 等）互为 agent；不是黑盒等最终结果，而是过程中持续同步进展（分层记忆、事件树）；并且有一个前端能实时看着这一切发生。
- **通用任务**，不局限于编码类任务；不内置代码工作区隔离（不做 git worktree 之类的机制），保持系统本身简单。
- **工作目录**：新建 room 时可指定一个工作目录 `workdir`，该 room 里所有 agent 的 CLI 都默认在这个目录下运行（不填用服务端默认）。这只是给进程设一个 cwd，**不是**工作区隔离——不复制、不隔离文件，多个 room 可以指向同一个目录。
- **本地单机工具**，单用户使用，无需考虑多用户鉴权/远程访问。
- 技术栈：**TypeScript / Node.js**。

## 2. 总体架构

系统分两层，职责严格分离：

```
┌───────────────────────────────┐
│  编排器 (Orchestrator) 后端      │  本地网页 UI + 进程编排
│  - 新建 room / 选择 agent 加入    │
│  - 事件驱动派发调用               │
│    各 agent 的 CLI 会话执行     │
│  - agent 注册表（可配置）         │
│  - 直接读写房间底层存储           │
│    （不经过 MCP，见 3.5）         │
└──────┬─────────────────┬─────────┘
       │ WebSocket        │ 直接读写（同进程/同存储，非 MCP）
       ▼                  ▼
┌────────────┐   ┌─────────────────────────────┐
│ 网页前端     │   │  MCP Server（被动状态后端）     │
│ (浏览器)     │   │  - 管理多个 room（roomId 区分） │
└────────────┘   │  - 暴露工具：post_message /    │
                  │    get_overview / get_detail   │
                  │  - 持久化消息与记忆聚合视图     │
                  └──────────────┬────────────────┘
                                 ▲
                    ┌───────────┼───────────┬───────────┐
                    │           │           │           │
                  Kimi       opencode     Codex       Claude    ...（可扩展）
                (MCP client) (MCP client)(MCP client)(MCP client)
```

**为什么要分两层**：MCP server 是被动的——它只响应已连接 agent 的工具调用，自己没有能力主动"拉一个 agent 进房间"（即无法主动 spawn 进程）。而"新建 room、勾选 agent、真正把它们的 CLI 进程跑起来"这件事，需要一个主动的编排器来做。MCP server 只负责房间状态和记忆的读写。

**编排器和 MCP server 共享同一份底层存储**，但对外是两套完全独立的接口：MCP 协议只暴露给外部 agent CLI；编排器对自己的网页前端走另一套内部接口（WebSocket + 直接读写），人类发消息、前端看消息流/记忆/状态，都不经过 MCP，见 3.5。

## 3. 编排器（Orchestrator）

### 3.1 界面

本地网页（浏览器打开）。核心交互：

- 新建 room：填写一个简短的房间名称（`name`，仅用于 room 列表展示），勾选要拉入的 agent，选择调度模式（`schedulingMode`，见 3.3；v1 只实现 `"sequential"`，选项里预留其他模式的位置），并**可选**设置 `maxSessions`（session 总数上限，见 3.3；不填则用服务端默认值）与 `workdir`（工作目录，见第 1 节；不填则用服务端默认目录）。创建完成后，人类在房间里发的**第一条消息**就是实际的任务描述，这条消息本身触发第一次派发（见 3.3），也是 `get_overview.goal` 的来源（见 4.4）——不在创建时单独填"任务目标"。
- room 内视图：原始消息流 + 分层记忆面板（全文，见 3.5），实时更新。
- 随时可以在网页里以人类身份发消息插入 room。
- **卡住提醒**：如果某个 agent 有一条 active 状态的 `exploring`，且连续 N 次被派发到它自己都没有任何新消息（见 4.6），UI 上给出提醒（不自动处理，只是提示"这个 agent 可能卡住了，要不要看看"）。
- **单 session 详情查看**：查看某次调用的实时只读 stdout/stderr 日志、消息和生命周期记录，用于排障；已结束的 session 保留日志快照。无需 PTY、原生 TUI 或终端输入。

### 3.2 agent 注册表（可扩展）

一份配置文件，登记每个 agent 的调用方式：

```
{
  "agents": {
    "codex":    { "command": "一次性非交互启动 argv，见设计 04", "mcpFile": { "template": "每个 session 独立配置模板" } },
    "claude":   { "command": "一次性非交互启动 argv，见设计 04", ... },
    "opencode": { "command": "一次性非交互启动 argv，见设计 04", ... },
    "kimi":     { "command": "kimi ...", ... }
    // 未来新增 agent：加一条配置即可，不用改代码
  }
}
```

v1 内置以上四个 agent 的默认配置模板。

同一个 agent 可以在建房间时被**多次选中**，即同一个 room 里可以有多个同一类 agent 的实例；实例之间用数字后缀区分（该 agent 只被选一次时用原名 `codex`，被选多次时按加入顺序依次为 `codex-1`、`codex-2`……）。后缀只用于区分实例，底层仍复用同一份注册表配置；消息的 `authorId`、session 的归属都用这个实例标识。

### 3.3 调度模型

**调度模式是房间创建时选定的一个可扩展参数（`schedulingMode`）**，v1 只实现 `"sequential"`——指的是**单个 agent 自己的 session 是顺序的**：同一个 agent 不会同时有两个属于它自己的 session 在跑（这是派发规则本身保证的，见下："忙碌中的 agent 不受打扰"，不会被再次派发）。**不同 agent 之间本来就可以同时跑**，这跟 `sequential`/`parallel` 无关——A 在跑的时候，B 空闲、被触发派发，B 立刻开始跑，房间里同时存在多个 session 是正常情况，不是"parallel"模式才有的行为。未来的 `"parallel"` 模式，指的是放开"单个 agent 自己"这层限制，允许同一个 agent 自己也能同时有多个 session 在跑。v1 先只做 `sequential`，把这个参数留出来，以后加新模式不用重新设计房间的创建/存储结构。`schedulingMode` 管的是**单个 agent 自己能不能并发多个 session**这一个维度，跟"什么时候触发新 session"（下面的事件驱动派发规则）是两个独立的维度，互不影响、都不因调度模式而变。

**术语**：**`sessionId` 是 agent 每一次 session（一次调用）的全局自增编号**——不叫"轮"，避免歧义。一次 session 执行期间可能会发出多条消息（不是只有结束时才发一条），这些消息**共享同一个 `sessionId`**。

**事件驱动派发**（替代旧的"编排器一直往前转"模型）：

- **触发源**：以下两种情况都会触发一次派发检查——(1) 任意一条**实质消息**被发出：人类发的消息**一律算实质消息**（不管带不带 type）；agent 发的消息只有**带 type**（4.3 的记忆类型或 reaction）才算实质消息——不带 type 的纯聊天/过渡性发言（4.2）跟 `pass`、系统占位事件一样，**不触发**派发检查。(2) 某个 agent 的 session **结束、它变回空闲**（无论是正常结束、还是被 `terminateAgentSession` 处理完）。这样设计是为了不漏掉"消息到达时所有 agent 都在忙"的情况——这条消息已经被记录，等下一次触发（不管是新消息还是有人变空闲）自然会被看到。
- **派发规则**：每次触发都检查当前有没有空闲的 agent。有——按固定顺序（agent 加入房间的顺序）选排在最前面的那个空闲 agent，为它启动一个新 session；不排除触发消息的作者本人，它若空闲、排到它就是它。没有空闲 agent——什么都不做，等下一次触发。
- **被派发的 agent 拿到什么**：两部分。(1) **房间协议说明**——固定的、不随每次派发变化的规则性内容（消息类型含义、`exploring` 生命周期、人类消息权重更高、可用工具有哪些等），因为每次 session 都是从零开始、不存在"已经学过规则"这回事，这份说明必须每次都完整给到，不能假设 agent 记得上次的规则。(2) **当前房间状态**（`get_overview`），不是只有触发它的那一条消息。两者一起构成这次 session 的完整输入。
- **忙碌中的 agent 不受打扰**：一个 session 还在跑的时候，不会被通知、不会被打断，直到它自己结束（正常完成、报错退出，或被人类通过 `terminateAgentSession` 强制终止）。
- **`pass`**：一个 agent 被派发之后，如果看完当前房间状态觉得没什么可说的，可以不发任何实质消息，只留一个系统占位事件（"pass"），会在事件树里留痕（见 3.5），但不会成为新的触发源。
- **Agent 讨论方式**：可以基于当前房间的任务目标，以及房间中的信息赞同（`endorse`）、反对/质疑（统一映射为 `challenge`，两者功能上没有区别）、验证（`verify`）、追问（带 `targetMessageId` 的 `open_question`），也可以另起方向。
- **总 session 数上限**：就是 agent 累计启动的 session 总数（`sessionId` 的最大值），不区分是被什么触发的，没有例外。**这个上限在创建 room 时可选指定（`maxSessions`，正整数；不填用服务端默认值）**，创建后不能直接改，只能靠 `resumeRoom(additionalSessions)` 追加。达到上限后自动暂停，把"是否继续"的决定权交还给人类——通过 `resumeRoom`（见 3.5）继续，或直接 `confirmCompletion` 结束。人类也可以在任何时候主动 `pauseRoom`，不需要等到达上限。
- **没有自动超时机制**：编排器不会主动判断"这次 session 跑太久了"，不会自动把某次 session 标记为超时/出错——session 会一直运行，直到它自己正常退出或报错退出为止，系统不设执行时长上限。如果人类观察到某个 agent 的运行时长（`getRoomStatus` 里的"已运行 X 秒"）长到不合理，可以随时主动通过 `terminateAgentSession`（见 3.5）强制终止——"多久算太久"完全由人类自己判断，系统不做自动终止。
- **人类消息的认知权重优先级**：人类发的消息带 `source: human` 标记，agent 被明确告知应更重视人类的判断；但系统依然不做任何强制覆盖/自动改写——遵循"只追加不覆盖"的原则。人类消息在**派发规则**上没有特权，跟其他实质消息一样只是一种触发源，不抢排队顺序。

### 3.3.1 非交互式 Session 生命周期

统一以一次性非交互 CLI 调用执行任务，可持续调用工具、通过 MCP 发送多条消息并实时显示 stdout/stderr。完成当前工作后 CLI 自然退出，无独立完成工具、无 TUI 退出指令、无交互式 fallback。每次启动使用独立配置和固定 session 凭据，防止迟到消息进入下一次调用。

自然零退出且存在本 session 的 agent 实质消息记 completed，无实质消息记 passed；异常退出或启动失败记 error。产出只通过 MCP 入库，日志不解析答案、不转为 fact。正常结束不自动完成 exploring，也不自动结束 room。

人类通过房间消息指导协作，忙碌 session 不被推送或打断；agent 可主动调用 get_overview 刷新，但人类新消息不保证立即生效。需要停止当前方向时，可先暂停房间，再终止具体 session。

人工终止进入 stopping 并撤销写权限，通过 SIGTERM、默认 2 秒宽限、必要时 SIGKILL 与默认 3 秒退出确认清理。确认主进程退出或从未启动后才记 terminated、释放 agent；失败保持 stopping 与占位，提示人工重试。running 任务没有时长或无输出超时。

生命周期记录仅在 session 详情展示，不进入消息、共享记忆或派发 prompt。终态撤销凭据、拒绝迟到写入。原始日志可实时只读查看或历史回放，关闭查看界面不影响进程。历史消息不回删。

### 3.4 错误处理（默认策略）

- 某个 agent 的调用失败（进程报错退出）：记为一次系统消息（说明该 agent 这次 session 出错），该 agent 变回空闲，触发一次新的派发检查（见 3.3），不中断整个房间；这条占位消息在事件树里的呈现见 3.5。

### 3.5 编排器内部接口（服务自己的前端，不是 MCP）

MCP 协议只暴露给外部 agent CLI。编排器后端和它的网页前端之间是另一套完全独立的内部接口，直接读写共享的底层存储，不经过 MCP 协议——包括人类发消息。

**实时通道**：WebSocket，浏览器和编排器后端之间一条双向连接。服务端推送新消息、记忆变化、房间状态变化；人类发消息也从这条连接直接发出。

**原始消息流**：cursor 分页，`listMessages(roomId, cursor?, limit?)`，默认加载最新一批，向上滚动时加载更早的历史（聊天软件式体验），不受 agent 那套"省 context"的摘要限制。

**记忆视图**：`getMemoryView(roomId)`，给前端看的是**全文**而不是摘要（摘要是为 agent 省 token 设计的，人类看网页没有这个限制），按类型分组，`exploring` 额外带 `status`。前端展示为**渐进式**结构——先是一条**记忆总线**（各类别的索引与计数，默认不展开），点击某个类别才下钻展开该类的条目列表，再点条目查看全文；不是一上来把所有类别的所有条目平铺出来。

**room 管理**：
- 有独立的 room 列表页（浏览已建的 room、新建），列表展示创建时填的 `name`（简短标题）。
- 参与的 agent 名单在创建时确定，**v1 不支持中途增减**（保持简单，避免"新加入的 agent 要不要立刻给一次 session"之类的调度细节）。
- 创建时选定 `schedulingMode`（见 3.3），创建后不可更改（换调度模式相当于换了一种完全不同的运行方式，只能新建 room）。v1 只有 `"sequential"` 一个可选值。
- 创建时可选指定 session 总数上限 `maxSessions`（见 3.3）；不填用服务端默认值。创建后不能直接改，只能用 `resumeRoom(additionalSessions)` 追加。
- 创建时可选指定工作目录 `workdir`（见第 1 节）；不填用服务端默认目录。该 room 所有 agent 的 CLI 都在这个目录下运行，创建后不可更改。
- 创建时**不**填任务目标；`name` 只是列表展示用的标题，跟 `get_overview.goal`（房间里第一条消息的内容）是两个不同的东西，互不冒充（见 4.4）。
- 只有 `completed`（已结束）的房间才可以**删除**；`active`/`paused_*` 状态的房间不可删除。删除会级联清掉这个 room 的 session、消息（信息流）、记忆（含 `exploring` 记录与状态）、事件树，以及磁盘上的原始执行日志与 prompt 文件，**不可恢复**。

**房间状态（`getRoomStatus`，随实时通道推送）**：
- 累计 session 数（当前最新的 `sessionId`）、room 状态（进行中 / 已暂停（因 session 数上限或人类主动 `pauseRoom`）/ 已结束）；`propose_completion` 只触发前端提醒，不是独立的房间状态。
- 每个 agent 的实时状态：`{ agentId, state: "idle" | "running" | "stopping", sessionId?, sessionStartedAt?, activeExploringSummary? }`。`sessionId` 在 `running`/`stopping` 状态下必须给出——人类要查看详情或终止，都是对着一个具体的 session 操作，不是对着 agent 本身，这个字段是两者之间的唯一定位手段。`running`/`stopping` 状态下前端据此显示"已运行 X 秒"——这也是人类判断"是不是跑太久了"的唯一依据（系统不做自动超时判定，见 3.3）。
- 是否有 agent 疑似卡住（active `exploring` 连续 N 次被派发到它自己都无新消息，N 见第 9 节），判定逻辑在后端算好，前端只展示。

**事件树**：不再有独立的 session 节点——每一行都是一条消息，严格按消息的真实发生时间排成一条竖直时间线，agent 之间允许并发（见 3.3）产生的交织顺序如实保留，不会因为"同属一个 session"被打包挪到一起。

agent 在 session 里发的每条消息都带着这次 session 的 `sessionId`（见 4.2），在树上显示为一个"归属标签"（哪个 agent 的第几次 session），点这个标签直接打开这次 session 的详情（3.1 的"单 session 详情查看"）；**人类消息没有 `sessionId`**，没有这个标签，按真实时间独立成节点，跟 agent 消息混排（哪条人类消息触发了哪次 session，仍然靠时间顺序看，不靠 `sessionId` 关联）。

`passed`（自然结束但没发过任何带 type 的实质消息）、报错、以及被人工终止，都会由编排器核心补写一条无 type 的系统占位消息（见 3.3、3.3.1、3.4），带上这次 session 的 `sessionId`——这样它们也能用同一套"消息即节点"的机制留痕，不是无痕迹地跳过，也不需要为它们单独设计一种"session 节点"。

反应类消息（`endorse`/`challenge`/`verify`，以及带 `targetMessageId` 的"追问"式 `open_question`）在树上对目标消息画一条关联线；`chain` 若带 `referencedMessageIds`，同样对每个引用的消息画一条关联线。主轴就是真实时间，这些关联线两端在时间线上通常本就相邻或接近，先后与因果关系一望而知。

**`exploring` 完成后的展示**：保留可见，标灰/打"已完成"标签，不从视图中消失——与"只追加不覆盖、一切可追溯"的原则一致。

**单 session 详情**：按固定 sessionId 查看消息、生命周期和只读执行日志。AgentRail 入口显示实时只读日志，事件树入口显示详情与日志快照。运行期间可人工终止，不提供终端输入；已结束保留回放。

**强制终止**：`terminateAgentSession(roomId, sessionId)`——操作对象是**一次具体的 session**，不是 agent 本身（`sessionId` 从 `getRoomStatus` 的对应 agent 状态里拿，见上）。人类随时可主动调用，不需要先等"卡住提醒"触发。做三件事：(1) 如果这次 session 的底层进程还在跑，尽力终止它（按进程组终止，部分 CLI 无法保证清理干净其内部再拉起的子进程）；(2) 把这次 session 所属 agent 当前 active 的 `exploring`（如果有）标记为 `completed`，附带系统备注"人类强制终止"（不引入新的 `status` 值，仍是 `active`/`completed` 二态，见 4.6）；(3) 把这次 session 所属的 agent 状态设回空闲（从 `running`/`stopping` 回 `idle`），可以正常被派发。

**人类发消息**：`postHumanMessage(roomId, content, type?, targetMessageId?)`，直接写入底层存储（不经过 MCP），`authorId` 固定为保留值 `"human"`。支持跟 agent 的 `post_message` 同样丰富的 `type`/`targetMessageId`——人类可以直接对某条结论做 fact/hypothesis/challenge/verify/追问等结构化发言，而不只是纯聊天，这样才能正确进入事件树和对应的记忆层。

**房间生命周期控制**：人类可以随时主动调用，不需要等任何 agent 先发信号——`propose_completion` 只是触发前端提醒，不是这些操作的前提：
- `confirmCompletion(roomId)` —— 结束房间，之后转为只读（见 7）。
- `pauseRoom(roomId)` —— 人类随时主动暂停（不同于因 session 数上限触发的自动暂停）。
- `resumeRoom(roomId, additionalSessions?)` —— 继续一个暂停的房间。若房间是**因触及总 session 数上限**而暂停的，`additionalSessions` **必填**（不传报错）——必须明确再给多少次 session，才能设定新的上限。若房间是**人类主动 `pauseRoom`** 暂停的（原上限还没到），`additionalSessions` 可省略——原有的上限和剩余额度继续有效。
- `deleteRoom(roomId)` —— 删除一个**已结束（`completed`）**的房间（见上文"room 管理"）；`status` 不是 `completed` 时调用会被拒绝。删除是级联、不可恢复的。

## 4. MCP Server

### 4.1 房间

- 一个常驻本地服务，管理多个 room，用 `roomId` 区分。所有 agent 共用服务地址，每次 session 使用独立连接配置与固定身份凭据。

### 4.2 消息与写入

所有新消息统一走一个工具：

```
post_message({
  roomId,
  authorId,
  content: string,
  type?: "fact" | "hypothesis" | "boundary" | "open_question"
        | "chain" | "exploring" | "propose_completion"
        | "endorse" | "challenge" | "verify",
  targetMessageId?: string,   // reaction 类型（endorse/challenge/verify）必填；
                              // open_question 可选填，表示"追问"某条具体消息
  referencedMessageIds?: string[],  // 仅 chain 可选填，标注这条方案依赖的 fact/hypothesis 等消息 id
  summary?: string,           // 可选；不提供时系统自动截断 content 作为摘要
})
```

- `type` **可选**：不传 type 的消息就是纯聊天/过渡性发言，只出现在原始消息流里，不进入任何记忆层（避免强制归类导致的噪音和污染）。
- 消息一旦发出，`type` 和 `content` **永不改写**（只追加，不覆盖）。唯一的例外是 `exploring` 类型自带的 `status` 字段，见 4.6。
- `sessionId` 是 **session 的属性，不是消息的必备字段**：一个 agent 在它的一次 session 里发的每条消息，都会被打上这次 session 的 `sessionId`（agent 不可自行指定，系统在写入时自动填充，作为这次 session 的产出记录，供事件树按 session 组织使用，见 3.5）。人类通过 3.5 的 `postHumanMessage` 发的消息**没有 `sessionId`**——它不是任何 session 的产出，这个字段对它不适用，不是留空/置 null 的特殊情况，而是概念上就不存在。两者共享同一份底层存储，只是 `sessionId` 这个字段只在"由某次 session 产出"的消息上才有意义。
- 另有一个专用工具 `complete_exploring(roomId, authorId, messageId)`，只用于把一条 `exploring` 记录标记为完成，不通过 `post_message`。

### 4.3 记忆类型定义

| type | 含义 |
|---|---|
| `fact` | 已确认的事实 |
| `hypothesis` | 针对某个 `open_question` 提出的候选答案，尚无定论 |
| `boundary` | 已确认走不通的路径/死胡同 |
| `open_question` | 尚无人给出候选答案的空白问题；可选带 `targetMessageId`，表示"追问"某条具体消息，而非全新问题 |
| `chain` | 一条从输入到输出的候选端到端方案；可多条并存，**没有系统自动裁定的"当前最优"**——所有 chain 一律平等地列出摘要，由 agent/人类自己判断取舍；可选带 `referencedMessageIds`，标注依赖了哪些 fact/hypothesis（非强制，不填就只在 `content` 里用文字描述） |
| `exploring` | 某个 agent 正在探索某方向的状态广播（用于防止重复劳动）。**是唯一一个有状态、非纯追加的类型**，详见 4.6 |
| `propose_completion` | agent 认为任务可以结束了，发出的一次性信号。触发前端提醒，但不自动结束房间——只有人类调用 `confirmCompletion` 才真正结束，见 3.5 |
| `endorse` / `challenge` / `verify` | 对某条已有消息（`targetMessageId`）的赞同/质疑/验证，纯注解，不改变原消息的 type，不触发任何自动的状态流转 |

**开放问题 vs 假设**：`open_question` 是问题本身（还没人回答），`hypothesis` 是对某个问题给出的候选回答（还没被认定为定论）。二者概念不重复。

### 4.4 记忆读取：概览 + 按需深挖

两个粒度的读取工具：

**`get_overview(roomId)`** —— 每个 agent 被派发一个新 session 时自动获得，**只给摘要/索引，不给全文**：

```
{
  goal: "任务目标文本",  // 不是单独存储的字段，取房间里第一条消息（人类发的）的 content
  facts: [{ id, summary }],
  boundaries: [{ id, summary }],
  openQuestions: [{ id, summary }],
  chains: [{ id, summary }],           // 全部候选方案，一视同仁，不挑"最优"
  activeExploring: [{ agentId, summary }],  // exploring 类型消息里 status=active 的那些，按 agent 分组的实时快照
  hypotheses: [{ id, summary }],       // 索引/摘要，同样不给全文
  recentRawMessages: [...]             // 最近 4 条不分类型的原始消息（默认，可配置）
}
```

**`get_detail(roomId, messageId | { type })`** —— agent 按需调用，拿某条或某类记忆的完整内容（包括它挂载的所有 endorse/challenge/verify 注解）。按 `type: "exploring"` 查询时返回**该类型下的全部记录，不分 active/completed**——这是深挖历史的工具，跟 `get_overview` 里只给 active 快照的 `activeExploring` 是两回事。

### 4.5 只追加、不覆盖（`exploring` 除外，见 4.6）

- 除 `exploring` 外，所有类型（facts / boundaries / hypotheses / chains 等）都是追加式的，没有"当前唯一状态"字段会被覆盖，也没有系统自动挑出的"当前最优"。
- 一个 `hypothesis` 被 `verify` 后，**不会**自动升级为 `fact`；一个 `fact` 被 `challenge` 后，**不会**自动降级。系统只如实累积展示原始事件（谁验证/质疑了什么），最终"信不信"的判断权留给读取记忆的 agent 和人类。
- 多条 `chain`（候选方案）、多条 `boundary`（死胡同）可以同时并存，互不覆盖。

### 4.6 `exploring` 的状态机（唯一的例外）

一个 agent 同时只能有一条 **active** 的 `exploring` 记录，其余类型都不需要"当前状态"这种东西，唯独 `exploring` 需要——因为它代表的是"正在做的事"，必须能被标记为完成，否则会一直误导其他 agent。

- 每条 `exploring` 记录带一个 `status: "active" | "completed"` 字段。
- **自动顶替**：agent 发一条新的 `exploring` 消息时，系统自动把它自己名下之前那条 active 的 `exploring`（如果有）标记为 `completed`。agent 换方向不需要额外操心。
- **显式完成**：agent 探索完一个方向、但还没想好下一个方向时，调用 `complete_exploring(roomId, authorId, messageId)`，把当前 active 的记录标记为 `completed`。
- **人类强制完成**：人类也可以通过 3.5 的 `terminateAgentSession` 把它标记为 `completed`（带"人类强制终止"的系统备注），不需要 agent 自己配合。
- 不做超时自动完成（讨论过，明确不要）。如果一个 agent 的 active `exploring` **连续 N 次被派发到它自己**都没有任何新消息（注意：是这个 agent 自己被派发的连续次数，不是全局连续 N 次 session——房间里其他 agent 被派发的次数不计入这个计数），只在 UI 上给人类一个提醒，具体怎么处理由人类自己决定（见 3.1、3.5）。
- `status` 的变更**只发生在 `exploring` 这一种类型上**，其他所有类型永远不会有字段被事后修改。

## 5. agent 身份与"接手"

- 不引入正式的"席位/交接"概念。所谓"接手"就是被 3.3 的派发规则选中的下一个空闲 agent（不管是不是同一类型的第一次参与）。
- 任何 agent 读取 `get_overview` 时，都会被明确告知："以上是聊天室的既有记忆，仅供参考，请形成你自己的判断——可以采纳、组合、推翻，也可以提出全新方案。"

## 6. 去中心化协调

- 不设协调者角色，**跨 agent** 之间没有系统强制的方向锁——不同 agent 探索的方向是否重复/冲突，完全靠 agent 自己读 `activeExploring` 判断避让，系统不做语义去重。
- 系统只对**单个 agent 自己**强制一条规则：同时只能有一个 active 的 `exploring`（见 4.6），这是并发状态管理，不是跨 agent 的协调裁决。
- "避免重复探索"依赖：(a) `exploring` 广播（agent 开始探索前先声明方向）+ (b) 其他 agent 自己读取 `activeExploring` 后自行判断避让。不同 agent 之间本来就可能同时在跑（见 3.3，`sequential` 只保证单个 agent 自己不会跟自己并发，不是房间级别的互斥），所以**不存在任何调度层面的防抢占保护**——两个 agent 完全可能在几乎同一时刻各自读到"没人在探索 X"、然后都去声明探索 X，这是去中心化设计本身接受的代价，不因 `schedulingMode` 是 `sequential` 还是 `parallel` 而改变。

## 7. 任务生命周期

- **创建**：简短房间名 + 勾选参与的 agent + 选择 `schedulingMode`（v1 只有 `"sequential"`，见 3.3）+ 可选设置 `maxSessions`（不填用服务端默认值，见 3.3）+ 可选设置 `workdir`（不填用服务端默认目录，见第 1 节）。创建时不填任务目标——人类进房间后发的第一条消息才是真正的任务描述，见 3.1。
- **进行**：按 3.3 的调度模型运作。
- **完成**：任一 agent 可以发一条 `propose_completion` 消息说明理由，触发前端提醒；但人类不需要等这个信号，随时可以主动调用 `confirmCompletion` 结束房间（也可以随时 `pauseRoom`/`resumeRoom`），见 3.5。
- **产出**：**没有独立的总结生成步骤**——记忆的最终状态（尤其是 `chain`/facts 层）本身就是产出物，人类直接查看。
- **删除**：room 结束后转为只读，默认保留供随时查阅；人类也可以显式删除一个已结束的 room——级联删除它的 session、记忆、事件树、信息流与磁盘原始日志、prompt 文件，不可恢复。未结束的房间不可删除（见 3.5）。

## 8. 明确排除的范围（v1 不做）

- 不做代码工作区隔离（git worktree 等），不内置任何编码专属工具。（room 的 `workdir` 只是给进程设 cwd，不是隔离，见第 1 节。）
- 不做协调者/中心裁判角色。
- 不做记忆的自动状态机（不自动把 hypothesis 升级为 fact，反之亦然）。
- 不做正式的"agent 席位/交接"机制。
- 不做任务结束后的自动总结文档生成。
- 不做多用户鉴权（本地单用户工具）。
- 不做同一层内的语义级冲突检测（比如"看数据库层"和"看连接池"是否算重复方向），完全交给 agent 自己判断。

## 9. 待细化的实现细节（非架构决策，实现时按合理默认处理）

- `get_overview` 中各字段的摘要截断长度、`recentRawMessages` 的具体条数（已定为默认 4 条，可通过服务端配置调整）。
- MCP server 与编排器之间的具体协议/端口，本地存储格式（如 SQLite）。
- 触发"卡住提醒"的具体阈值 N（单位是该 agent 自己的连续操作次数，见 4.6）。
- Agent 注册表配置文件的具体 schema 细节。
- `schedulingMode` 除 `"sequential"` 外的其他模式（如 `"parallel"`）的具体调度逻辑——v1 不实现，只预留参数位置（3.3）。
