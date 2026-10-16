import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { fetchRooms, fetchAgents, createRoom, deleteRoom } from '../api/rest';
import type { AgentInfo, NativeDeleteFailure, RoomSummary, RoomStatus } from '../api/types';
import { LocaleToggle } from '../components/LocaleToggle';
import { useI18n } from '../i18n/LocaleProvider';
import { errorText, renderText, type LocalizedText } from '../i18n/types';
import type { MessageKey } from '../i18n/zh';
import { formatRelative } from '../utils/format';

const STATUS_LABELS: Record<RoomStatus, MessageKey> = {
  active: 'roomList.statusActive',
  paused_limit: 'roomList.statusPaused',
  paused_manual: 'roomList.statusPaused',
  completed: 'roomList.statusCompleted',
};

const COLLAPSED_FAILURES = 5;

// 原生会话原件未删除提示（07-frontend.md §11）：只在本次页面状态中存在，刷新后消失。
function NativeDeleteFailuresBanner(props: { failures: NativeDeleteFailure[]; onClose: () => void }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? props.failures : props.failures.slice(0, COLLAPSED_FAILURES);
  return (
    <div role="alert" className="banner banner--warn native-failures">
      <div className="native-failures__head">
        {t('roomList.nativeDeleteFailures', { count: props.failures.length })}
        <button className="ghost banner__close" onClick={props.onClose}>{t('common.close')}</button>
      </div>
      <ul className="native-failures__list">
        {shown.map((failure) => (
          <li key={`${failure.agentId}:${failure.seq}:${failure.target}`}>
            {failure.agentId} #{failure.seq} · <span className="mono">{failure.target}</span> · {failure.error}
          </li>
        ))}
      </ul>
      {!expanded && props.failures.length > COLLAPSED_FAILURES && (
        <button className="ghost" onClick={() => setExpanded(true)}>{t('roomList.showAllFailures')}</button>
      )}
    </div>
  );
}

// 与后端 createRoom 的实例标识规则一致（见 docs/design/01-storage.md），仅用于表单预览。
export function previewInstanceIds(registryKeys: string[]): string[] {
  const totals = new Map<string, number>();
  for (const key of registryKeys) totals.set(key, (totals.get(key) ?? 0) + 1);
  const seen = new Map<string, number>();
  return registryKeys.map((key) => {
    if (totals.get(key) === 1) return key;
    const index = (seen.get(key) ?? 0) + 1;
    seen.set(key, index);
    return `${key}-${index}`;
  });
}

export function RoomListPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  // RoomHeader 删除后带过来的导航状态，或本页卡片删除的结果。
  const [deleteFailures, setDeleteFailures] = useState<NativeDeleteFailure[]>(
    () => (location.state as { nativeDeleteFailures?: NativeDeleteFailure[] } | null)?.nativeDeleteFailures ?? [],
  );
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [name, setName] = useState('');
  const [maxSessions, setMaxSessions] = useState('');
  const [workdir, setWorkdir] = useState('');
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [error, setError] = useState<LocalizedText | null>(null);

  function refreshRooms() {
    return fetchRooms().then(setRooms).catch((err: unknown) => setError(errorText(err)));
  }

  useEffect(() => {
    refreshRooms();
    fetchAgents()
      .then(setAgents)
      .catch((err: unknown) => setError(errorText(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function addAgent(registryKey: string) {
    const agent = agents.find((item) => item.agentId === registryKey);
    if (agent && !agent.available) return;
    setSelectedKeys((prev) => [...prev, registryKey]);
  }

  function removeInstanceAt(index: number) {
    setSelectedKeys((prev) => prev.filter((_, i) => i !== index));
  }

  function clearAgent(registryKey: string) {
    setSelectedKeys((prev) => prev.filter((key) => key !== registryKey));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    // 留空 = 用服务端默认值；填了必须是正整数。
    const parsedMaxSessions = maxSessions.trim() === '' ? undefined : Number(maxSessions);
    if (parsedMaxSessions !== undefined && (!Number.isInteger(parsedMaxSessions) || parsedMaxSessions <= 0)) {
      setError({ kind: 'key', key: 'roomList.maxSessionsInvalid' });
      return;
    }
    try {
      const room = await createRoom({
        name,
        agentIds: selectedKeys,
        schedulingMode: 'sequential',
        ...(parsedMaxSessions !== undefined ? { maxSessions: parsedMaxSessions } : {}),
        ...(workdir.trim() !== '' ? { workdir: workdir.trim() } : {}),
      });
      navigate(`/rooms/${room.id}`);
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function handleDelete(room: RoomSummary) {
    if (!window.confirm(t('header.deleteRoomPrompt'))) {
      return;
    }
    setError(null);
    try {
      setDeleteFailures(await deleteRoom(room.id));
      await refreshRooms();
    } catch (err) {
      setError(errorText(err));
    }
  }

  const instanceIds = previewInstanceIds(selectedKeys);
  const countFor = (registryKey: string) => selectedKeys.filter((key) => key === registryKey).length;

  return (
    <div className="room-list">
      <div className="app-bar">
        <span className="brand">
          <span className="brand__mark">◆</span> VioletDagger
        </span>
        <LocaleToggle />
      </div>

      <div className="room-list__body">
        <section>
          <h2 className="section-title">{t('roomList.rooms')}</h2>
          {error && <p role="alert" className="error-inline">{renderText(error, t)}</p>}
          {deleteFailures.length > 0 && (
            <NativeDeleteFailuresBanner failures={deleteFailures} onClose={() => setDeleteFailures([])} />
          )}
          {rooms.length === 0 ? (
            <p className="placeholder">{t('roomList.empty')}</p>
          ) : (
            <div className="room-grid">
              {rooms.map((room) => (
                <div key={room.id} className="room-card">
                  <Link to={`/rooms/${room.id}`} className="room-card__link">
                    <span className="room-card__name">{room.name}</span>
                    <span className="room-card__meta">
                      <span className={`status-pill status-pill--${room.status}`}>{t(STATUS_LABELS[room.status])}</span>
                      <span className="mono">{formatRelative(room.createdAt, t)}</span>
                    </span>
                  </Link>
                  {room.status === 'completed' && (
                    <button className="danger ghost room-card__delete" onClick={() => handleDelete(room)}>
                      {t('roomList.delete')}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        <form className="create-panel" onSubmit={handleSubmit} noValidate>
          <h2 className="section-title" style={{ margin: 0 }}>{t('roomList.createTitle')}</h2>

          <div className="field">
            <label htmlFor="room-name">{t('roomList.nameLabel')}</label>
            <input
              id="room-name"
              aria-label={t('roomList.nameAria')}
              value={name}
              placeholder={t('roomList.namePlaceholder')}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="field">
            <span className="field__label">{t('roomList.agentsLabel')}</span>
            <div className="chips">
              {agents.map((agent) => {
                const count = countFor(agent.agentId);
                return (
                  <button
                    type="button"
                    key={agent.agentId}
                    className={`chip ${count > 0 ? 'chip--on' : ''}`}
                    aria-label={t('roomList.addAgent', { agentId: agent.agentId })}
                    disabled={!agent.available}
                    title={agent.available ? undefined : agent.unavailableReason ?? t('roomList.agentUnavailable')}
                    onClick={() => addAgent(agent.agentId)}
                  >
                    {agent.agentId}
                    {count > 0 && <span className="chip__count">×{count}</span>}
                  </button>
                );
              })}
            </div>
          </div>

          {instanceIds.length > 0 && (
            <div className="field">
              <span className="field__label">{t('roomList.instancesLabel')}</span>
              <div className="chips">
                {instanceIds.map((instanceId, index) => (
                  <span key={`${instanceId}-${index}`} className="chip chip--on">
                    {instanceId}
                    <button
                      type="button"
                      className="chip__remove"
                      aria-label={t('roomList.removeInstance', { instanceId })}
                      onClick={() => removeInstanceAt(index)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <div className="create-panel__clear">
                {agents
                  .filter((agent) => countFor(agent.agentId) > 0)
                  .map((agent) => (
                    <button
                      type="button"
                      key={agent.agentId}
                      className="ghost"
                      onClick={() => clearAgent(agent.agentId)}
                    >
                      {t('roomList.clearAgent', { agentId: agent.agentId })}
                    </button>
                  ))}
              </div>
            </div>
          )}

          <div className="field">
            <label htmlFor="room-max-sessions">{t('roomList.maxSessionsLabel')}</label>
            <input
              id="room-max-sessions"
              aria-label={t('roomList.maxSessionsAria')}
              type="number"
              min={1}
              placeholder={t('roomList.maxSessionsPlaceholder')}
              value={maxSessions}
              onChange={(e) => setMaxSessions(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="room-workdir">{t('roomList.workdirLabel')}</label>
            <input
              id="room-workdir"
              aria-label={t('roomList.workdirAria')}
              value={workdir}
              placeholder={t('roomList.workdirPlaceholder')}
              onChange={(e) => setWorkdir(e.target.value)}
            />
          </div>

          <div className="field">
            <span className="field__label">{t('roomList.schedulingLabel')}</span>
            <div className="chips">
              <span className="mode-option">
                <input type="radio" checked readOnly aria-label="sequential" /> sequential
              </span>
              <span className="mode-option mode-option--disabled" title={t('roomList.notImplemented')}>parallel</span>
            </div>
          </div>

          <button type="submit" className="primary" disabled={!name || instanceIds.length === 0}>
            {t('roomList.create')}
          </button>
        </form>
      </div>
    </div>
  );
}
