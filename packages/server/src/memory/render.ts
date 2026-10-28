import type {
  ChainOverview, ExploringOverview, KnowledgeOverview, MessageSummary, OverviewPayload, QuestionOverview,
} from './types';

// 文本渲染格式见 docs/design/02-memory-management.md §3.4；取数规则见 02 §3.2。

const RESULT_SUMMARY_MAX_LEN = 80;

export const MEMORY_HINT = '以下各条只给摘要；需要某条的全文，或已关闭问题下未列出的回答与 exploring 时，用 get_detail 按 #id 查看。';

// 摘要里的换行连同两侧空白换成一个空格，保证每个条目只占一行（02 §3.4）。
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ');
}

function clip(text: string): string {
  const chars = [...oneLine(text)];
  return chars.length > RESULT_SUMMARY_MAX_LEN ? `${chars.slice(0, RESULT_SUMMARY_MAX_LEN).join('')}…` : chars.join('');
}

function refs(ids: number[]): string {
  return ids.length ? ` 依据：${ids.map((id) => `#${id}`).join(' ')}` : '';
}

function reactionLines(indent: string, verifies: MessageSummary[], challenges: MessageSummary[]): string[] {
  return [
    ...verifies.map((m) => `${indent}- verify [#${m.id}]：${oneLine(m.summary)}`),
    ...challenges.map((m) => `${indent}- challenge [#${m.id}]：${oneLine(m.summary)}`),
  ];
}

function renderKnowledge(k: KnowledgeOverview, indent: string): string[] {
  const c = k.current;
  const lines = [`${indent}- [#${c.id}] ${c.type}：${oneLine(c.summary)}${refs(c.referencedMessageIds)}`];
  if (k.transitions.length) {
    lines.push(`${indent}  - 转换：${k.transitions.map((t) => `${t.fromType}→${t.toType}（#${t.triggerMessageId}）`).join(' ')}`);
  }
  return [...lines, ...reactionLines(`${indent}  `, k.verifies, k.challenges)];
}

function renderChain(ch: ChainOverview, indent: string): string[] {
  const c = ch.current;
  const intent = ch.closesQuestion && ch.chainResolution ? ` 关闭意图：${ch.chainResolution}` : '';
  const lines = [`${indent}- [#${c.id}] chain [${ch.status}]${intent}：${oneLine(c.summary)}${refs(c.referencedMessageIds)}`];
  // 唯一一条从 CANDIDATE 出发、由本 chain 的 verify 触发的转换，已由 [status] 和 verify 行完整表达。
  const [only] = ch.transitions;
  const implied = ch.transitions.length === 1 && only.fromStatus === 'CANDIDATE'
    && ch.verifies.some((v) => v.id === only.triggerMessageId);
  if (ch.transitions.length && !implied) {
    lines.push(`${indent}  - 转换：${ch.transitions.map((t) => `${t.fromStatus}→${t.toStatus}（#${t.triggerMessageId}）`).join(' ')}`);
  }
  return [...lines, ...reactionLines(`${indent}  `, ch.verifies, ch.challenges)];
}

// goal 的根行不渲染摘要：完整正文已在上方"任务目标"处给出（02 §3.4）。
function renderQuestion(q: QuestionOverview, isGoal = false): string {
  const status = q.closeReason ? `${q.status}/${q.closeReason}` : q.status;
  const lines = [isGoal
    ? `- [#${q.question.id}] goal [${status}]：（全文见上方"任务目标"）`
    : `- [#${q.question.id}] 问题 [${status}]：${oneLine(q.question.summary)}`];
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

// 已关闭的子问题只渲染根行（带收尾 chain）与 fact/boundary 单行摘要，其余回答和相关 exploring 不渲染（02 §3.4）。
// 折叠只作用于渲染文本，OverviewPayload 本身不变。
function renderClosedQuestion(q: QuestionOverview): string {
  const closing = q.chains
    .filter((ch) => ch.status === 'VERIFIED' && ch.closesQuestion)
    .map((ch) => ` → 收尾 #${ch.current.id}：${oneLine(ch.current.summary)}`)
    .join('');
  const lines = [`- [#${q.question.id}] 问题 [${q.status}${q.closeReason ? `/${q.closeReason}` : ''}]：${oneLine(q.question.summary)}${closing}`];
  const line = (k: KnowledgeOverview) => `    - [#${k.current.id}] ${k.current.type}：${oneLine(k.current.summary)}`;
  const subgroups: [string, string[]][] = [
    ['事实', q.facts.map(line)],
    ['死胡同', q.boundaries.map(line)],
  ];
  for (const [name, items] of subgroups) if (items.length) lines.push(`  - ${name}：`, ...items);
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
  const lines = [`- [#${e.message.id}] 占用：${e.agentId}${target}：${oneLine(e.message.summary)}`];
  if (e.status === 'completed') {
    const results = e.resultMessages.length ? e.resultMessages.map((m) => `#${m.id}`).join(' ') : '（无）';
    lines.push(`  结束：${e.resultSummary == null ? '未记录结果' : clip(e.resultSummary)}；结果引用：${results}`);
  }
  return lines.join('\n');
}

function renderPlain(m: MessageSummary): string {
  return `- [#${m.id}] ${m.type ?? '聊天'}${m.source === 'human' ? '（人类）' : ''}：${oneLine(m.summary)}`;
}

// 条目行以 "- [#id]"、"- verify [#id]"、"- challenge [#id]" 开头；摘要已去掉换行，不会伪造行首。
const ENTRY_ID = /^\s*- (?:verify |challenge )?\[#(\d+)\]/gm;

export function renderMemory(overview: OverviewPayload): string {
  const closedIds = new Set(overview.questions.filter((q) => q.status === 'CLOSED').map((q) => q.question.id));
  const visible = (list: ExploringOverview[]) => list.filter((e) => closedOwner(e, closedIds) === null);
  const groups: [string, string[]][] = [
    ['### 任务目标（goal）', [renderQuestion(overview.goal, true)]],
    ['### 其他问题', overview.questions.map((q) => (closedIds.has(q.question.id) ? renderClosedQuestion(q) : renderQuestion(q)))],
    ['### 未挂在问题下的知识', overview.unattachedKnowledge.map((k) => renderKnowledge(k, '').join('\n'))],
    ['### 正在探索的方向', visible(overview.activeExploring).map(renderExploring)],
    ['### 已结束探索', visible(overview.completedExploring).map(renderExploring)],
    ['### 完成提议', overview.completionProposals.map(renderPlain)],
  ];
  // 最近消息跳过前面已作为条目行渲染过的消息（02 §3.4）。
  const rendered = new Set(groups.flatMap(([, items]) => [...items.join('\n').matchAll(ENTRY_ID)].map((m) => Number(m[1]))));
  groups.push(['### 最近消息', overview.recentRawMessages.filter((m) => !rendered.has(m.id)).map(renderPlain)]);
  const body = groups.map(([title, items]) => `${title}\n${items.length ? items.join('\n') : '（无）'}`).join('\n\n');
  return `${MEMORY_HINT}\n\n${body}`;
}

// 派发时的 prompt 记忆面板与 MCP get_overview 共用这一个输出（02 §3.4）。
export function renderOverviewText(goalContent: string, overview: OverviewPayload): string {
  return `任务目标：
${goalContent}

本次 Session 的核心目标是推进这个 goal，不要主动转向与 goal 无关的问题。

${renderMemory(overview)}

${overview.guidance}`;
}
