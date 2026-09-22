import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { buildPromptText, writePromptFile } from '../../src/agent-invocation/prompt';
import type { OverviewPayload, MemorySummary } from '../../src/memory';

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

const summary = (id: number, type: MemorySummary['type'], text: string): MemorySummary => ({
  id, type, summary: text, targetMessageId: null, targetAgentId: null, referencedMessageIds: [], exploringStatus: null,
  exploringNote: null, exploringEndReason: null, exploringResultSummary: null, exploringResultMessageIds: [],
});
const baseOverview: OverviewPayload = {
  goal: 'build the thing',
  facts: [summary(1, 'fact', 'db uses sqlite')],
  boundaries: [],
  openQuestions: [],
  chains: [],
  hypotheses: [],
  activeExploring: [{ ...summary(2, 'exploring', 'looking at schema'), agentId: 'claude', exploringStatus: 'active' }],
  completedExploring: [], completionProposals: [], reactions: [], contextMessages: [], relations: {},
  recentRawMessages: [
    {
      id: 1, roomId: 1, sessionSeq: null, authorId: 'human', type: null,
      content: 'build the thing', summary: 'build the thing', targetMessageId: null, targetAgentId: null,
      referencedMessageIds: [], exploringStatus: null, exploringNote: null,
      exploringEndReason: null, exploringResultSummary: null, exploringResultMessageIds: [],
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  guidance: '以上是当前任务的进展情况，仅供参考，请形成你自己的判断——可以采纳、组合、推翻，也可以提出全新方案。',
};

describe('buildPromptText', () => {
  it('includes roomId, agentId, goal, and the fixed guidance text', () => {
    const text = buildPromptText({ roomId: 7, agentId: 'codex', overview: baseOverview });
    expect(text).toContain('roomId: 7');
    expect(text).toContain('authorId: codex');
    expect(text).toContain('任务目标：build the thing');
    expect(text).toContain('以上是当前任务的进展情况');
  });

  it('renders fact summaries with their message id', () => {
    const text = buildPromptText({ roomId: 7, agentId: 'codex', overview: baseOverview });
    expect(text).toContain('[#1] fact：db uses sqlite');
  });

  it('renders active exploring entries grouped by agentId', () => {
    const text = buildPromptText({ roomId: 7, agentId: 'codex', overview: baseOverview });
    expect(text).toContain('占用：claude：looking at schema');
  });

  it('renders "（无）" for empty sections', () => {
    const text = buildPromptText({ roomId: 7, agentId: 'codex', overview: baseOverview });
    expect(text).toMatch(/死胡同：\n（无）/);
  });

  // @ 定向消息（需求 3.3.2）：对 agent 来说定向和广播派发的 prompt 完全一样，只有消息本身的
  // @agentId 标注（数据，不是"这次是定向 session"的元提示）会出现在 renderMemory 里。
  it('renders a targetAgentId annotation on memory entries', () => {
    const overview: OverviewPayload = {
      ...baseOverview,
      facts: [{ ...summary(3, 'fact', 'targeted fact'), targetAgentId: 'claude' }],
    };
    const text = buildPromptText({ roomId: 7, agentId: 'codex', overview });
    expect(text).toContain('[#3] fact @claude：targeted fact');
  });
});

describe('writePromptFile', () => {
  beforeEach(() => {
    vi.mocked(writeFile).mockClear();
  });

  it('writes the content to the given path and returns it', async () => {
    const result = await writePromptFile('hello prompt', '/tmp/violetdagger-1-1.prompt.txt');
    expect(writeFile).toHaveBeenCalledWith('/tmp/violetdagger-1-1.prompt.txt', 'hello prompt', 'utf-8');
    expect(result).toBe('/tmp/violetdagger-1-1.prompt.txt');
  });
});
