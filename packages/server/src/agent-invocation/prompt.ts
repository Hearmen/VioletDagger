import { writeFile } from 'node:fs/promises';
import type { OverviewPayload } from '../memory';

function renderSummaryList(items: { id: number; summary: string }[]): string {
  if (items.length === 0) return '（无）';
  return items.map((item) => `- [#${item.id}] ${item.summary}`).join('\n');
}

function renderActiveExploring(items: { agentId: string; summary: string }[]): string {
  if (items.length === 0) return '（无）';
  return items.map((item) => `- ${item.agentId}: ${item.summary}`).join('\n');
}

function renderRecentRawMessages(messages: OverviewPayload['recentRawMessages']): string {
  if (messages.length === 0) return '（无）';
  return messages.map((m) => `- [${m.authorId}] ${m.content}`).join('\n');
}

export function buildPromptText(params: {
  roomId: number;
  agentId: string;
  overview: OverviewPayload;
}): string {
  const { roomId, agentId, overview } = params;
  return `你是这次协作聊天室会话的参与者。
roomId: ${roomId}
authorId: ${agentId}

## 协作规则（每次都完整给出，不要假设你还记得上次）

**可用工具**：
- post_message(roomId, authorId, content, type?, targetMessageId?, referencedMessageIds?, summary?)：写入一条消息。type 留空就是纯聊天，不进入任何记忆层。
- complete_exploring(roomId, authorId, messageId)：把你自己当前 active 的 exploring 记录标记为完成。
- get_overview(roomId)：获取当前房间状态摘要——下面已经给你一份派发时刻的快照，如果你觉得需要更新的数据（比如怀疑其他 agent 在你这次会话开始后又有新动作），可以随时重新调用它刷新。
- get_detail(roomId, messageId | { type })：按需深挖某条或某类记忆的完整内容。

**记忆类型**：fact（已确认事实）/ hypothesis（针对某个 open_question 的候选答案）/ boundary（已确认走不通的死胡同）/ open_question（尚无答案的问题，可选 targetMessageId 表示追问某条消息）/ chain（一条候选端到端方案，可多条并存，没有系统裁定的"最优"）/ exploring（你正在探索的方向广播，见下）/ propose_completion（你认为任务可以结束了）/ endorse、challenge、verify（对某条消息的赞同/质疑/验证，targetMessageId 必填）。所有类型一旦发出，type 和 content 永不改写——只追加，不覆盖。

**exploring 的规则**：你同时只能有一条 active 的 exploring；发新的 exploring 会自动把你自己之前那条 active 的标记为 completed；探索完一个方向但还没想好下一步时，调用 complete_exploring 显式标记完成。

**人类消息权重**：房间里 authorId 为 "human" 的消息，请更重视其判断——但不代表系统会强制覆盖你的看法，只是提醒你认知上多加权重。

**如果没什么可说的**：可以什么都不调用，直接结束本次会话即可（不会被视为异常，只是这次没有新内容）。

## 当前房间状态（派发时刻的快照，来自 buildOverview(roomId)）

任务目标：${overview.goal}

已确认事实：
${renderSummaryList(overview.facts)}

死胡同：
${renderSummaryList(overview.boundaries)}

待解决问题：
${renderSummaryList(overview.openQuestions)}

候选方案：
${renderSummaryList(overview.chains)}

候选假设：
${renderSummaryList(overview.hypotheses)}

其他 agent 正在探索的方向：
${renderActiveExploring(overview.activeExploring)}

最近的原始消息：
${renderRecentRawMessages(overview.recentRawMessages)}

${overview.guidance}

## 下一步

请基于以上信息决定要不要发言、发什么；需要更新数据可以重新调用 get_overview(roomId)。
`;
}

export async function writePromptFile(content: string, filePath: string): Promise<string> {
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}
