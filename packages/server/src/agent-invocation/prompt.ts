import { writeFile } from 'node:fs/promises';
import type { OverviewPayload, MemorySummary } from '../memory';

function renderMemory(overview: OverviewPayload): string {
  const all = [...overview.facts, ...overview.boundaries, ...overview.openQuestions, ...overview.hypotheses,
    ...overview.chains, ...overview.activeExploring, ...overview.completedExploring,
    ...overview.completionProposals, ...overview.contextMessages, ...overview.reactions];
  const byId = new Map(all.map(m => [m.id, m]));
  const rendered = new Set<number>();
  function render(m: MemorySummary, indent = ''): string {
    if (rendered.has(m.id)) return '';
    rendered.add(m.id);
    const target = m.targetMessageId == null ? '' : ` → #${m.targetMessageId}`;
    const refs = m.referencedMessageIds.length ? ` 依据：${m.referencedMessageIds.map(id => '#'+id).join(' ')}` : '';
    const status = m.exploringStatus ? ` [${m.exploringStatus}]` : '';
    const agent = 'agentId' in m ? ` 占用：${m.agentId}` : '';
    const lines = [`${indent}- [#${m.id}] ${m.type ?? '上下文'}${target}${status}${agent}：${m.summary}${refs}`];
    if (m.exploringStatus === 'completed') lines.push(`${indent}  结束：${m.exploringEndReason ?? '结束原因未记录'}；${m.exploringResultSummary ?? '未记录结果'}${m.exploringNote ? '；'+m.exploringNote : ''}；结果引用：${m.exploringResultMessageIds.map(id => '#'+id).join(' ')}`);
    const rel = overview.relations[m.id];
    if (rel?.answerIds.length) lines.push(`${indent}  已有回答：${rel.answerIds.map(id => '#'+id).join(' ')}`);
    if (rel?.referencedByIds.length) lines.push(`${indent}  被引用：${rel.referencedByIds.map(id => '#'+id).join(' ')}`);
    for (const id of rel?.annotationIds ?? []) {
      const annotation = byId.get(id);
      if (annotation && ['endorse', 'challenge', 'verify'].includes(annotation.type ?? '') && !rendered.has(id)) {
        // Render the event once; no recursive traversal or duplicate payload.
        rendered.add(id);
        lines.push(`${indent}  - [#${id}] ${annotation.type} → #${m.id}：${annotation.summary}；依据：${annotation.referencedMessageIds.map(ref => '#'+ref).join(' ')}`);
        const nested = overview.relations[id];
        if (nested?.annotationIds.length) lines.push(`${indent}    后续注解：${nested.annotationIds.map(ref => '#'+ref).join(' ')}`);
        if (nested?.referencedByIds.length) lines.push(`${indent}    被引用：${nested.referencedByIds.map(ref => '#'+ref).join(' ')}`);
      } else if (annotation) {
        lines.push(`${indent}  注解索引：#${id}`);
      }
    }
    return lines.join('\n');
  }
  const groups: [string, MemorySummary[]][] = [
    ['已确认事实', overview.facts], ['死胡同', overview.boundaries], ['待解决问题', overview.openQuestions],
    ['候选假设', overview.hypotheses], ['候选方案', overview.chains],
    ['正在探索的方向', overview.activeExploring], ['已结束探索', overview.completedExploring],
    ['完成提议', overview.completionProposals], ['关联上下文', overview.contextMessages],
    ['其余反应记录', overview.reactions],
  ];
  return groups.map(([name, items]) => name + '：\n' + (items.map(m => render(m)).filter(Boolean).join('\n') || '（无）')).join('\n\n');
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

## 协作规则

**可用工具**：
- post_message(roomId, authorId, content, type?, targetMessageId?, referencedMessageIds?, summary?)：像聊天室写入一条消息，可以是你的当前进展，也可以是其他任何你觉得对任务有帮助的内容。type 留空就是纯聊天，不进入任何记忆层。
- complete_exploring(roomId, authorId, messageId, resultSummary, resultMessageIds?)：把你自己当前 active 的 exploring 记录标记为完成。
- get_overview(roomId)：获取当前房间状态摘要——下面已经给你一份派发时刻的快照，如果你觉得需要更新的数据（比如怀疑其他 agent 在你这次会话开始后又有新动作），可以随时重新调用它刷新。
- get_detail(roomId, messageId | { type } | { list: true, type?, targetMessageId?, beforeId?, limit? })：按需深挖某条或某类记忆的完整内容，list:true 时分页浏览全部历史（含普通聊天）。

**记忆类型**：fact（已确认事实）/ hypothesis（针对某个 open_question 的候选答案）/ boundary（已确认走不通的死胡同）/ open_question（提出的开放问题，可选 targetMessageId 表示追问某条消息）/ chain（一条候选端到端方案，可多条并存，没有系统裁定的"最优"）/ exploring（你正在探索的方向广播，见下）/ propose_completion（你认为任务可以结束了）/ endorse、challenge、verify（对某条消息的赞同/质疑/验证，targetMessageId 必填）。所有类型一旦发出，type 和 content 永不改写——只追加，不覆盖。

**exploring 的规则**：你同时只能有一条 active 的 exploring；发新的 exploring 会自动把你自己之前那条 active 的标记为 completed；探索完一个方向但还没想好下一步时，调用 complete_exploring 显式标记完成。

**人类消息权重**：房间里 authorId 为 "human" 的消息，请更重视其判断——但不代表系统会强制覆盖你的看法，只是提醒你认知上多加权重。

**结束本次会话**：你这次是一次性非交互调用，没有人类终端可以应答。所有的发现先通过 post_message 提交并等待成功；探索完成时调用 complete_exploring；完成本次工作后就结束本次回答，由系统在进程自然退出后记录本次 session。不要等待终端输入。什么都不调用直接结束是允许的，不会被视为异常，只是这次没有新内容。

**接续历史**：hypothesis 必须用 targetMessageId 指向 open_question；fact 可选回答问题。所有有类型消息都可以 referencedMessageIds 引用依据。先读取已有回答及注解；再次验证或质疑说明新增条件、证据或疑点。已有方案适用时直接引用，只有新路径或实质变化才发 chain，并说明变化。无增量可以结束。探索结束须记录结果摘要，无结论也如实记录。get_detail({roomId, list:true, type?, targetMessageId?, beforeId?, limit?}) 可分页浏览全部历史，包括普通聊天。人类约束优先查看原始消息，记忆摘要省略作者不改变其权重。

## 当前房间状态（派发时刻的快照，来自 buildOverview(roomId)）

任务目标：${overview.goal}

${renderMemory(overview)}

最近的原始消息：
${renderRecentRawMessages(overview.recentRawMessages)}

${overview.guidance}

## 下一步

请基于以上信息决定下一步做什么，任何你觉得对达成任务有帮助信息都可以通过 post_message 记录下来；需要最新的记忆数据可以重新调用 get_overview(roomId)。
`;
}

export async function writePromptFile(content: string, filePath: string): Promise<string> {
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}
