import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RoomListPage } from '../../src/pages/RoomListPage';
import * as rest from '../../src/api/rest';

vi.mock('../../src/api/rest');

describe('RoomListPage', () => {
  beforeEach(() => {
    vi.mocked(rest.fetchRooms).mockResolvedValue([
      { id: 1, name: 'room a', status: 'active', createdAt: 'now' },
    ]);
    vi.mocked(rest.fetchAgents).mockResolvedValue([{ agentId: 'codex' }, { agentId: 'claude' }]);
  });

  it('lists existing rooms', async () => {
    render(<MemoryRouter><RoomListPage /></MemoryRouter>);
    expect(await screen.findByText('room a')).toBeInTheDocument();
  });

  it('renders an agent checkbox per registered agent', async () => {
    render(<MemoryRouter><RoomListPage /></MemoryRouter>);
    expect(await screen.findByLabelText('codex')).toBeInTheDocument();
    expect(screen.getByLabelText('claude')).toBeInTheDocument();
  });

  it('disables Create until a name and at least one agent are chosen', async () => {
    render(<MemoryRouter><RoomListPage /></MemoryRouter>);
    await screen.findByLabelText('codex');
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('room name'), { target: { value: 'new room' } });
    fireEvent.click(screen.getByLabelText('codex'));
    expect(screen.getByRole('button', { name: 'Create' })).not.toBeDisabled();
  });

  it('submits the form via createRoom', async () => {
    vi.mocked(rest.createRoom).mockResolvedValue({
      id: 9, name: 'new room', schedulingMode: 'sequential', status: 'active', maxSessions: 20, createdAt: 'now',
    });
    render(<MemoryRouter><RoomListPage /></MemoryRouter>);
    await screen.findByLabelText('codex');

    fireEvent.change(screen.getByLabelText('room name'), { target: { value: 'new room' } });
    fireEvent.click(screen.getByLabelText('codex'));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(rest.createRoom).toHaveBeenCalledWith({ name: 'new room', agentIds: ['codex'], schedulingMode: 'sequential' }),
    );
  });
});
