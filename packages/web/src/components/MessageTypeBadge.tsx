import type { MessageType } from '../api/types';
import { typeLabel } from '../utils/format';

export function MessageTypeBadge({ type }: { type: MessageType }) {
  return <span className={`type-badge type-badge--${type}`}>{typeLabel(type)}</span>;
}
