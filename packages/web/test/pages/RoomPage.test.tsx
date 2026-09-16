import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { RoomPage } from '../../src/pages/RoomPage';
import * as rest from '../../src/api/rest';
import { useRoomSocket } from '../../src/hooks/useRoomSocket';

vi.mock('../../src/api/rest');
vi.mock('../../src/hooks/useRoomSocket');

function renderRoomPage() {
  return render(
    <MemoryRouter initialEntries={['/rooms/1']}>
      <Routes>
        <Route path="/rooms/:roomId" element={<RoomPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RoomPage', () => {
  const call = vi.fn();
  const subscribe = vi.fn().mockReturnValue(() => {});

  beforeEach(() => {
    vi.mocked(rest.fetchRoom).mockResolvedValue({
      id: 1, name: 'room a', schedulingMode: 'sequential', status: 'active', maxSessions: 20, createdAt: 'now',
    });
    call.mockReset();
    call.mockImplementation((method: string) => {
      if (method === 'getRoomStatus') return Promise.resolve({ currentSessionCount: 1, status: 'active', agents: [] });
      if (method === 'listMessages') return Promise.resolve({ messages: [], nextCursor: null });
      if (method === 'getMemoryView') return Promise.resolve({ facts: [], boundaries: [], openQuestions: [], chains: [], hypotheses: [], exploring: [] });
      if (method === 'getEventTree') return Promise.resolve({ sessions: [] });
      return Promise.resolve({ ok: true });
    });
    vi.mocked(useRoomSocket).mockReturnValue({ call, subscribe, connectionState: 'connected' });
  });

  it('shows a loading state before room/status resolve, then renders the header', async () => {
    renderRoomPage();
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(await screen.findByText('room a')).toBeInTheDocument();
  });

  it('shows the error banner during initial load when a load call fails, alongside Loading...', async () => {
    call.mockImplementation((method: string) => {
      if (method === 'getRoomStatus') return Promise.reject(new Error('status fetch failed'));
      if (method === 'listMessages') return Promise.resolve({ messages: [], nextCursor: null });
      if (method === 'getMemoryView') return Promise.resolve({ facts: [], boundaries: [], openQuestions: [], chains: [], hypotheses: [], exploring: [] });
      if (method === 'getEventTree') return Promise.resolve({ sessions: [] });
      return Promise.resolve({ ok: true });
    });
    renderRoomPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('status fetch failed');
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('sends a human message via postHumanMessage', async () => {
    renderRoomPage();
    await screen.findByText('room a');

    fireEvent.change(screen.getByLabelText('content'), { target: { value: 'the goal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('postHumanMessage', {
        content: 'the goal', type: undefined, targetMessageId: undefined, referencedMessageIds: undefined,
      }),
    );
  });

  it('shows an error banner when postHumanMessage fails', async () => {
    call.mockImplementation((method: string) => {
      if (method === 'getRoomStatus') return Promise.resolve({ currentSessionCount: 1, status: 'active', agents: [] });
      if (method === 'listMessages') return Promise.resolve({ messages: [], nextCursor: null });
      if (method === 'getMemoryView') return Promise.resolve({ facts: [], boundaries: [], openQuestions: [], chains: [], hypotheses: [], exploring: [] });
      if (method === 'getEventTree') return Promise.resolve({ sessions: [] });
      if (method === 'postHumanMessage') return Promise.reject(new Error('rpc failed'));
      return Promise.resolve({ ok: true });
    });
    renderRoomPage();
    await screen.findByText('room a');

    fireEvent.change(screen.getByLabelText('content'), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('rpc failed');
  });

  it('passes connectionState through to RoomHeader so the disconnect banner can show', async () => {
    vi.mocked(useRoomSocket).mockReturnValue({ call, subscribe, connectionState: 'disconnected' });
    renderRoomPage();
    await screen.findByText('room a');
    expect(screen.getByText('连接已断开，正在重连…')).toBeInTheDocument();
  });

  it('disables the send box and hides Terminate when the room is completed', async () => {
    call.mockImplementation((method: string) => {
      if (method === 'getRoomStatus') {
        return Promise.resolve({
          currentSessionCount: 1,
          status: 'completed',
          agents: [{ agentId: 'claude', state: 'running', sessionId: 3, sessionStartedAt: new Date().toISOString() }],
        });
      }
      if (method === 'listMessages') return Promise.resolve({ messages: [], nextCursor: null });
      if (method === 'getMemoryView') return Promise.resolve({ facts: [], boundaries: [], openQuestions: [], chains: [], hypotheses: [], exploring: [] });
      if (method === 'getEventTree') return Promise.resolve({ sessions: [] });
      return Promise.resolve({ ok: true });
    });
    renderRoomPage();
    await screen.findByText('room a');

    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByLabelText('content')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Terminate' })).not.toBeInTheDocument();
  });
});
