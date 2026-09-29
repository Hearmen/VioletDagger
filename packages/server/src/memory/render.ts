import type {
  ChainOverview, ExploringOverview, KnowledgeOverview, MessageSummary, OverviewPayload, QuestionOverview,
} from './types';

// 文本渲染格式见 docs/design/02-memory-management.md §3.4；取数规则见 02 §3.2。

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

// goal 的根行不渲染摘要：完整正文已在上方"任务目标"处给出（02 §3.4）。
function renderQuestion(q: QuestionOverview, isGoal = false): string {
  const status = q.closeReason ? `${q.status}/${q.closeReason}` : q.status;
  const lines = [isGoal
    ? `- [#${q.question.id}] goal [${status}]：（全文见上方"任务目标"）`
    : `- [#${q.question.id}] 问题 [${status}]：${q.question.summary}`];
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

// 已关闭的子问题只保留收尾 chain 与 fact/boundary 单行摘要，其余回答和相关 exploring 只计数（02 §3.4）。
// 折叠只作用于渲染文本，OverviewPayload 本身不变。
function renderClosedQuestion(q: QuestionOverview, foldedExploring: number): string {
  const lines = [`- [#${q.question.id}] 问题 [${q.status}${q.closeReason ? `/${q.closeReason}` : ''}]：${q.question.summary}`];
  const closing = q.chains.filter((ch) => ch.status === 'VERIFIED' && ch.closesQuestion);
  const oneLine = (k: KnowledgeOverview) => `    - [#${k.current.id}] ${k.current.type}：${k.current.summary}`;
  const subgroups: [string, string[]][] = [
    ['收尾链路', closing.flatMap((ch) => renderChain(ch, '    '))],
    ['事实', q.facts.map(oneLine)],
    ['死胡同', q.boundaries.map(oneLine)],
  ];
  for (const [name, items] of subgroups) if (items.length) lines.push(`  - ${name}：`, ...items);
  const foldedAnswers = q.hypotheses.length + q.chains.length - closing.length;
  const folded = [
    ...(foldedAnswers ? [`${foldedAnswers} 条回答`] : []),
    ...(foldedExploring ? [`${foldedExploring} 条 exploring`] : []),
  ];
  if (folded.length) lines.push(`  - 已折叠：${folded.join('、')}，需要时用 get_detail 查看`);
  return lines.join('\n');
}

// exploring 指向已关闭子问题本身，或指向其下的 hypothesis（含后来转成的 fact/boundary）时，归属该问题。
function closedOwner(e: ExploringOverview, closedIds: Set<number>): number | null {
  if (!e.target) return null;
  if (closedIds.has(e.target.id)) return e.target.id;
  if (e.target.targetMessageId != null && closedIds.has(e.target.targetMessageId)) return e.target.targetMessageId;
  return null;
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
  const closedIds = new Set(overview.questions.filter((q) => q.status === 'CLOSED').map((q) => q.question.id));
  const foldedCount = new Map<number, number>();
  const visible = (list: ExploringOverview[]) => list.filter((e) => {
    const owner = closedOwner(e, closedIds);
    if (owner === null) return true;
    foldedCount.set(owner, (foldedCount.get(owner) ?? 0) + 1);
    return false;
  });
  const activeExploring = visible(overview.activeExploring);
  const completedExploring = visible(overview.completedExploring);
  const groups: [string, string[]][] = [
    ['### 任务目标（goal）', [renderQuestion(overview.goal, true)]],
    ['### 其他问题', overview.questions.map((q) => (closedIds.has(q.question.id)
      ? renderClosedQuestion(q, foldedCount.get(q.question.id) ?? 0)
      : renderQuestion(q)))],
    ['### 未挂在问题下的知识', overview.unattachedKnowledge.map((k) => renderKnowledge(k, '').join('\n'))],
    ['### 正在探索的方向', activeExploring.map(renderExploring)],
    ['### 已结束探索', completedExploring.map(renderExploring)],
    ['### 完成提议', overview.completionProposals.map(renderPlain)],
    ['### 最近消息', overview.recentRawMessages.map(renderPlain)],
  ];
  return groups.map(([title, items]) => `${title}\n${items.length ? items.join('\n') : '（无）'}`).join('\n\n');
}

// 派发时的 prompt 记忆面板与 MCP get_overview 共用这一个输出（02 §3.4）。
export function renderOverviewText(goalContent: string, overview: OverviewPayload): string {
  return `任务目标：
${goalContent}

本次 Session 的核心目标是推进这个 goal，不要主动转向与 goal 无关的问题。

${renderMemory(overview)}

${overview.guidance}`;
}
