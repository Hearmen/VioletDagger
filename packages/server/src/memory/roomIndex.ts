import type Database from 'better-sqlite3';
import { getRoomMessages, getRoomStateTransitions } from '../storage/messages';
import type { Message, StateTransition } from '../storage/types';

// 三个出口共用的一次建表（见 02-memory-management.md §2）：每次构建只读一次消息与转换记录。
export interface RoomIndex {
  messages: Message[];                                   // 按 id 升序
  byId: Map<number, Message>;
  transitionsByMessage: Map<number, StateTransition[]>;  // 按 id 升序
  reactionsByTarget: Map<number, Message[]>;             // challenge/verify 且 targetMessageId 指向该消息，按 id 升序
  answersByQuestion: Map<number, Message[]>;             // 当前 type 为 hypothesis/fact/boundary/chain 且指向该 open_question
  referencedBy: Map<number, number[]>;                   // 哪些消息的 referencedMessageIds 包含该 id
}

const ANSWER_TYPES = new Set(['hypothesis', 'fact', 'boundary', 'chain']);

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function buildRoomIndex(db: Database.Database, roomId: number): RoomIndex {
  const messages = getRoomMessages(db, roomId);
  const byId = new Map(messages.map((m) => [m.id, m]));
  const transitionsByMessage = new Map<number, StateTransition[]>();
  for (const transition of getRoomStateTransitions(db, roomId)) {
    push(transitionsByMessage, transition.messageId, transition);
  }

  const reactionsByTarget = new Map<number, Message[]>();
  const answersByQuestion = new Map<number, Message[]>();
  const referencedBy = new Map<number, number[]>();
  for (const m of messages) {
    if (m.targetMessageId != null) {
      if (m.type === 'challenge' || m.type === 'verify') push(reactionsByTarget, m.targetMessageId, m);
      if (ANSWER_TYPES.has(m.type ?? '') && isQuestion(byId.get(m.targetMessageId))) {
        push(answersByQuestion, m.targetMessageId, m);
      }
    }
    for (const id of m.referencedMessageIds) push(referencedBy, id, m.id);
  }
  return { messages, byId, transitionsByMessage, reactionsByTarget, answersByQuestion, referencedBy };
}

export function isQuestion(message: Message | undefined): boolean {
  return message?.type === 'open_question';
}
