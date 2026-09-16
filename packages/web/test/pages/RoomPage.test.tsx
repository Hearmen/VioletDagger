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
    vi.mocked(useRoomSocket).mockReturnValue({ call, subscribe });
  });

  it('shows a loading state before room/status resolve, then renders the header', async () => {
    renderRoomPage();
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(await screen.findByText('room a')).toBeInTheDocument();
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
});
