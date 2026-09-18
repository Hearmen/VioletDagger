import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RoomListPage } from '../../src/pages/RoomListPage';
import * as rest from '../../src/api/rest';

vi.mock('../../src/api/rest');

describe('RoomListPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(rest.fetchRooms).mockResolvedValue([
      { id: 1, name: 'room a', status: 'active', createdAt: 'now' },
    ]);
    vi.mocked(rest.fetchAgents).mockResolvedValue([
      { agentId: 'codex', available: true },
      { agentId: 'claude', available: true },
    ]);
    vi.mocked(rest.deleteRoom).mockResolvedValue(undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('lists existing rooms', async () => {
    render(<MemoryRouter><RoomListPage /></MemoryRouter>);
    expect(await screen.findByText('room a')).toBeInTheDocument();
  });

  it('renders an add chip per registered agent', async () => {
    render(<MemoryRouter><RoomListPage /></MemoryRouter>);
    expect(await screen.findByLabelText('add codex')).toBeInTheDocument();
    expect(screen.getByLabelText('add claude')).toBeInTheDocument();
  });

  it('disables unavailable agents and shows the reason', async () => {
    vi.mocked(rest.fetchAgents).mockResolvedValue([
      { agentId: 'codex', available: false, unavailableReason: '未通过适配' },
    ]);
    render(<MemoryRouter><RoomListPage /></MemoryRouter>);
    const chip = await screen.findByLabelText('add codex');
    expect(chip).toBeDisabled();
    expect(chip).toHaveAttribute('title', '未通过适配');
    fireEvent.click(chip);
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  it('disables Create until a name and at least one agent instance are chosen', async () => {
    render(<MemoryRouter><RoomListPage /></MemoryRouter>);
    await screen.findByLabelText('add codex');
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('room name'), { target: { value: 'new room' } });
    fireEvent.click(screen.getByLabelText('add codex'));
    expect(screen.getByRole('button', { name: 'Create' })).not.toBeDisabled();
  });

  it('submits the form via createRoom with agentIds', async () => {
    vi.mocked(rest.createRoom).mockResolvedValue({
      id: 9, name: 'new room', schedulingMode: 'sequential', status: 'active', maxSessions: 20, workdir: '/tmp/work', createdAt: 'now',
    });
    render(<MemoryRouter><RoomListPage /></MemoryRouter>);
    await screen.findByLabelText('add codex');

    fireEvent.change(screen.getByLabelText('room name'), { target: { value: 'new room' } });
    fireEvent.click(screen.getByLabelText('add codex'));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(rest.createRoom).toHaveBeenCalledWith({ name: 'new room', agentIds: ['codex'], schedulingMode: 'sequential' }),
    );
  });

  it('passes an optional maxSessions through when filled', async () => {
    vi.mocked(rest.createRoom).mockResolvedValue({
      id: 9, name: 'new room', schedulingMode: 'sequential', status: 'active', maxSessions: 9, workdir: '/tmp/work', createdAt: 'now',
    });
    render(<MemoryRouter><RoomListPage /></MemoryRouter>);
    await screen.findByLabelText('add codex');

    fireEvent.change(screen.getByLabelText('room name'), { target: { value: 'new room' } });
    fireEvent.change(screen.getByLabelText('max sessions'), { target: { value: '9' } });
    fireEvent.click(screen.getByLabelText('add codex'));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(rest.createRoom).toHaveBeenCalledWith({
        name: 'new room', agentIds: ['codex'], schedulingMode: 'sequential', maxSessions: 9,
      }),
    );
  });

  it('passes an optional workdir through when filled', async () => {
    vi.mocked(rest.createRoom).mockResolvedValue({
      id: 9, name: 'new room', schedulingMode: 'sequential', status: 'active', maxSessions: 20, workdir: '/tmp/room-w', createdAt: 'now',
    });
    render(<MemoryRouter><RoomListPage /></MemoryRouter>);
    await screen.findByLabelText('add codex');

    fireEvent.change(screen.getByLabelText('room name'), { target: { value: 'new room' } });
    fireEvent.change(screen.getByLabelText('workdir'), { target: { value: '/tmp/room-w' } });
    fireEvent.click(screen.getByLabelText('add codex'));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(rest.createRoom).toHaveBeenCalledWith({
        name: 'new room', agentIds: ['codex'], schedulingMode: 'sequential', workdir: '/tmp/room-w',
      }),
    );
  });

  it('rejects a non-positive maxSessions without calling createRoom', async () => {
    render(<MemoryRouter><RoomListPage /></MemoryRouter>);
    await screen.findByLabelText('add codex');

    fireEvent.change(screen.getByLabelText('room name'), { target: { value: 'new room' } });
    fireEvent.change(screen.getByLabelText('max sessions'), { target: { value: '0' } });
    fireEvent.click(screen.getByLabelText('add codex'));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('session 上限必须是正整数');
    expect(rest.createRoom).not.toHaveBeenCalled();
  });

  it('allows adding the same agent multiple times and previews numbered instances', async () => {
    render(<MemoryRouter><RoomListPage /></MemoryRouter>);
    await screen.findByLabelText('add codex');

    fireEvent.click(screen.getByLabelText('add codex'));
    fireEvent.click(screen.getByLabelText('add codex'));

    expect(screen.getByText('codex-1')).toBeInTheDocument();
    expect(screen.getByText('codex-2')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('remove codex-1'));
    expect(screen.queryByText('codex-1')).not.toBeInTheDocument();
    expect(screen.getAllByText('codex').length).toBeGreaterThan(0);
  });

  it('shows a delete button only for completed rooms and deletes on confirm', async () => {
    vi.mocked(rest.fetchRooms).mockResolvedValue([
      { id: 1, name: 'done', status: 'completed', createdAt: 'now' },
      { id: 2, name: 'running', status: 'active', createdAt: 'now' },
    ]);
    render(<MemoryRouter><RoomListPage /></MemoryRouter>);
    await screen.findByText('done');

    const deleteButtons = screen.getAllByRole('button', { name: '删除' });
    expect(deleteButtons).toHaveLength(1);

    fireEvent.click(deleteButtons[0]);
    await waitFor(() => expect(rest.deleteRoom).toHaveBeenCalledWith(1));
  });

  it('shows an error message when the initial room list fails to load', async () => {
    vi.mocked(rest.fetchRooms).mockRejectedValue(new Error('failed to fetch rooms'));
    render(<MemoryRouter><RoomListPage /></MemoryRouter>);
    expect(await screen.findByRole('alert')).toHaveTextContent('failed to fetch rooms');
  });

  it('shows an error message when createRoom fails', async () => {
    vi.mocked(rest.createRoom).mockRejectedValue(new Error('failed to create room'));
    render(<MemoryRouter><RoomListPage /></MemoryRouter>);
    await screen.findByLabelText('add codex');

    fireEvent.change(screen.getByLabelText('room name'), { target: { value: 'new room' } });
    fireEvent.click(screen.getByLabelText('add codex'));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('failed to create room');
  });
});
