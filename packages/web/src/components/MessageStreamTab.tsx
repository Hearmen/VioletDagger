import { useState } from 'react';
import type { Message, MessageType } from '../api/types';

const MESSAGE_TYPES: MessageType[] = [
  'fact', 'hypothesis', 'boundary', 'open_question', 'chain',
  'exploring', 'propose_completion', 'endorse', 'challenge', 'verify',
];

const REACTION_TYPES: MessageType[] = ['endorse', 'challenge', 'verify'];

export function MessageStreamTab(props: {
  messages: Message[];
  onSend: (params: {
    content: string;
    type?: MessageType;
    targetMessageId?: number;
    referencedMessageIds?: number[];
  }) => void;
  readOnly: boolean;
}) {
  const [content, setContent] = useState('');
  const [type, setType] = useState<MessageType | ''>('');
  const [targetMessageId, setTargetMessageId] = useState<number | undefined>(undefined);
  const [referencedMessageIds, setReferencedMessageIds] = useState<number[]>([]);

  const needsTarget = REACTION_TYPES.includes(type as MessageType);
  const canSend = content.trim().length > 0 && (!needsTarget || targetMessageId != null);

  function handleSend() {
    props.onSend({
      content,
      type: type || undefined,
      targetMessageId,
      referencedMessageIds: type === 'chain' && referencedMessageIds.length > 0 ? referencedMessageIds : undefined,
    });
    setContent('');
    setType('');
    setTargetMessageId(undefined);
    setReferencedMessageIds([]);
  }

  return (
    <div>
      <ul>
        {props.messages.map((m) => (
          <li key={m.id} onClick={() => setTargetMessageId(m.id)}>
            {m.type === 'propose_completion' && <strong>[提议完成] </strong>}
            [{m.authorId}] {m.content}
          </li>
        ))}
      </ul>
      <select aria-label="message type" value={type} onChange={(e) => setType(e.target.value as MessageType | '')} disabled={props.readOnly}>
        <option value="">(chat)</option>
        {MESSAGE_TYPES.map((t) => (
          <option key={t} value={t}>{t}</option>
        ))}
      </select>
      {needsTarget && <span>target: {targetMessageId ?? '(click a message above)'}</span>}
      <textarea aria-label="content" value={content} onChange={(e) => setContent(e.target.value)} disabled={props.readOnly} />
      <button onClick={handleSend} disabled={props.readOnly || !canSend}>Send</button>
    </div>
  );
}
