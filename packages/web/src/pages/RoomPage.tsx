import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { fetchRoom } from '../api/rest';
import { useRoomSocket } from '../hooks/useRoomSocket';
import { RoomHeader } from '../components/RoomHeader';
import { AgentStatusBar } from '../components/AgentStatusBar';
import { MessageStreamTab } from '../components/MessageStreamTab';
import { MemoryPanelTab } from '../components/MemoryPanelTab';
import { EventTreeTab } from '../components/EventTreeTab';
import { SessionDetailModal } from '../components/SessionDetailModal';
import type {
  Room, RoomStatusPayload, Message, MemoryViewPayload, EventTreePayload, SessionDetailPayload, MessageType,
} from '../api/types';

type TabName = 'messages' | 'memory' | 'events';

export function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const roomIdNum = Number(roomId);
  const socket = useRoomSocket(roomIdNum);

  const [room, setRoom] = useState<Room | null>(null);
  const [status, setStatus] = useState<RoomStatusPayload | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [memory, setMemory] = useState<MemoryViewPayload | null>(null);
  const [eventTree, setEventTree] = useState<EventTreePayload | null>(null);
  const [sessionDetail, setSessionDetail] = useState<SessionDetailPayload | null>(null);
  const [tab, setTab] = useState<TabName>('messages');
  const [error, setError] = useState<string | null>(null);

  function reportError(err: unknown) {
    setError(err instanceof Error ? err.message : 'unknown error');
  }

  useEffect(() => {
    fetchRoom(roomIdNum).then(setRoom).catch(reportError);
    socket.call<RoomStatusPayload>('getRoomStatus').then(setStatus).catch(reportError);
    socket.call<{ messages: Message[]; nextCursor: number | null }>('listMessages', {}).then((r) => setMessages(r.messages)).catch(reportError);
    socket.call<MemoryViewPayload>('getMemoryView').then(setMemory).catch(reportError);
    socket.call<EventTreePayload>('getEventTree').then(setEventTree).catch(reportError);

    const unsubMessage = socket.subscribe('newMessage', (message: Message) => {
      setMessages((prev) => [...prev, message]);
      if (message.type != null) {
        socket.call<MemoryViewPayload>('getMemoryView').then(setMemory).catch(reportError);
      }
    });
    const unsubMemory = socket.subscribe('memoryUpdate', () => {
      socket.call<MemoryViewPayload>('getMemoryView').then(setMemory).catch(reportError);
    });
    const unsubStatus = socket.subscribe('roomStatus', () => {
      socket.call<RoomStatusPayload>('getRoomStatus').then(setStatus).catch(reportError);
      fetchRoom(roomIdNum).then(setRoom).catch(reportError);
    });

    return () => {
      unsubMessage();
      unsubMemory();
      unsubStatus();
    };
  }, [roomIdNum]);

  if (!room || !status) return <p>Loading...</p>;

  function handleSend(params: {
    content: string;
    type?: MessageType;
    targetMessageId?: number;
    referencedMessageIds?: number[];
  }) {
    socket.call('postHumanMessage', params).catch(reportError);
  }

  function handleOpenSession(seq: number) {
    socket.call<SessionDetailPayload>('getSessionDetail', { sessionId: seq }).then(setSessionDetail).catch(reportError);
  }

  return (
    <div>
      {error && <p role="alert">{error}</p>}
      <RoomHeader
        room={room}
        status={status}
        connectionState={socket.connectionState}
        onPause={() => socket.call('pauseRoom').catch(reportError)}
        onResume={(additionalSessions) => socket.call('resumeRoom', { additionalSessions }).catch(reportError)}
        onConfirmCompletion={() => socket.call('confirmCompletion').catch(reportError)}
      />
      <AgentStatusBar
        agents={status.agents}
        onTerminate={(sessionId) => socket.call('terminateAgentSession', { sessionId }).catch(reportError)}
      />
      <nav>
        <button onClick={() => setTab('messages')}>Messages</button>
        <button onClick={() => setTab('memory')}>Memory</button>
        <button onClick={() => setTab('events')}>Events</button>
      </nav>
      {tab === 'messages' && <MessageStreamTab messages={messages} onSend={handleSend} />}
      {tab === 'memory' && memory && <MemoryPanelTab memory={memory} />}
      {tab === 'events' && eventTree && <EventTreeTab eventTree={eventTree} onOpenSession={handleOpenSession} />}
      <SessionDetailModal detail={sessionDetail} onClose={() => setSessionDetail(null)} />
    </div>
  );
}
