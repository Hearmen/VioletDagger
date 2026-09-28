import type Database from 'better-sqlite3';
import {
  runInTransaction, insertMessage, getMessageById, countMessages, getActiveExploringByAuthor, getRoomAgents,
  getSession, setMessageType, setQuestionStatus, setChainStatus, setDispatchPending, setDirectedPending,
} from '../storage';
import { MESSAGE_TYPES, type CloseReason, type Message, type MessageType } from '../storage/types';
import { roomEvents } from '../events';
import { checkAndDispatch, type StartSession } from './dispatch';
import { resetStuckCount, type StuckCounter } from './stuckCounter';

export type MessageAuthor =
  | { kind: 'agent'; agentId: string; sessionSeq: number } // sessionSeq 由 MCP Server 从固定绑定取得
  | { kind: 'human' };

export interface SubmitMessageInput {
  roomId: number;
  author: MessageAuthor;
  content: string;
  type?: MessageType;
  targetMessageId?: number;
  referencedMessageIds?: number[];
  verifyVerdict?: boolean;
  closesQuestion?: boolean;
  chainResolution?: CloseReason;
  summary?: string;
  targetAgentId?: string; // 只有 author.kind === 'human' 时可提供
}

// 校验失败；调用方把 message 原样作为业务错误返回。
export class SubmitMessageError extends Error {}

const CLOSE_REASONS: readonly string[] = ['RESOLVED', 'UNRESOLVED'];

function fail(message: string): never {
  throw new SubmitMessageError(message);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

// 写入校验（见 03-orchestrator-core.md §1.4 的表格与通用规则）；状态约束按目标的当前状态校验。
function validate(db: Database.Database, input: SubmitMessageInput, type: MessageType | undefined): void {
  const { roomId, author } = input;

  if (typeof input.content !== 'string') fail('content must be a string');
  if (input.summary !== undefined && typeof input.summary !== 'string') fail('summary must be a string');
  if (type !== undefined && !MESSAGE_TYPES.includes(type)) fail(`unknown message type "${type}"`);

  // 字段归属
  if (input.verifyVerdict !== undefined && type !== 'verify') fail('verifyVerdict is only allowed for type "verify"');
  if (input.closesQuestion !== undefined && type !== 'chain') fail('closesQuestion is only allowed for type "chain"');
  if (input.chainResolution !== undefined && type !== 'chain') fail('chainResolution is only allowed for type "chain"');

  // targetAgentId：只允许人类提供，且必须是本房间的 agent 实例标识
  if (input.targetAgentId !== undefined) {
    if (author.kind !== 'human') fail('targetAgentId is only allowed for human messages');
    if (typeof input.targetAgentId !== 'string'
      || !getRoomAgents(db, roomId).some((agent) => agent.agentId === input.targetAgentId)) {
      fail(`targetAgentId "${input.targetAgentId}" is not an agent in this room`);
    }
  }

  // referencedMessageIds：只允许有 type 的消息提供；每个 id 为正整数且在本 room 内存在
  if (input.referencedMessageIds !== undefined) {
    if (type === undefined) fail('referencedMessageIds requires a typed message');
    if (!Array.isArray(input.referencedMessageIds)) fail('referencedMessageIds must be an array');
    for (const id of input.referencedMessageIds) {
      if (!isPositiveInteger(id)) fail('message IDs must be positive integers');
      if (!getMessageById(db, roomId, id)) fail(`referencedMessageIds contains ${id} which is not found in room ${roomId}`);
    }
  }

  // targetMessageId：按 type 决定是否允许/必填，并解析出目标 T
  const targetRequired = type === 'hypothesis' || type === 'chain' || type === 'exploring'
    || type === 'challenge' || type === 'verify';
  const targetAllowed = targetRequired || type === 'fact' || type === 'boundary';
  let target: Message | null = null;
  if (input.targetMessageId !== undefined) {
    if (!targetAllowed) fail(`targetMessageId is not allowed for ${type ? `type "${type}"` : 'untyped messages'}`);
    if (!isPositiveInteger(input.targetMessageId)) fail('message IDs must be positive integers');
    target = getMessageById(db, roomId, input.targetMessageId);
    if (!target) fail(`targetMessageId ${input.targetMessageId} not found in room ${roomId}`);
  } else if (targetRequired) {
    fail(`targetMessageId is required for type "${type}"`);
  }

  switch (type) {
    case 'hypothesis':
    case 'fact':
    case 'boundary':
      if (target && target.type !== 'open_question') fail(`${type} targetMessageId must refer to an open_question`);
      break;
    case 'chain':
      if (target!.type !== 'open_question') fail('chain targetMessageId must refer to an open_question');
      if (input.closesQuestion !== undefined && typeof input.closesQuestion !== 'boolean') {
        fail('closesQuestion must be a boolean');
      }
      if (input.closesQuestion === true) {
        if (!CLOSE_REASONS.includes(input.chainResolution as string)) {
          fail('chainResolution must be "RESOLVED" or "UNRESOLVED" when closesQuestion is true');
        }
      } else if (input.chainResolution !== undefined) {
        fail('chainResolution is only allowed when closesQuestion is true');
      }
      break;
    case 'exploring': {
      // exploring 表示 agent 占用研究方向，人类不发送（需求 3.5）。
      if (author.kind === 'human') fail('humans cannot post exploring messages');
      if (target!.type !== 'open_question' && target!.type !== 'hypothesis') {
        fail('exploring targetMessageId must refer to an open_question or hypothesis');
      }
      const active = getActiveExploringByAuthor(db, roomId, author.agentId);
      if (active) fail(`author already has an active exploring #${active.id}; complete it with complete_exploring first`);
      break;
    }
    case 'challenge': {
      const t = target!;
      const ok = t.type === 'fact' || t.type === 'boundary'
        || (t.type === 'chain' && (t.chainStatus === 'CANDIDATE' || t.chainStatus === 'VERIFIED' || t.chainStatus === 'REJECT'));
      if (!ok) {
        fail(`challenge target #${t.id} must be a fact, boundary, or a CANDIDATE/VERIFIED/REJECT chain (current: ${describe(t)})`);
      }
      break;
    }
    case 'verify': {
      const t = target!;
      const ok = t.type === 'hypothesis'
        || (t.type === 'chain' && (t.chainStatus === 'CANDIDATE' || t.chainStatus === 'CHALLENGED'));
      if (!ok) {
        fail(`verify target #${t.id} must be a hypothesis, or a CANDIDATE/CHALLENGED chain (current: ${describe(t)})`);
      }
      if (typeof input.verifyVerdict !== 'boolean') fail('verifyVerdict (boolean) is required for type "verify"');
      if (author.kind === 'agent' && t.sessionSeq === author.sessionSeq) {
        fail('cannot verify a message produced in the same session');
      }
      break;
    }
    default:
      break;
  }
}

function describe(m: Message): string {
  return m.type === 'chain' ? `chain ${m.chainStatus}` : m.type ?? 'untyped';
}

// 知识状态转换（见 03-orchestrator-core.md §1.3）：在写入事务内执行，返回被转换的消息 id。
function applyTransitions(db: Database.Database, roomId: number, m: Message): number[] {
  if ((m.type !== 'verify' && m.type !== 'challenge') || m.targetMessageId == null) return [];
  const t = getMessageById(db, roomId, m.targetMessageId)!;
  const question = t.targetMessageId == null ? null : getMessageById(db, roomId, t.targetMessageId);
  const questionId = question?.type === 'open_question' ? question.id : null;
  const changed: number[] = [];

  if (m.type === 'verify') {
    if (t.type === 'hypothesis') {
      setMessageType(db, roomId, t.id, m.verifyVerdict ? 'fact' : 'boundary', m.id);
      changed.push(t.id);
    } else if (t.type === 'chain') {
      setChainStatus(db, roomId, t.id, m.verifyVerdict ? 'VERIFIED' : 'REJECT', m.id);
      changed.push(t.id);
      // 只有 VERIFIED 的 closesQuestion chain 能关闭问题；问题已关闭时不重复关闭、不覆盖关闭原因。
      if (m.verifyVerdict && t.closesQuestion && t.chainResolution && questionId != null
        && question!.questionStatus === 'OPEN') {
        setQuestionStatus(db, roomId, questionId, { status: 'CLOSED', closeReason: t.chainResolution, closedBy: t.id }, m.id);
        changed.push(questionId);
      }
    }
    return changed;
  }

  if (t.type === 'fact' || t.type === 'boundary') {
    setMessageType(db, roomId, t.id, 'hypothesis', m.id);
    changed.push(t.id);
    // fact/boundary 回答的问题只要处于关闭状态就重开（需求 4.5）。
    if (questionId != null && question!.questionStatus === 'CLOSED') {
      setQuestionStatus(db, roomId, questionId, { status: 'OPEN' }, m.id);
      changed.push(questionId);
    }
  } else if (t.type === 'chain') {
    setChainStatus(db, roomId, t.id, 'CHALLENGED', m.id);
    changed.push(t.id);
    // chain 被 challenge 时只重开由它自己关闭的问题。
    if (questionId != null && question!.questionStatus === 'CLOSED' && question!.questionClosedBy === t.id) {
      setQuestionStatus(db, roomId, questionId, { status: 'OPEN' }, m.id);
      changed.push(questionId);
    }
  }
  return changed;
}

// 新消息在写入时刻是否触发型（见 03-orchestrator-core.md §1.1）：定向 session 的产出一律不是。
function isTriggerAtWrite(db: Database.Database, m: Message): boolean {
  const triggering = (m.type === 'open_question' && m.questionStatus === 'OPEN')
    || m.type === 'hypothesis'
    || (m.type === 'chain' && m.chainStatus === 'CANDIDATE')
    || m.type === 'challenge';
  if (!triggering) return false;
  if (m.sessionSeq == null) return true;
  return getSession(db, m.roomId, m.sessionSeq)?.dispatchScope !== 'directed';
}

// 置位待分发标记（03-orchestrator-core.md §1.2"置位"第 1 条）：定向消息只置位被 @ agent 的定向标记，
// 其余触发型消息置位房间标记并记下作者。返回是否置位了标记。
function markPending(db: Database.Database, m: Message): boolean {
  if (!isTriggerAtWrite(db, m)) return false;
  if (m.targetAgentId != null) setDirectedPending(db, m.roomId, m.targetAgentId, true);
  else setDispatchPending(db, m.roomId, true, m.authorId);
  return true;
}

// MCP post_message 与人类 postHumanMessage 共用的唯一写入入口（见 03-orchestrator-core.md §1.4）。
export function submitMessage(
  db: Database.Database,
  input: SubmitMessageInput,
  startSession: StartSession,
  stuckCounter: StuckCounter,
): { message: Message; changedMessageIds: number[] } {
  const { roomId, author } = input;
  const authorId = author.kind === 'human' ? 'human' : author.agentId;

  const { message, changedMessageIds, pendingMarked } = runInTransaction(db, () => {
    let type = input.type;
    // 首条消息规则：人类发的房间首条消息强制为 open_question（需求 3.1），且不能定向。
    if (author.kind === 'human' && countMessages(db, roomId) === 0) {
      if (input.targetAgentId !== undefined) fail('the first message of a room cannot target an agent');
      type = 'open_question';
    }
    validate(db, input, type);
    const inserted = insertMessage(db, {
      roomId,
      sessionSeq: author.kind === 'human' ? null : author.sessionSeq,
      authorId,
      content: input.content,
      type,
      targetMessageId: input.targetMessageId,
      targetAgentId: input.targetAgentId,
      referencedMessageIds: input.referencedMessageIds,
      verifyVerdict: input.verifyVerdict,
      closesQuestion: input.closesQuestion,
      chainResolution: input.chainResolution,
      summary: input.summary,
    });
    const changed = applyTransitions(db, roomId, inserted);
    return { message: inserted, changedMessageIds: changed, pendingMarked: markPending(db, inserted) };
  });

  roomEvents.emit('message', { roomId, message });
  for (const messageId of changedMessageIds) roomEvents.emit('memoryUpdate', { roomId, messageId });
  if (message.type === 'exploring') resetStuckCount(stuckCounter, roomId, authorId);
  if (pendingMarked) checkAndDispatch(db, roomId, startSession, stuckCounter);

  return { message, changedMessageIds };
}
