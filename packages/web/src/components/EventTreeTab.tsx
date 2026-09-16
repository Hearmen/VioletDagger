import type { EventTreePayload } from '../api/types';

export function EventTreeTab(props: { eventTree: EventTreePayload; onOpenSession: (seq: number) => void }) {
  return (
    <ol>
      {props.eventTree.sessions.map((session) => (
        <li key={session.seq}>
          <button onClick={() => props.onOpenSession(session.seq)}>
            #{session.seq} {session.agentId} — {session.outcome}
          </button>
          <ul>
            {session.messages.map((m) => (
              <li key={m.id}>{m.content}</li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}
