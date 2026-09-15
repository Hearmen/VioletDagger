import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { buildPromptText, writePromptFile } from '../../src/agent-invocation/prompt';
import type { OverviewPayload } from '../../src/memory';

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

const baseOverview: OverviewPayload = {
  goal: 'build the thing',
  facts: [{ id: 1, summary: 'db uses sqlite' }],
  boundaries: [],
  openQuestions: [],
  chains: [],
  hypotheses: [],
  activeExploring: [{ agentId: 'claude', summary: 'looking at schema' }],
  recentRawMessages: [
    {
      id: 1, roomId: 1, sessionSeq: null, authorId: 'human', type: null,
      content: 'build the thing', summary: 'build the thing', targetMessageId: null,
      referencedMessageIds: [], exploringStatus: null, exploringNote: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  guidance: '以上是聊天室的既有记忆，仅供参考，请形成你自己的判断——可以采纳、组合、推翻，也可以提出全新方案。',
};

describe('buildPromptText', () => {
  it('includes roomId, agentId, goal, and the fixed guidance text', () => {
    const text = buildPromptText({ roomId: 7, agentId: 'codex', overview: baseOverview });
    expect(text).toContain('roomId: 7');
    expect(text).toContain('authorId: codex');
    expect(text).toContain('任务目标：build the thing');
    expect(text).toContain('以上是聊天室的既有记忆');
  });

  it('renders fact summaries with their message id', () => {
    const text = buildPromptText({ roomId: 7, agentId: 'codex', overview: baseOverview });
    expect(text).toContain('[#1] db uses sqlite');
  });

  it('renders active exploring entries grouped by agentId', () => {
    const text = buildPromptText({ roomId: 7, agentId: 'codex', overview: baseOverview });
    expect(text).toContain('claude: looking at schema');
  });

  it('renders "（无）" for empty sections', () => {
    const text = buildPromptText({ roomId: 7, agentId: 'codex', overview: baseOverview });
    expect(text).toMatch(/死胡同：\n（无）/);
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
