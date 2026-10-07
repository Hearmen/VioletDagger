import type { Message, MessageType } from '../api/types';
import { useI18n } from '../i18n/LocaleProvider';

type StatusSource = Pick<Message, 'type' | 'questionStatus' | 'questionCloseReason' | 'chainStatus' | 'verifyVerdict'>;

// 状态徽标（07-frontend.md §2）：紧跟类型徽标，只用于 open_question / chain / verify。
// verify 的文案取决于目标：目标为 chain 显示"通过/驳回"，否则（目标为 hypothesis，验证后可能已转成
// fact/boundary）显示"成立/不成立"。
export function MessageStatusBadge(props: { message: StatusSource; targetType?: MessageType | null }) {
  const { message } = props;
  const { t } = useI18n();
  if (message.type === 'open_question' && message.questionStatus) {
    if (message.questionStatus === 'OPEN') {
      return <span className="status-badge status-badge--question-open">OPEN</span>;
    }
    const resolved = message.questionCloseReason === 'RESOLVED';
    return (
      <span className={`status-badge status-badge--question-${resolved ? 'resolved' : 'unresolved'}`}>
        CLOSED/{message.questionCloseReason}
      </span>
    );
  }
  if (message.type === 'chain' && message.chainStatus) {
    return (
      <span className={`status-badge status-badge--chain-${message.chainStatus.toLowerCase()}`}>
        {message.chainStatus}
      </span>
    );
  }
  if (message.type === 'verify' && message.verifyVerdict != null) {
    const onChain = props.targetType === 'chain';
    const label = message.verifyVerdict
      ? t(onChain ? 'messages.verifyPass' : 'messages.verifyHolds')
      : t(onChain ? 'messages.verifyReject' : 'messages.verifyNotHolds');
    return <span className={`status-badge status-badge--verify-${message.verifyVerdict}`}>{label}</span>;
  }
  return null;
}
