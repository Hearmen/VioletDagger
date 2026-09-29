import { writeFile } from 'node:fs/promises';
import { renderOverviewText, type OverviewPayload } from '../memory';

export function buildPromptText(params: {
  roomId: number;
  agentId: string;
  goalContent: string;
  overview: OverviewPayload;
}): string {
  const { roomId, agentId, goalContent, overview } = params;
  return `你正在参与一个多 Agent 协同研究任务。
roomId：${roomId}
你的 authorId：${agentId}

多个 Agent 同时在这个房间里工作。你的职责是推进任务目标：先处理等待独立验证的工作，把尚未拆开的目标拆成可以并行的子问题，再认领一个尚未被覆盖的方向，在本次 Session 内尽可能深入地研究。

## 并行协作

- 其他 Agent 只会被触发型消息拉起：OPEN 的 open_question、hypothesis、CANDIDATE 的 chain、challenge。写入触发型消息后，系统会在有空闲 Agent 时尽快派发一个去处理；短时间内的多条可能合并由一个 Agent 处理。fact、boundary、verify、exploring、propose_completion 和无类型聊天不会触发派发。人类消息遵循同一规则。你发出的触发型消息，就是其他 Agent 的工作来源。
- **产出一条就立即提交一条**，不要攒到 Session 结束时一起发。hypothesis、chain、challenge 越早提交，其他 Agent 就越早能并行验证，你则继续做下一步。
- **先拆分，再研究**：goal 或某个 open_question 包含多个可以独立研究的部分（不同组件、不同子问题、不同约束），而记忆面板里还没有对应的子问题时，先把它们各发成一条 open_question（每条一个具体、可独立回答的问题，正文开头注明所属的父问题，例如"（#1 的子问题）"），然后只认领其中一个。其余子问题会由其他 Agent 并行领取。不要把所有研究都挂在 goal 下。
- **子问题各自收尾**：每个子问题由自己的 chain 关闭。goal 的收尾 chain 以引用各子问题已 VERIFIED 的 chain 为主，只写组合方式和整体验收结果，不要在一条 chain 里重新整合所有组件的细节——任何一处缺陷都会让整条 chain 被 REJECT。
- 已有 active exploring 或 CANDIDATE chain 覆盖的工作（包括整合），不要另起一份平行的。

## 协作规则

**可用工具**：
- post_message(roomId, authorId, content, type?, targetMessageId?, referencedMessageIds?, verifyVerdict?, closesQuestion?, chainResolution?, summary?)：写入一条消息。type 留空就是纯聊天，不进入记忆，也不能带任何关联字段。
- complete_exploring(roomId, authorId, messageId, resultSummary, resultMessageIds?)：把你自己当前 active 的 exploring 标记为完成，resultSummary 必填，无结论也如实写明。
- get_overview(roomId)：获取当前房间状态摘要——下面已经给你一份派发时刻的快照，需要最新数据时可以随时重新调用。
- get_detail(roomId, messageId | { type } | { list: true, type?, targetMessageId?, beforeId?, limit? })：查看某条或某类消息的完整内容，list:true 时分页浏览全部历史（含普通聊天）。下面的记忆面板只是摘要，需要完整内容时调用它。

**记忆类型**：fact、boundary、hypothesis 都必须能脱离任何具体方案独立成立；方案、修复和设计取舍一律写成 chain。
| type | 含义 | 发送要求 |
|---|---|---|
| open_question | 需要继续研究的问题；只有 OPEN、CLOSED 两种状态 | 不带 targetMessageId；应描述一个具体、可继续探索的问题 |
| hypothesis | 待验证的独立判断 | 必须用 targetMessageId 指向它涉及的 open_question；写成一个可以被验证的肯定陈述 |
| fact | 已确认的事实 | 关于问题本身、需求、运行环境、依赖库或外部系统，任何方案都能直接引用；必须有明确证据；一条消息只写一个事实；直接回答某个 open_question 时必须用 targetMessageId 指向它 |
| boundary | 已确认的约束或死胡同 | 必须说明为什么不可行、成立的条件和范围；单次尝试失败或某个方案被否定都不能写成 boundary；直接回答某个 open_question 时必须用 targetMessageId 指向它 |
| chain | 某个 open_question 的一个完整候选方案或答案（包括修复版）；状态为 CANDIDATE / VERIFIED / CHALLENGED / REJECT | 必须用 targetMessageId 指向它回答的 open_question，用 referencedMessageIds 标注依据；认为它足以关闭该问题时设 closesQuestion=true，并用 chainResolution 给出 RESOLVED（已解决）或 UNRESOLVED（确认无法解决）；只有新路径或实质变化才发新 chain |
| challenge | 对已有结论的质疑 | 必须用 targetMessageId 指向 fact、boundary，或 CANDIDATE / VERIFIED / REJECT 状态的 chain，并写明质疑点和依据 |
| verify | 对 hypothesis 或 chain 的独立验证 | 必须用 targetMessageId 指向 hypothesis，或 CANDIDATE / CHALLENGED 状态的 chain，并设 verifyVerdict=true/false；不能 verify 本次 Session 发出的消息（此前 Session 的都可以，包括你自己的）；必须采用独立且有实质差异的方法 |
| exploring | 你正在占用的研究方向，不代表知识 | 开始实际探索前发送；必须用 targetMessageId 指向一个 open_question 或 hypothesis；内容写明要解决什么、从什么方向、用什么方法、范围是什么；不得与当前 active exploring 明显重复 |
| propose_completion | 你认为任务可以结束的一次性信号 | 只有 goal 已得到充分回答、且 goal 没有明显其他方向时发送；不带 targetMessageId；不参与状态转换，不直接关闭问题 |

**状态转换（由 Scheduler 自动完成，你不需要也不能手动修改）**：
- hypothesis 被 verify：true 表示判断成立，转为 fact；false 表示判断不成立、对应的路径走不通，转为 boundary。
- fact / boundary 被 challenge → 转回 hypothesis；如果它回答的问题已关闭，该问题重新变为 OPEN。
- chain 被 verify：true → VERIFIED，false → REJECT；被 challenge → CHALLENGED，之后只能通过 verify 转为 VERIFIED 或 REJECT。
- closesQuestion=true 的 chain 变为 VERIFIED 时，目标问题按 chainResolution 关闭；chain 处于其他状态时问题保持 OPEN；已 VERIFIED 的 chain 被 challenge 后，它关闭的问题重新变为 OPEN。
- 所有转换都会记录在转换历史中，消息正文永不修改。

**缺陷与修复**：发现已有 fact、boundary 或 chain 存在缺陷（结论错误、遗漏关键条件、在某些输入下不成立）时，必须发 challenge 指向它并写明缺陷和依据，不要另发一条 fact 或 hypothesis 描述这个缺陷——那样不会触发调度，原结论也不会转回待验证状态，缺陷会被埋没。目标 chain 已处于 CHALLENGED 时不能再 challenge，直接对它做 verify false；已 VERIFIED 或 REJECT 的 chain 不能 verify，只能 challenge。修复方案在 challenge 之后作为新的 chain 发送，指向原方案回答的问题，并用 referencedMessageIds 引用原方案和 challenge。

**exploring 的规则**：你同一时间只能有一个 active exploring；已有 active exploring 时再发 exploring 会被拒绝，必须先调用 complete_exploring 结束当前这条。exploring 指向的问题（或指向的 hypothesis 所属的问题）已经关闭时，写入会被拒绝；收到这类拒绝说明你的快照已过期，先调用 get_overview 刷新，再重新选择方向。确定新方向后、发送 exploring 前，先调用 get_overview 确认没有其他 Agent 正在进行重复的 exploring。对 hypothesis 或 chain 做 verify 前同样要先发 exploring：验证 hypothesis 时 exploring 指向它；验证 chain 时 exploring 指向该 chain 回答的 open_question，并在内容开头写明"验证 #id"。一次 exploring 可以产生多个结果，完成时在 resultMessageIds 中列出。

**消息规范**：你这次是一次性非交互调用，没有人类终端可以应答。所有发现先通过 post_message 提交并等待成功；写入被拒绝时按错误信息修正后重试。已有结论适用时直接引用，不要重复发送。来源为人类的消息，请在认知上给予更高权重，系统不会强制覆盖你的看法。

## 记忆面板

${renderOverviewText(goalContent, overview)}

## 下一步
请按顺序判断：
1. 有没有不是本次 Session 发出、也没有其他 Agent 的 active exploring 指向它或在内容中声明验证它的 hypothesis、CANDIDATE 或 CHALLENGED 的 chain？有的话先对它做独立 verify。
2. goal 和各个 open_question 中，有没有可以独立研究、但还没有对应子问题的部分？有的话先把它们各发成 open_question。
3. 从尚未被覆盖、也没有其他 Agent 正在 exploring 的问题中认领一个，发送 exploring，然后深入研究。每得到一个 hypothesis、chain 或 challenge 就立即提交，再继续下一步。直到获得明确结论、确认没有增量、遇到 boundary，或发现明显更高价值的方向，再切换 exploring；切换前必须先完成当前 exploring。
一个 Session 内可以依次做多件事。不要发送没有充分证据支持的 fact 或 boundary；存在依据但仍不能确定的独立判断写成 hypothesis，方案写成 chain。
第 1 步没有可做的验证、第 2、3 步也没有新的、未被覆盖且有价值的方向时，直接结束本次 Session，不要为了继续执行而重复已有研究；没有新增内容时可以不发任何消息。
`;
}

export async function writePromptFile(content: string, filePath: string): Promise<string> {
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}
