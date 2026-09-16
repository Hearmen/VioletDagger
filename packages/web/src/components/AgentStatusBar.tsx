import { useEffect, useState } from 'react';
import type { RoomStatusPayload } from '../api/types';

export function AgentStatusBar(props: {
  agents: RoomStatusPayload['agents'];
  onTerminate: (sessionId: number) => void;
  readOnly: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div>
      {props.agents.map((agent) => (
        <div key={agent.agentId} data-testid={`agent-${agent.agentId}`}>
          <span>{agent.agentId}</span>
          <span>{agent.state}</span>
          {agent.state === 'running' && agent.sessionStartedAt && (
            <span>已运行 {Math.max(0, Math.floor((now - new Date(agent.sessionStartedAt).getTime()) / 1000))}s</span>
          )}
          {!props.readOnly && agent.state === 'running' && agent.sessionId != null && (
            <button onClick={() => props.onTerminate(agent.sessionId!)}>Terminate</button>
          )}
          {agent.stuck && <span title="这个 agent 可能卡住了，要不要看看">⚠️</span>}
        </div>
      ))}
    </div>
  );
}
