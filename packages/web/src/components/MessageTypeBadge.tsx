import type { MessageType } from '../api/types';
import { useI18n } from '../i18n/LocaleProvider';
import { typeLabel } from '../utils/format';

export function MessageTypeBadge({ type }: { type: MessageType }) {
  const { t } = useI18n();
  return <span className={`type-badge type-badge--${type}`}>{typeLabel(type, t)}</span>;
}
