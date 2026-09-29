import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { buildPromptText, writePromptFile } from '../../src/agent-invocation/prompt';
import type { OverviewPayload, MessageSummary, QuestionOverview } from '../../src/memory';
import { OVERVIEW_GUIDANCE, renderOverviewText } from '../../src/memory';

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

const summary = (id: number, type: MessageSummary['type'], text: string, extra: Partial<MessageSummary> = {}): MessageSummary => ({
  id, type, source: 'agent', summary: text, targetMessageId: null, referencedMessageIds: [],
  createdAt: '2026-01-01T00:00:00.000Z', ...extra,
});
const question = (id: number, text: string, extra: Partial<QuestionOverview> = {}): QuestionOverview => ({
  question: summary(id, 'open_question', text, { source: 'human' }),
  status: 'OPEN', closeReason: null, hypotheses: [], facts: [], boundaries: [], chains: [], ...extra,
});

const baseOverview: OverviewPayload = {
  goal: question(1, 'build the thing'),
  questions: [],
  unattachedKnowledge: [],
  activeExploring: [{
    message: summary(2, 'exploring', 'looking at schema'), agentId: 'claude', status: 'active',
    target: summary(1, 'open_question', 'build the thing'), resultSummary: null, resultMessages: [],
  }],
  completedExploring: [],
  completionProposals: [],
  recentRawMessages: [summary(1, 'open_question', 'build the thing', { source: 'human' })],
  guidance: OVERVIEW_GUIDANCE,
};

describe('buildPromptText', () => {
  it('includes roomId, agentId, the full goal content, and the fixed guidance text', () => {
    const text = buildPromptText({ roomId: 7, agentId: 'codex', goalContent: 'build the thing, in full detail', overview: baseOverview });
    expect(text).toContain('roomId：7');
    expect(text).toContain('你的 authorId：codex');
    expect(text).toContain('任务目标：\nbuild the thing, in full detail\n');
    expect(text).toContain(OVERVIEW_GUIDANCE);
    expect(text).toContain(`## 记忆面板\n\n${renderOverviewText('build the thing, in full detail', baseOverview)}\n\n## 下一步`);
    expect(text).not.toContain('endorse');
  });

  it('is byte-identical for the same inputs (no dispatch-scope leakage)', () => {
    const a = buildPromptText({ roomId: 7, agentId: 'codex', goalContent: 'g', overview: baseOverview });
    const b = buildPromptText({ roomId: 7, agentId: 'codex', goalContent: 'g', overview: baseOverview });
    expect(a).toBe(b);
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
