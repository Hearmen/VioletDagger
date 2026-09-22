import type Database from 'better-sqlite3';
import {
  getRoom, getRoomAgents, setRoomStatus, recordCompletion, setAgentState, countSessions, createSession,
  getActiveExploring, getLatestDispatchTriggerAt, getLatestSessionStartedAt, getLatestMessageByTypes,
  getLatestDirectedMessage,
} from '../storage';
import type { DispatchScope, MessageType } from '../storage/types';
import { roomEvents } from '../events';
import type { StuckCounter } from './stuckCounter';

export type StartSession = (params: {
  roomId: number;
  seq: number;
  agentId: string;
  registryKey: string;
}) => void | Promise<void>;

// 触发派发的 agent 消息类型（人类消息一律触发，见 03 §1.2）。exploring/propose_completion/endorse/verify 只是
// 状态广播、信号或纯注解，不把其他 agent 拉起——否则它们会互相刷出永不停止的调度。
export const DISPATCH_TRIGGER_TYPES: MessageType[] = [
  'fact', 'hypothesis', 'boundary', 'open_question', 'chain', 'challenge',
];

// 一个 agent 的完整派发决策：是否"待派发"，以及若待派发，这次该按广播还是定向处理（见需求 3.3.2、03 §1.2）。
// 广播条件（原有规则，getLatestDispatchTriggerAt 已排除定向给别人/定向 session 产出的消息）与定向条件
// （存在一条 target_agent_id 等于自己的消息，只可能是人类发的）分别算出最新触发时间，取较晚者与该 agent
// 上次 session 的开始时间比较（严格晚于才算，从没跑过视为满足，同一毫秒视为已消费）；两者都满足时优先
// 按定向处理——人类明确 @ 了这个 agent，这次 session 就按"单独处理"对待，即使广播触发同时在排队。
// scope 只是落盘给调度层自己用（决定这次 session 的产出要不要参与其他 agent 的派发判定），
// 对被派发的 agent 完全不可见——它拿到的 prompt 跟广播派发时逐字节一致，见需求 3.3.2。
function resolveDispatchDecision(
  db: Database.Database,
  roomId: number,
  agentId: string,
): { owed: boolean; scope: DispatchScope } {
  const broadcastAt = getLatestDispatchTriggerAt(db, roomId, agentId, DISPATCH_TRIGGER_TYPES);
  const directedAt = getLatestDirectedMessage(db, roomId, agentId)?.createdAt ?? null;
  const lastStart = getLatestSessionStartedAt(db, roomId, agentId);
  const isNewer = (at: string | null) => at != null && (lastStart == null || at > lastStart);
  const directedOwed = isNewer(directedAt);
  return { owed: directedOwed || isNewer(broadcastAt), scope: directedOwed ? 'directed' : 'broadcast' };
}

// 一个空闲 agent 是否”待派发”：广播条件或定向条件任一满足即可（见 resolveDispatchDecision）。
// 导出给 orchestrator-api 的 getRoomStatus 复用同一份判定，算”派发收敛提示”的 caughtUp（06 §4），不重新实现一遍。
export function isDispatchOwed(db: Database.Database, roomId: number, agentId: string): boolean {
  return resolveDispatchDecision(db, roomId, agentId).owed;
}

export function checkAndDispatch(
  db: Database.Database,
  roomId: number,
  startSession: StartSession,
  stuckCounter: StuckCounter,
): void {
  const room = getRoom(db, roomId);
  if (!room || room.status !== 'active') return;

  if (countSessions(db, roomId) >= room.maxSessions) {
    setRoomStatus(db, roomId, 'paused_limit');
    roomEvents.emit('roomStatus', { roomId });
    return;
  }

  const activeExploringAgentIds = new Set(getActiveExploring(db, roomId).map((m) => m.authorId));
  const agents = getRoomAgents(db, roomId);
  let dispatchTarget: (typeof agents)[number] | null = null;
  let dispatchScope: DispatchScope = 'broadcast';

  for (const agent of agents) {
    // 被停用派发的 agent（连续失败自动停用或人类手动停用，见 03 §6）直接跳过。
    if (!agent.dispatchEnabled) continue;
    if (agent.state === 'running' || agent.state === 'stopping') {
      if (activeExploringAgentIds.has(agent.agentId)) {
        stuckCounter.increment(roomId, agent.agentId);
      }
      continue;
    }
    // 空闲但不“待派发”（没有晚于它上次 session 的触发型消息）就跳过——否则 session 结束会无条件重新拉起，
    // 出现任务完成后仍一遍遍空转。跳过而不是停下：不能让一个没有新信息的空闲 agent 挡住后面待派发的 agent。
    const decision = resolveDispatchDecision(db, roomId, agent.agentId);
    if (!decision.owed) continue;
    dispatchTarget = agent;
    dispatchScope = decision.scope;
    break;
  }

  if (!dispatchTarget) {
    // 静默收敛自动确认（03-orchestrator-core.md §1.4）：只有建房时开启了 autoConfirmOnSilence 的房间才走这条分支，
    // 且必须没有 running/stopping 的 agent（还有会话在跑，可能还会产出新内容，不能在这时候下收尾结论）。
    if (room.autoConfirmOnSilence && !agents.some((agent) => agent.state === 'running' || agent.state === 'stopping')) {
      const latest = getLatestMessageByTypes(db, roomId, [...DISPATCH_TRIGGER_TYPES, 'propose_completion']);
      if (latest?.type === 'propose_completion') {
        recordCompletion(db, roomId, 'auto_silence', latest.id);
      }
    }
    roomEvents.emit('roomStatus', { roomId });
    return;
  }

  const session = createSession(db, roomId, dispatchTarget.agentId, dispatchScope);
  setAgentState(db, roomId, dispatchTarget.agentId, 'running', session.seq);
  // checkAndDispatch 会被进程退出等事件回调直接调用；startSession 即使同步抛错也不能让它冒泡成
  // 未捕获异常打挂 server（见 03-orchestrator-core.md §1.2 第 5 步），这里统一降级为日志。
  try {
    const result = startSession({
      roomId,
      seq: session.seq,
      agentId: dispatchTarget.agentId,
      registryKey: dispatchTarget.registryKey,
    });
    if (result && typeof (result as Promise<void>).then === 'function') {
      (result as Promise<void>).catch((err) => {
        console.error(`startSession failed for room ${roomId}, agent ${dispatchTarget.agentId}:`, err);
      });
    }
  } catch (err) {
    console.error(`startSession threw for room ${roomId}, agent ${dispatchTarget.agentId}:`, err);
  }
  roomEvents.emit('roomStatus', { roomId });
}

export function onSubstantiveMessagePosted(
  db: Database.Database,
  roomId: number,
  startSession: StartSession,
  stuckCounter: StuckCounter,
): void {
  checkAndDispatch(db, roomId, startSession, stuckCounter);
}
