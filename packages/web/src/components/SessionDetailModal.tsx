import type { SessionDetailPayload } from '../api/types';

export function SessionDetailModal(props: { detail: SessionDetailPayload | null; onClose: () => void }) {
  if (!props.detail) return null;
  return (
    <div role="dialog" aria-label="session detail">
      <button onClick={props.onClose}>Close</button>
      <p>{props.detail.agentId} — {props.detail.outcome}</p>
      <p>wroteMessages: {String(props.detail.wroteMessages)}</p>
      <pre>{props.detail.rawLog}</pre>
    </div>
  );
}
