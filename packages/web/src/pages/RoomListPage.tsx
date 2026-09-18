import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { fetchRooms, fetchAgents, createRoom, deleteRoom } from '../api/rest';
import type { AgentInfo, RoomSummary, RoomStatus } from '../api/types';
import { formatRelative } from '../utils/format';

const STATUS_LABELS: Record<RoomStatus, string> = {
  active: '进行中',
  paused_limit: '已暂停',
  paused_manual: '已暂停',
  completed: '已结束',
};

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
  const navigate = useNavigate();
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [name, setName] = useState('');
  const [maxSessions, setMaxSessions] = useState('');
  const [workdir, setWorkdir] = useState('');
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  function refreshRooms() {
    return fetchRooms().then(setRooms).catch((err: Error) => setError(err.message));
  }

  useEffect(() => {
    refreshRooms();
    fetchAgents()
      .then(setAgents)
      .catch((err: Error) => setError(err.message));
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
      setError('session 上限必须是正整数');
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
      setError((err as Error).message);
    }
  }

  async function handleDelete(room: RoomSummary) {
    if (!window.confirm('删除这个房间？将级联删除它的 session、记忆、事件树、信息流与磁盘日志，不可恢复。')) {
      return;
    }
    setError(null);
    try {
      await deleteRoom(room.id);
      await refreshRooms();
    } catch (err) {
      setError((err as Error).message);
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
      </div>

      <div className="room-list__body">
        <section>
          <h2 className="section-title">房间</h2>
          {error && <p role="alert" className="error-inline">{error}</p>}
          {rooms.length === 0 ? (
            <p className="placeholder">还没有房间，创建一个吧</p>
          ) : (
            <div className="room-grid">
              {rooms.map((room) => (
                <div key={room.id} className="room-card">
                  <Link to={`/rooms/${room.id}`} className="room-card__link">
                    <span className="room-card__name">{room.name}</span>
                    <span className="room-card__meta">
                      <span className={`status-pill status-pill--${room.status}`}>{STATUS_LABELS[room.status]}</span>
                      <span className="mono">{formatRelative(room.createdAt)}</span>
                    </span>
                  </Link>
                  {room.status === 'completed' && (
                    <button className="danger ghost room-card__delete" onClick={() => handleDelete(room)}>
                      删除
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        <form className="create-panel" onSubmit={handleSubmit} noValidate>
          <h2 className="section-title" style={{ margin: 0 }}>新建房间</h2>

          <div className="field">
            <label htmlFor="room-name">房间名</label>
            <input
              id="room-name"
              aria-label="room name"
              value={name}
              placeholder="仅用于列表展示"
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="field">
            <span className="field__label">参与的 agent（可重复点击加入多个实例）</span>
            <div className="chips">
              {agents.map((agent) => {
                const count = countFor(agent.agentId);
                return (
                  <button
                    type="button"
                    key={agent.agentId}
                    className={`chip ${count > 0 ? 'chip--on' : ''}`}
                    aria-label={`add ${agent.agentId}`}
                    disabled={!agent.available}
                    title={agent.available ? undefined : agent.unavailableReason ?? '该 agent 当前不可用'}
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
              <span className="field__label">已加入实例（按加入顺序）</span>
              <div className="chips">
                {instanceIds.map((instanceId, index) => (
                  <span key={`${instanceId}-${index}`} className="chip chip--on">
                    {instanceId}
                    <button
                      type="button"
                      className="chip__remove"
                      aria-label={`remove ${instanceId}`}
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
                      清空 {agent.agentId}
                    </button>
                  ))}
              </div>
            </div>
          )}

          <div className="field">
            <label htmlFor="room-max-sessions">session 上限</label>
            <input
              id="room-max-sessions"
              aria-label="max sessions"
              type="number"
              min={1}
              placeholder="默认 20"
              value={maxSessions}
              onChange={(e) => setMaxSessions(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="room-workdir">工作目录</label>
            <input
              id="room-workdir"
              aria-label="workdir"
              value={workdir}
              placeholder="默认：服务端目录"
              onChange={(e) => setWorkdir(e.target.value)}
            />
          </div>

          <div className="field">
            <span className="field__label">调度模式</span>
            <div className="chips">
              <span className="mode-option">
                <input type="radio" checked readOnly aria-label="sequential" /> sequential
              </span>
              <span className="mode-option mode-option--disabled" title="v1 未实现">parallel</span>
            </div>
          </div>

          <button type="submit" className="primary" disabled={!name || instanceIds.length === 0}>
            Create
          </button>
        </form>
      </div>
    </div>
  );
}
