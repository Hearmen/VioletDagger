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

  useEffect(() => {
    fetchRoom(roomIdNum).then(setRoom);
    socket.call<RoomStatusPayload>('getRoomStatus').then(setStatus);
    socket.call<{ messages: Message[]; nextCursor: number | null }>('listMessages', {}).then((r) => setMessages(r.messages));
    socket.call<MemoryViewPayload>('getMemoryView').then(setMemory);
    socket.call<EventTreePayload>('getEventTree').then(setEventTree);

    const unsubMessage = socket.subscribe('newMessage', (message: Message) => {
      setMessages((prev) => [...prev, message]);
      if (message.type != null) {
        socket.call<MemoryViewPayload>('getMemoryView').then(setMemory);
      }
    });
    const unsubMemory = socket.subscribe('memoryUpdate', () => {
      socket.call<MemoryViewPayload>('getMemoryView').then(setMemory);
    });
    const unsubStatus = socket.subscribe('roomStatus', () => {
      socket.call<RoomStatusPayload>('getRoomStatus').then(setStatus);
      fetchRoom(roomIdNum).then(setRoom);
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
    socket.call('postHumanMessage', params);
  }

  function handleOpenSession(seq: number) {
    socket.call<SessionDetailPayload>('getSessionDetail', { sessionId: seq }).then(setSessionDetail);
  }

  return (
    <div>
      <RoomHeader
        room={room}
        status={status}
        onPause={() => socket.call('pauseRoom')}
        onResume={(additionalSessions) => socket.call('resumeRoom', { additionalSessions })}
        onConfirmCompletion={() => socket.call('confirmCompletion')}
      />
      <AgentStatusBar
        agents={status.agents}
        onTerminate={(sessionId) => socket.call('terminateAgentSession', { sessionId })}
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
