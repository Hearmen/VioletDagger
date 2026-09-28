import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { buildPromptText, renderMemory, writePromptFile } from '../../src/agent-invocation/prompt';
import type { OverviewPayload, MessageSummary, QuestionOverview, KnowledgeOverview } from '../../src/memory';
import { OVERVIEW_GUIDANCE } from '../../src/memory';

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

const summary = (id: number, type: MessageSummary['type'], text: string, extra: Partial<MessageSummary> = {}): MessageSummary => ({
  id, type, source: 'agent', summary: text, targetMessageId: null, referencedMessageIds: [],
  createdAt: '2026-01-01T00:00:00.000Z', ...extra,
});
const knowledge = (current: MessageSummary, extra: Partial<KnowledgeOverview> = {}): KnowledgeOverview => ({
  current, transitions: [], verifies: [], challenges: [], references: [], ...extra,
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
    expect(text).not.toContain('endorse');
  });

  it('is byte-identical for the same inputs (no dispatch-scope leakage)', () => {
    const a = buildPromptText({ roomId: 7, agentId: 'codex', goalContent: 'g', overview: baseOverview });
    const b = buildPromptText({ roomId: 7, agentId: 'codex', goalContent: 'g', overview: baseOverview });
    expect(a).toBe(b);
  });
});

describe('renderMemory', () => {
  it('renders the groups in the fixed order with "（无）" for empty ones', () => {
    const text = renderMemory(baseOverview);
    const titles = ['### 任务目标（goal）', '### 其他问题', '### 未挂在问题下的知识', '### 正在探索的方向', '### 已结束探索', '### 完成提议', '### 最近消息'];
    const positions = titles.map((title) => text.indexOf(title));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(text).toContain('### 其他问题\n（无）');
    expect(text).toContain('- [#1] 问题 [OPEN]：build the thing\n  - （尚无回答）');
  });

  it('renders answers under a question with transitions and reactions', () => {
    const overview: OverviewPayload = {
      ...baseOverview,
      goal: question(1, 'build the thing', {
        status: 'CLOSED', closeReason: 'RESOLVED',
        facts: [knowledge(summary(3, 'fact', 'db uses sqlite', { referencedMessageIds: [9] }), {
          transitions: [{ fromType: 'hypothesis', toType: 'fact', fromStatus: null, toStatus: null, triggerMessageId: 4, createdAt: 'x', reason: null }],
          verifies: [summary(4, 'verify', 'checked schema')],
        })],
        chains: [{
          current: summary(5, 'chain', 'full plan'), status: 'VERIFIED', closesQuestion: true, chainResolution: 'RESOLVED',
          evidence: [], verifies: [], challenges: [summary(6, 'challenge', 'edge case')],
          transitions: [{ fromType: null, toType: null, fromStatus: 'CANDIDATE', toStatus: 'VERIFIED', triggerMessageId: 7, createdAt: 'x', reason: null }],
        }],
      }),
    };
    const text = renderMemory(overview);
    expect(text).toContain([
      '- [#1] 问题 [CLOSED/RESOLVED]：build the thing',
      '  - 事实：',
      '    - [#3] fact：db uses sqlite 依据：#9',
      '      - 转换：hypothesis→fact（#4）',
      '      - verify [#4]：checked schema',
      '  - 候选链路：',
      '    - [#5] chain [VERIFIED] 关闭意图：RESOLVED：full plan',
      '      - 转换：CANDIDATE→VERIFIED（#7）',
      '      - challenge [#6]：edge case',
    ].join('\n'));
    expect(text).not.toContain('  - 假设：');
  });

  it('renders exploring occupancy and completed results', () => {
    const overview: OverviewPayload = {
      ...baseOverview,
      completedExploring: [{
        message: summary(8, 'exploring', 'tried X'), agentId: 'codex', status: 'completed',
        target: summary(1, 'open_question', 'q'), resultSummary: 'no conclusion', resultMessages: [summary(3, 'fact', 'f')],
      }],
    };
    const text = renderMemory(overview);
    expect(text).toContain('- [#2] 占用：claude → #1：looking at schema');
    expect(text).toContain('- [#8] 占用：codex → #1：tried X\n  结束：no conclusion；结果引用：#3');
  });

  it('marks human-sourced plain entries and labels untyped ones as chat', () => {
    const overview: OverviewPayload = {
      ...baseOverview,
      recentRawMessages: [summary(10, null, 'hello', { source: 'human' }), summary(11, null, 'hi')],
    };
    const text = renderMemory(overview);
    expect(text).toContain('- [#10] 聊天（人类）：hello\n- [#11] 聊天：hi');
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
