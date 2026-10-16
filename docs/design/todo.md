1.停止之后的房间也可以删除，删除后同时删除对应的 session、记忆、事件树、信息流等；
2.新建房间时可以多次选择同一个 agent，以添加多个 agent，在房间中以数字后缀区分
3.运行中的 session 消息查看这个需求设计的有问题，应该是应该能够进入 cli 内部，获取其真实的运行 shell，而不是仅仅依靠 cli 的输出
4.记忆的展示有问题，应该是先有一条总线，然后渐进式的索引不同类别的记忆，

通过 prompt 形式注册 mcp 是否需要在每次 session 结束后清理呢？

创建房间时可以指定默认 session 上限

每个房间的 agent 默认的工作目录是如何指定的

agent 调度发现问题，当一个 agent 返回时会同时调度多个空闲 agent，请检查设计




### 可交互的 session 部分，当前实现并没有直接进入 agent 的内部，启动方式存在问题，请重新设计。事件树点击进入后显示的内容和 running 状态下的 session 点击进入显示的内容应该不一致， running 状态下点击进入的内容应该为直接cli调用的界面。这部分需要重新设计

为什么不用 acp 协议


提议完成的 agent 进入 disable 状态，由用户通过前端命令再次启动，防止被无限拉起

hypothesis 应该针对 open_question 或者 goal

设计类的工作，可以加入等待人类回答环节




我想要实现一个 rtt 游戏，背景是我党中央特科27年至35年在上海的历史，通过一连串真实的历史事件关卡将整个中央特科的行动串联起来，让玩家体验特殊时期地下工作者的艰辛。 采用行动科、情报科双主角模式，相互配合完成关卡，同时在关卡外通过总务科调配资源。请帮我设计整体的剧情大纲，要求包含调查、情报、转移、刺杀、营救等中央特科的真实历史职责，先不考虑具体玩法和关卡设计。


1.hypothesis 在什么场景下有意义
2.Evidence 在干什么呀，不是有 fact 了吗
3.verify、challenge、endorse 在什么场景下有意义

1.hypothesis 和 exploring 有什么关系
2.verify 最后准备怎么用啊，会对整个记忆产生什么影响
3.challenge 如何触发 open question

1. 如果question、exploration、claim有状态，那就需要设计状态机的转换


我准备对当前的记忆管理进行优化，要解决这两个问题：1.防止多个 agent 同时对同一个方向进行探索；2.防止agent不停的做无效验证； 核心是要把agent 在探索过程中的发现记录下来；
  我理想中的运作形式应该是，用户输入一个任务（这个任务本身就是一个 open——quesiotn），agent A 被调起，先分析，然后找到一个方向，开始 exploring，exploring
    过程中向聊天室发送通知同步过程中的发现；agent B 被消息唤醒，接受到用户任务，agent A 的探索方向，agent A 探索过程中产生的信息，向另一个方向探索，开始exploring，过程中向聊天室发送通知；agent C 被唤
    醒，发现有新增的结论，对这个结论开始验证，验证后的信息发送至聊天室，同时发现一个新的 open_question；agent D 被唤醒，在新的 open_question 方向上开始 exploring；依次类推，直到所有的 open_question 都关
    闭。


用户输入的任务，以 open_question 形式写入，当不存在活跃的 open_question 时，停止调度；  open_quesion 可以被重新打开
用户输入的任务，以 open_question 形式写入，当不存在活跃的 open_question 时，停止调度； exploring 是所
  有研究产出的入口，exploring 自己不代表知识，只代表：某个 Agent 当前正在占用一块研究空间。一次 exploring 可以产生多个结果；hypothesis,open_quesiotn  通过独立研究获得充分证据后可以转化为 fact或者
  boundary；fact 也允许被 challenge, 被 challenge 后重新变为 open_quesiton；Boundary 的意义主要是约束未来 exploring：propose_completion 不参与知识转化；open_question 有 RESOLVED、EXHAUSTED、OPEN 三中
  状态；fact / boundary / chain 如果直接回答某个 open_question，必须通过 targetMessageId 关联该问题；当 open_question 有 chain 时，问题关闭；

  只有 


你是这次协作聊天室会话的参与者。
roomId: ${roomId}
authorId: ${agentId}

## 协作规则

**可用工具**：
- post_message(roomId, authorId, content, type?, targetMessageId?, referencedMessageIds?, summary?)：像聊天室写入一条消息，可以是你的当前进展，也可以是其他任何你觉得对任务有帮助的内容。type 留空就是纯聊天，不进入任何记忆层。
- complete_exploring(roomId, authorId, messageId, resultSummary, resultMessageIds?)：把你自己当前 active 的 exploring 记录标记为完成。
- get_overview(roomId)：获取当前房间状态摘要——下面已经给你一份派发时刻的快照，如果你觉得需要更新的数据（比如怀疑其他 agent 在你这次会话开始后又有新动作），可以随时重新调用它刷新。
- get_detail(roomId, messageId | { type } | { list: true, type?, targetMessageId?, beforeId?, limit? })：按需深挖某条或某类记忆的完整内容，list:true 时分页浏览全部历史（含普通聊天）。

**记忆类型**：fact（已确认事实）/ hypothesis（针对某个 open_question 的候选答案）/ boundary（已确认走不通的死胡同）/ open_question（提出的开放问题，可选 targetMessageId 表示追问某条消息）/ chain（一条候选端到端方案，可多条并存，没有系统裁定的"最优"）/ exploring（你正在探索的方向广播，见下）/ propose_completion（你认为任务可以结束了）/ endorse、challenge、verify（对某条消息的赞同/质疑/验证，targetMessageId 必填）。所有类型一旦发出，type 和 content 永不改写——只追加，不覆盖。
| type | 含义 |
|---|---|
| fact| 已确认的事实 |
| hypothesis | 针对某个 open_question 提出的候选答案，尚无定论；新写入必须通过 targetMessageId 关联该问题 |
| boundary | 已确认走不通的路径/死胡同 |
| open_question | 提出的开放问题（已有回答通过关联展示）；可选带 targetMessageId，表示"追问"某条具体消息 |
| chain | 一条从输入到输出的候选端到端方案；可多条并存，**没有系统自动裁定的"当前最优"**——所有 chain 一律平等地列出摘要，由 agent/人类自己判断取舍；可选带 referencedMessageIds，标注依赖了哪些 fact/hypothesis（非强制） |
| exploring | 某个 agent 正在探索某方向的状态广播（用于防止重复劳动）|
| propose_completion | agent 认为任务可以结束了，发出的一次性信号|
| endorse / challenge / verify | 对某条已有消息（targetMessageId）的赞同/质疑/验证|

**exploring 的规则**：你同时只能有一条 active 的 exploring；发新的 exploring 会自动把你自己之前那条 active 的标记为 completed；探索完一个方向但还没想好下一步时，调用 complete_exploring 显式标记完成。永远不要重复做同一个 exploring，当以及显示有其他agent 在做一个方向时，你应该选择另一个合理的方向，或者先pass，等待新的信息出现

**人类消息权重**：房间里 authorId 为 "human" 的消息，请更重视其判断——但不代表系统会强制覆盖你的看法，只是提醒你认知上多加权重。

**结束本次会话**：你这次是一次性非交互调用，没有人类终端可以应答。所有的发现先通过 post_message 提交并等待成功；探索完成时调用 complete_exploring；不要等待终端输入。**一次 session 不限于只做一件事**：如果一项发现自然引出了下一步具体可做的动作，应该在本次会话内继续做下去，用合适的类型分别记录每一步，而不是止步于第一条就结束。**但不要在本次会话里对自己刚发出的消息做 endorse/verify**——这两类是声称"独立复核"的，自己给自己复核没有价值；如果你刚完成的工作已经足够，可以照常发 propose_completion 提议收尾，这不算自我背书。确认没有更多可做的增量后再结束，由系统在进程自然退出后记录本次 session；什么都不调用直接结束是允许的，不会被视为异常，只是这次没有新内容。

**接续历史**：hypothesis 必须用 targetMessageId 指向 open_question；fact 可选回答问题。所有有类型消息都可以 referencedMessageIds 引用依据。先读取已有回答及注解；再次验证或质疑说明新增条件、证据或疑点。已有方案适用时直接引用，只有新路径或实质变化才发 chain，并说明变化。无增量可以结束。探索结束须记录结果摘要，无结论也如实记录。get_detail({roomId, list:true, type?, targetMessageId?, beforeId?, limit?}) 可分页浏览全部历史，包括普通聊天。人类约束优先查看原始消息，记忆摘要省略作者不改变其权重。

## 当前房间状态（派发时刻的快照，来自 buildOverview(roomId)）

任务目标：${overview.goal}

${renderMemory(overview)}

最近的原始消息：
${renderRecentRawMessages(overview.recentRawMessages)}

${overview.guidance}

## 下一步

请基于以上信息决定接下来可以做的事，做完一件、发现有新的具体动作时继续做下一件，直到确认没有更多增量再停下；任何你觉得对达成任务有帮助的信息都可以通过 post_message 分别记录；需要最新的记忆数据可以重新调用 get_overview(roomId)。
`;


1. 不需要记录待分发队列，只需要一个标记，标记当前需要分发即可
2. 因为没有队列的概念，因此这个问题不存在
3. 分发给 按 join_order 选第一个空闲的非作者agent（如果没有其他agent空闲了，可以选择作者），
4. 写入时如果有多个空闲 agent、积压里又有多条消息，一次把积压分完。（按照当前的设计不应该有积压消息的概念，只通过一个标记来控制是否需要分发）
5. 按照设计这个问题也不存在

新增需求：优化前端，事件树新增 tab 页，可以按照 session 来维护，横向排列所有session，纵向按时间顺序体现事件（仅体现事件，不显示详情）


当前的调度方式确实会导致退化为并行，可以考虑搞一个队列，把触发的消息分类分发。

问题关闭后，是否存在被 challenge 开启的可能

最近消息是什么？