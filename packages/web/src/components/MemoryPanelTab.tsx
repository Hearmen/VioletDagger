import type { MemoryViewPayload, Message } from '../api/types';

function groupByAuthor(messages: Message[]): Record<string, Message[]> {
  const groups: Record<string, Message[]> = {};
  for (const m of messages) {
    (groups[m.authorId] ??= []).push(m);
  }
  for (const authorId of Object.keys(groups)) {
    groups[authorId].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
  return groups;
}

export function MemoryPanelTab(props: { memory: MemoryViewPayload }) {
  const exploringByAuthor = groupByAuthor(props.memory.exploring);

  return (
    <div>
      <section aria-label="facts">{props.memory.facts.map((m) => <p key={m.id}>{m.content}</p>)}</section>
      <section aria-label="boundaries">{props.memory.boundaries.map((m) => <p key={m.id}>{m.content}</p>)}</section>
      <section aria-label="openQuestions">{props.memory.openQuestions.map((m) => <p key={m.id}>{m.content}</p>)}</section>
      <section aria-label="chains">{props.memory.chains.map((m) => <p key={m.id}>{m.content}</p>)}</section>
      <section aria-label="hypotheses">{props.memory.hypotheses.map((m) => <p key={m.id}>{m.content}</p>)}</section>
      <section aria-label="exploring">
        {Object.entries(exploringByAuthor).map(([authorId, messages]) => (
          <div key={authorId}>
            <h3>{authorId}</h3>
            {messages.map((m) => (
              <p key={m.id} style={{ opacity: m.exploringStatus === 'completed' ? 0.5 : 1 }}>
                {m.content}
                {m.exploringStatus === 'completed' && (
                  <em> (已完成{m.exploringNote ? `: ${m.exploringNote}` : ''})</em>
                )}
              </p>
            ))}
          </div>
        ))}
      </section>
    </div>
  );
}
