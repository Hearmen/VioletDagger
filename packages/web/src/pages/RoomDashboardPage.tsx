import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { fetchRoom, deleteRoom } from '../api/rest';
import { useRoomSocket } from '../hooks/useRoomSocket';
import { useDashboardLayout } from '../hooks/useDashboardLayout';
import { useToasts } from '../hooks/useToasts';
import { Splitter } from '../components/Splitter';
import { RoomHeader } from '../components/RoomHeader';
import { AgentRail } from '../components/AgentRail';
import { MessageStreamPanel } from '../components/MessageStreamPanel';
import { MemoryPanel } from '../components/MemoryPanel';
import { EventTreePanel } from '../components/EventTreePanel';
import { SessionDetailModal } from '../components/SessionDetailModal';
import { LiveSessionModal, type LiveSessionSnapshot, type LiveSessionTarget } from '../components/LiveSessionModal';
import { ToastStack } from '../components/ToastStack';
import type {
  Room, RoomStatusPayload, Message, MessageType, MemoryViewPayload, EventTreePayload,
  SessionDetailPayload,
} from '../api/types';

interface MessagesPage {
  messages: Message[];
  nextCursor: number | null;
}

export function RoomDashboardPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const roomIdNum = Number(roomId);
  const navigate = useNavigate();
  const socket = useRoomSocket(roomIdNum);
  const { toasts, push: pushToast, dismiss } = useToasts();
  const { style: layoutStyle, adjustAgentsW, adjustEventsW, adjustMemoryH } = useDashboardLayout();

  const [room, setRoom] = useState<Room | null>(null);
  const [status, setStatus] = useState<RoomStatusPayload | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [memory, setMemory] = useState<MemoryViewPayload | null>(null);
  const [eventTree, setEventTree] = useState<EventTreePayload | null>(null);
  const [sessionDetail, setSessionDetail] = useState<SessionDetailPayload | null>(null);
  const [liveSession, setLiveSession] = useState<LiveSessionTarget | null>(null);
  const [liveDetail, setLiveDetail] = useState<SessionDetailPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [jumpToMessageId, setJumpToMessageId] = useState<number | null>(null);

  function reportLoadError(err: unknown) {
    setLoadError(err instanceof Error ? err.message : 'unknown error');
  }

  function reportActionError(err: unknown) {
    pushToast(err instanceof Error ? err.message : 'unknown error');
  }

  const refreshMemory = () => socket.call<MemoryViewPayload>('getMemoryView').then(setMemory).catch(reportLoadError);
  const refreshEventTree = () => socket.call<EventTreePayload>('getEventTree').then(setEventTree).catch(reportLoadError);
  const refreshStatus = () => socket.call<RoomStatusPayload>('getRoomStatus').then(setStatus).catch(reportLoadError);

  useEffect(() => {
    setLoadError(null);
    fetchRoom(roomIdNum).then(setRoom).catch(reportLoadError);
    socket.call<RoomStatusPayload>('getRoomStatus').then(setStatus).catch(reportLoadError);
    socket.call<MemoryViewPayload>('getMemoryView').then(setMemory).catch(reportLoadError);
    socket.call<EventTreePayload>('getEventTree').then(setEventTree).catch(reportLoadError);
    socket
      .call<MessagesPage>('listMessages', {})
      .then((page) => {
        setMessages(page.messages);
        setNextCursor(page.nextCursor);
      })
      .catch(reportLoadError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomIdNum, socket.reconnectCount]);

  useEffect(() => {
    const unsubMessage = socket.subscribe('newMessage', (message: Message) => {
      setMessages((prev) => [...prev, message]);
      if (message.type != null) {
        refreshMemory();
        refreshEventTree();
      }
    });
    const unsubMemory = socket.subscribe('memoryUpdate', () => {
      refreshMemory();
    });
    const unsubStatus = socket.subscribe('roomStatus', () => {
      refreshStatus();
      fetchRoom(roomIdNum).then(setRoom).catch(reportLoadError);
      refreshEventTree();
    });
    const unsubDeleted = socket.subscribe('roomDeleted', () => {
      setSessionDetail(null);
      setLiveSession(null);
      setLiveDetail(null);
      navigate('/');
    });
    return () => {
      unsubMessage();
      unsubMemory();
      unsubStatus();
      unsubDeleted();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomIdNum]);

  // 打开/刷新固定目标的 session 详情备用（08 §2：不从 rawLog 重放实时日志，仅取元数据/outcome/exit 信息）。
  useEffect(() => {
    if (!liveSession) {
      setLiveDetail(null);
      return;
    }
    socket
      .call<SessionDetailPayload>('getSessionDetail', { sessionId: liveSession.sessionId })
      .then((detail) => setLiveDetail(detail))
      .catch(reportActionError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSession?.sessionId, socket.reconnectCount]);

  // roomStatus 时刷新当前打开的 detail（08 §2、07 §13）。
  useEffect(() => {
    const unsub = socket.subscribe('roomStatus', () => {
      if (liveSession) {
        socket
          .call<SessionDetailPayload>('getSessionDetail', { sessionId: liveSession.sessionId })
          .then(setLiveDetail)
          .catch(reportActionError);
      }
      if (sessionDetail) {
        socket
          .call<SessionDetailPayload>('getSessionDetail', { sessionId: sessionDetail.sessionId })
          .then(setSessionDetail)
          .catch(reportActionError);
      }
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSession?.sessionId, sessionDetail?.sessionId]);

  const proposeCompletionId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].type === 'propose_completion') return messages[i].id;
    }
    return null;
  }, [messages]);

  const liveSnapshot: LiveSessionSnapshot | null = useMemo(() => {
    if (!liveSession) return null;
    if (liveDetail && liveDetail.sessionId === liveSession.sessionId) {
      const agent = status?.agents.find((item) => item.sessionId === liveSession.sessionId);
      return {
        outcome: liveDetail.outcome,
        endedAt: liveDetail.endedAt,
        exitCode: liveDetail.exitCode,
        exitCause: liveDetail.exitCause,
        exitWarning: agent?.exitWarning,
      };
    }
    const agent = status?.agents.find((item) => item.sessionId === liveSession.sessionId);
    if (!agent) return null;
    return {
      outcome: agent.state === 'stopping' ? 'stopping' : 'running',
      endedAt: null,
      exitCode: null,
      exitCause: null,
      exitWarning: agent.exitWarning,
    };
  }, [liveSession, liveDetail, status]);

  function openLiveSession(sessionId: number) {
    const agent = status?.agents.find((item) => item.sessionId === sessionId);
    setLiveSession({ roomId: roomIdNum, sessionId, agentId: agent?.agentId ?? '', startedAt: agent?.sessionStartedAt });
  }

  async function handleDeleteRoom() {
    try {
      await deleteRoom(roomIdNum);
      navigate('/');
    } catch (err) {
      reportActionError(err);
    }
  }

  function handleLoadEarlier() {
    if (nextCursor == null || loadingEarlier) return;
    setLoadingEarlier(true);
    socket
      .call<MessagesPage>('listMessages', { cursor: nextCursor })
      .then((page) => {
        setMessages((prev) => [...page.messages, ...prev]);
        setNextCursor(page.nextCursor);
      })
      .catch(reportActionError)
      .finally(() => setLoadingEarlier(false));
  }

  if (!room || !status) {
    return (
      <>
        <div className="room-list">
          <div className="app-bar">
            <span className="brand">
              <span className="brand__mark">◆</span> VioletDagger
            </span>
          </div>
          <div style={{ padding: 20 }}>
            {loadError && <p role="alert" className="error-inline">{loadError}</p>}
            <p className="placeholder">Loading…</p>
          </div>
        </div>
        <ToastStack toasts={toasts} onDismiss={dismiss} />
      </>
    );
  }

  const readOnly = status.status === 'completed';

  return (
    <>
      <div className="dashboard" style={layoutStyle}>
        <Splitter orientation="v" area="agents" onDrag={adjustAgentsW} />
        <Splitter orientation="v" area="events" onDrag={adjustEventsW} />
        <Splitter orientation="h" area="memory" onDrag={adjustMemoryH} />
        <RoomHeader
          room={room}
          status={status}
          connectionState={socket.connectionState}
          proposeCompletionId={proposeCompletionId}
          onJumpToMessage={setJumpToMessageId}
          onPause={() => socket.call('pauseRoom').catch(reportActionError)}
          onResume={(additionalSessions) =>
            socket.call('resumeRoom', { additionalSessions }).catch(reportActionError)
          }
          onConfirmCompletion={() => socket.call('confirmCompletion').catch(reportActionError)}
          onDeleteRoom={handleDeleteRoom}
        />
        <AgentRail
          agents={status.agents}
          onTerminate={(sessionId) =>
            socket.call('terminateAgentSession', { sessionId }).catch(reportActionError)
          }
          onOpenSession={openLiveSession}
          onSetAgentEnabled={(agentId, enabled) =>
            socket
              .call('setAgentEnabled', { agentId, enabled })
              .then(() => refreshStatus())
              .catch(reportActionError)
          }
        />
        {memory ? (
          <MemoryPanel memory={memory} onJumpToMessage={setJumpToMessageId} />
        ) : (
          <div className="panel memory-panel">
            <header className="panel__head">
              <h2 className="panel__title">记忆</h2>
            </header>
            <div className="panel__body">
              <div className="placeholder">Loading…</div>
            </div>
          </div>
        )}
        <MessageStreamPanel
          messages={messages}
          nextCursor={nextCursor}
          loadingEarlier={loadingEarlier}
          onLoadEarlier={handleLoadEarlier}
          onSend={(params: {
            content: string;
            type?: MessageType;
            targetMessageId?: number;
          }) => socket.call('postHumanMessage', params).catch(reportActionError)}
          readOnly={readOnly}
          jumpToMessageId={jumpToMessageId}
          onJumpHandled={() => setJumpToMessageId(null)}
        />
        {eventTree ? (
          <EventTreePanel
            sessions={eventTree.sessions}
            messages={messages}
            onOpenSession={(sessionId) =>
              socket.call<SessionDetailPayload>('getSessionDetail', { sessionId }).then(setSessionDetail).catch(reportActionError)
            }
            onJumpToMessage={setJumpToMessageId}
          />
        ) : (
          <div className="panel event-tree-panel">
            <header className="panel__head">
              <h2 className="panel__title">事件树</h2>
            </header>
            <div className="panel__body">
              <div className="placeholder">Loading…</div>
            </div>
          </div>
        )}
      </div>
      {liveSession && (
        <LiveSessionModal
          target={liveSession}
          snapshot={liveSnapshot}
          roomConnected={socket.connectionState === 'connected'}
          onTerminate={(sessionId) =>
            socket
              .call('terminateAgentSession', { sessionId })
              .then(() => refreshStatus())
              .catch((err) => {
                reportActionError(err);
                throw err;
              })
          }
          onClose={() => setLiveSession(null)}
        />
      )}
      <SessionDetailModal roomId={roomIdNum} detail={sessionDetail} onClose={() => setSessionDetail(null)} />
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </>
  );
}
