import { EventEmitter } from 'node:events';
import type { Message } from './storage';

export interface RoomEventMap {
  message: [{ roomId: number; message: Message }];
  memoryUpdate: [{ roomId: number; messageId: number }];
  roomStatus: [{ roomId: number }];
}

export const roomEvents = new EventEmitter<RoomEventMap>();
