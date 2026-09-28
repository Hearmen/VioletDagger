import type Database from 'better-sqlite3';
import type { CloseReason, Message, MessageType } from '../storage';
import { SubmitMessageError, type SubmitMessageInput } from '../orchestrator-core/submitMessage';
import { assertRoomExists, assertNotReservedAuthor, resolveSessionBinding, McpToolError } from './validation';

// 工具参数不包含 targetAgentId：定向是人类专属能力（需求 3.3.2）。
export interface PostMessageParams {
  roomId: number;
  authorId: string;
  content: string;
  type?: MessageType;
  targetMessageId?: number;
  referencedMessageIds?: number[];
  verifyVerdict?: boolean;
  closesQuestion?: boolean;
  chainResolution?: CloseReason;
  summary?: string;
}

export interface PostMessageDeps {
  db: Database.Database;
  submitMessage: (input: SubmitMessageInput) => { message: Message; changedMessageIds: number[] };
}

// 字段与状态校验、插入、知识状态转换、事件推送、stuck 清零、派发检查全部在核心 submitMessage 完成
// （见 05-mcp-server.md §4、03-orchestrator-core.md §1.4），本工具只做身份绑定与错误转换。
export function createPostMessageHandler(deps: PostMessageDeps) {
  const { db, submitMessage } = deps;

  return function postMessage(params: PostMessageParams): { messageId: number } {
    assertRoomExists(db, params.roomId);
    assertNotReservedAuthor(params.authorId);
    const sessionSeq = resolveSessionBinding(db, params.roomId, params.authorId);

    try {
      const { message } = submitMessage({
        roomId: params.roomId,
        author: { kind: 'agent', agentId: params.authorId, sessionSeq },
        content: params.content,
        type: params.type,
        targetMessageId: params.targetMessageId,
        referencedMessageIds: params.referencedMessageIds,
        verifyVerdict: params.verifyVerdict,
        closesQuestion: params.closesQuestion,
        chainResolution: params.chainResolution,
        summary: params.summary,
      });
      return { messageId: message.id };
    } catch (err) {
      if (err instanceof SubmitMessageError) throw new McpToolError(err.message);
      throw err;
    }
  };
}
