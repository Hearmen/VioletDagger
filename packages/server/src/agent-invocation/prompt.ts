import { writeFile } from 'node:fs/promises';
import type {
  ChainOverview, ExploringOverview, KnowledgeOverview, MessageSummary, OverviewPayload, QuestionOverview,
} from '../memory';

// renderMemory 的渲染格式见 docs/design/04-agent-invocation.md §2.2；取数规则见 02 §3。

function refs(ids: number[]): string {
  return ids.length ? ` 依据：${ids.map((id) => `#${id}`).join(' ')}` : '';
}

function reactionLines(indent: string, verifies: MessageSummary[], challenges: MessageSummary[]): string[] {
  return [
    ...verifies.map((m) => `${indent}- verify [#${m.id}]：${m.summary}`),
    ...challenges.map((m) => `${indent}- challenge [#${m.id}]：${m.summary}`),
  ];
}

function renderKnowledge(k: KnowledgeOverview, indent: string): string[] {
  const c = k.current;
  const lines = [`${indent}- [#${c.id}] ${c.type}：${c.summary}${refs(c.referencedMessageIds)}`];
  if (k.transitions.length) {
    lines.push(`${indent}  - 转换：${k.transitions.map((t) => `${t.fromType}→${t.toType}（#${t.triggerMessageId}）`).join(' ')}`);
  }
  return [...lines, ...reactionLines(`${indent}  `, k.verifies, k.challenges)];
}

function renderChain(ch: ChainOverview, indent: string): string[] {
  const c = ch.current;
  const intent = ch.closesQuestion && ch.chainResolution ? ` 关闭意图：${ch.chainResolution}` : '';
  const lines = [`${indent}- [#${c.id}] chain [${ch.status}]${intent}：${c.summary}${refs(c.referencedMessageIds)}`];
  if (ch.transitions.length) {
    lines.push(`${indent}  - 转换：${ch.transitions.map((t) => `${t.fromStatus}→${t.toStatus}（#${t.triggerMessageId}）`).join(' ')}`);
  }
  return [...lines, ...reactionLines(`${indent}  `, ch.verifies, ch.challenges)];
}

function renderQuestion(q: QuestionOverview): string {
  const status = q.closeReason ? `${q.status}/${q.closeReason}` : q.status;
  const lines = [`- [#${q.question.id}] 问题 [${status}]：${q.question.summary}`];
  const subgroups: [string, string[]][] = [
    ['假设', q.hypotheses.flatMap((k) => renderKnowledge(k, '    '))],
    ['事实', q.facts.flatMap((k) => renderKnowledge(k, '    '))],
    ['死胡同', q.boundaries.flatMap((k) => renderKnowledge(k, '    '))],
    ['候选链路', q.chains.flatMap((ch) => renderChain(ch, '    '))],
  ];
  const nonEmpty = subgroups.filter(([, items]) => items.length > 0);
  if (nonEmpty.length === 0) {
    lines.push('  - （尚无回答）');
  } else {
    for (const [name, items] of nonEmpty) lines.push(`  - ${name}：`, ...items);
  }
  return lines.join('\n');
}

function renderExploring(e: ExploringOverview): string {
  const target = e.target ? ` → #${e.target.id}` : '';
  const lines = [`- [#${e.message.id}] 占用：${e.agentId}${target}：${e.message.summary}`];
  if (e.status === 'completed') {
    const results = e.resultMessages.length ? e.resultMessages.map((m) => `#${m.id}`).join(' ') : '（无）';
    lines.push(`  结束：${e.resultSummary ?? '未记录结果'}；结果引用：${results}`);
  }
  return lines.join('\n');
}

function renderPlain(m: MessageSummary): string {
  return `- [#${m.id}] ${m.type ?? '聊天'}${m.source === 'human' ? '（人类）' : ''}：${m.summary}`;
}

export function renderMemory(overview: OverviewPayload): string {
  const groups: [string, string[]][] = [
    ['### 任务目标（goal）', [renderQuestion(overview.goal)]],
    ['### 其他问题', overview.questions.map(renderQuestion)],
    ['### 未挂在问题下的知识', overview.unattachedKnowledge.map((k) => renderKnowledge(k, '').join('\n'))],
    ['### 正在探索的方向', overview.activeExploring.map(renderExploring)],
    ['### 已结束探索', overview.completedExploring.map(renderExploring)],
    ['### 完成提议', overview.completionProposals.map(renderPlain)],
    ['### 最近消息', overview.recentRawMessages.map(renderPlain)],
  ];
  return groups.map(([title, items]) => `${title}\n${items.length ? items.join('\n') : '（无）'}`).join('\n\n');
}

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

你的职责是：基于当前上下文，自主选择一个尚未被覆盖的研究方向，并在本次 Session 内完成尽可能深入的研究。


## 协作规则

**可用工具**：
- post_message(roomId, authorId, content, type?, targetMessageId?, referencedMessageIds?, verifyVerdict?, closesQuestion?, chainResolution?, summary?)：写入一条消息。type 留空就是纯聊天，不进入记忆，也不能带任何关联字段。
- complete_exploring(roomId, authorId, messageId, resultSummary, resultMessageIds?)：把你自己当前 active 的 exploring 标记为完成，resultSummary 必填，无结论也如实写明。
- get_overview(roomId)：获取当前房间状态摘要——下面已经给你一份派发时刻的快照，需要最新数据时可以随时重新调用。
- get_detail(roomId, messageId | { type } | { list: true, type?, targetMessageId?, beforeId?, limit? })：查看某条或某类消息的完整内容，list:true 时分页浏览全部历史（含普通聊天）。

**记忆类型**：
| type | 含义 | 发送要求 |
|---|---|---|
| open_question | 需要继续研究的问题；只有 OPEN、CLOSED 两种状态 | 不带 targetMessageId；应描述一个具体、可继续探索的问题 |
| hypothesis | 针对某个 open_question 的候选答案，尚无定论 | 必须用 targetMessageId 指向该 open_question；存在依据但仍需验证的判断写成 hypothesis |
| fact | 已确认的事实，可以直接使用，无需重复验证 | 必须有明确证据；直接回答某个 open_question 时必须用 targetMessageId 指向它 |
| boundary | 已确认走不通的路径/死胡同 | 必须说明为什么不可行、成立的条件和范围；单次尝试失败不能写成 boundary；直接回答某个 open_question 时必须用 targetMessageId 指向它 |
| chain | 一条从输入到输出的完整候选链路或答案；状态为 CANDIDATE / VERIFIED / CHALLENGED / REJECT | 必须用 targetMessageId 指向它回答的 open_question，可用 referencedMessageIds 标注依据；认为它足以关闭该问题时设 closesQuestion=true，并用 chainResolution 给出 RESOLVED（已解决）或 UNRESOLVED（确认无法解决）；只有新路径或实质变化才发新 chain |
| challenge | 对已有结论的质疑 | 必须用 targetMessageId 指向 fact、boundary，或 CANDIDATE / VERIFIED / REJECT 状态的 chain，并写明质疑点和依据；CHALLENGED 状态的 chain 不能再被 challenge |
| verify | 对 hypothesis 或 chain 的独立验证 | 必须用 targetMessageId 指向 hypothesis，或 CANDIDATE / CHALLENGED 状态的 chain，并设 verifyVerdict=true/false；已 VERIFIED / REJECT 的 chain 不能再被 verify；不能 verify 本次 session 发出的消息；必须采用独立且有实质差异的方法 |
| exploring | 你正在占用的研究方向，不代表知识 | 开始实际探索前发送；必须用 targetMessageId 指向一个 open_question 或 hypothesis；内容写明要解决什么、从什么方向、用什么方法、范围是什么；不得与当前 active exploring 明显重复 |
| propose_completion | 你认为任务可以结束的一次性信号 | 只有 goal 已得到充分回答、且 goal 没有明显其他方向时发送；不带 targetMessageId；不参与状态转换，不直接关闭问题 |

**状态转换（由 Scheduler 自动完成，你不需要也不能手动修改）**：
- hypothesis 被 verify：true → fact，false → boundary。
- fact / boundary 被 challenge → 转回 hypothesis；如果它回答的问题已关闭，该问题重新变为 OPEN。
- chain 被 verify：true → VERIFIED，false → REJECT；被 challenge → CHALLENGED，之后只能通过 verify 转为 VERIFIED 或 REJECT。
- closesQuestion=true 的 chain 变为 VERIFIED 时，目标问题按 chainResolution 关闭；chain 处于其他状态时问题保持 OPEN；已 VERIFIED 的 chain 被 challenge 后，它关闭的问题重新变为 OPEN。
- 所有转换都会记录在转换历史中，消息正文永不修改。

**调度触发条件**：只有当前处于未确定状态的消息会触发新的 Agent 调度：OPEN 的 open_question、hypothesis、CANDIDATE 的 chain，以及 challenge。fact、boundary、已关闭的问题、其他状态的 chain、verify、exploring、propose_completion 和无类型聊天都不会触发调度。人类消息遵循同一规则。

**exploring 的规则**：你同一时间只能有一个 active exploring；已有 active exploring 时再发 exploring 会被拒绝，必须先调用 complete_exploring 结束当前这条。确定新方向后、发送 exploring 前，先调用 get_overview 确认没有其他 Agent 正在进行重复的 exploring。一次 exploring 可以产生多个结果，完成时在 resultMessageIds 中列出。

**人类消息权重**：来源为人类的消息，请更重视其判断——系统不会强制覆盖你的看法，只是提醒你认知上多加权重。

**消息规范**：你这次是一次性非交互调用，没有人类终端可以应答。所有发现先通过 post_message 提交并等待成功；写入被拒绝时按错误信息修正后重试。**一次 session 不限于只做一件事**：一项发现自然引出下一步具体可做的动作时，在本次 session 内继续做下去，用合适的类型分别记录每一步。已有结论适用时直接引用，不要重复发送。

**Session 结束条件**：当不存在新的、未被覆盖且有价值的研究方向时，直接结束本次 Session。不要为了继续执行而重复已有研究。没有新增内容时可以不发任何消息。

**历史查询**：下面的记忆面板是房间状态的摘要。需要完整内容时调用 get_detail。

## 记忆面板

任务目标：
${goalContent}

本次 Session 的核心目标是推进这个 goal，不要主动转向与 goal 无关的问题。

${renderMemory(overview)}

${overview.guidance}

## 下一步
请根据以上信息判断：1. 当前 goal 还缺什么关键信息；2. 哪些方向已经被覆盖；3. 哪些方向正在被其他 Agent exploring；4. 哪些 hypothesis 或 chain 等待独立验证，哪些结论值得质疑。然后自主选择一个研究方向，通过 post_message 发送 exploring，之后在本 Session 内自主完成研究。你可以自由选择工具、调整步骤和研究方法，只要没有明显偏离已经选择的方向；选择方向后优先深入，直到获得明确发现、确认该方向无增量、遇到 boundary，或发现明显更高价值的新方向，再切换 exploring。每次切换都必须先完成当前 exploring。不要发送没有充分证据支持的 fact 或 boundary，存在依据但仍不能确定的判断写成 hypothesis。
`;
}

export async function writePromptFile(content: string, filePath: string): Promise<string> {
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}
