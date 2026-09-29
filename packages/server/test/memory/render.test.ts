import { describe, it, expect } from 'vitest';
import { renderMemory, renderOverviewText, OVERVIEW_GUIDANCE } from '../../src/memory';
import type { OverviewPayload, MessageSummary, QuestionOverview, KnowledgeOverview } from '../../src/memory';

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

describe('renderMemory', () => {
  it('renders the groups in the fixed order with "（无）" for empty ones', () => {
    const text = renderMemory(baseOverview);
    const titles = ['### 任务目标（goal）', '### 其他问题', '### 未挂在问题下的知识', '### 正在探索的方向', '### 已结束探索', '### 完成提议', '### 最近消息'];
    const positions = titles.map((title) => text.indexOf(title));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(text).toContain('### 其他问题\n（无）');
    expect(text).toContain('- [#1] goal [OPEN]：（全文见上方"任务目标"）\n  - （尚无回答）');
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
      '- [#1] goal [CLOSED/RESOLVED]：（全文见上方"任务目标"）',
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

  it('renders the summary on non-goal question root lines', () => {
    const overview: OverviewPayload = { ...baseOverview, questions: [question(12, 'sub problem')] };
    const text = renderMemory(overview);
    expect(text).toContain('### 其他问题\n- [#12] 问题 [OPEN]：sub problem\n  - （尚无回答）');
    expect(text).not.toContain('goal [OPEN]：build the thing');
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

describe('renderMemory closed-question folding', () => {
  const chain = (id: number, status: 'CANDIDATE' | 'VERIFIED' | 'CHALLENGED' | 'REJECT', closesQuestion: boolean) => ({
    current: summary(id, 'chain', `chain ${id}`, { targetMessageId: 10, referencedMessageIds: [12] }),
    status, closesQuestion, chainResolution: closesQuestion ? 'RESOLVED' as const : null,
    evidence: [], verifies: [summary(id + 100, 'verify', `verify of ${id}`)], challenges: [],
    transitions: [{ fromType: null, toType: null, fromStatus: 'CANDIDATE', toStatus: status, triggerMessageId: id + 100, createdAt: 'x', reason: null }],
  });
  const exploring = (id: number, target: MessageSummary, status: 'active' | 'completed') => ({
    message: summary(id, 'exploring', `explore ${id}`), agentId: 'codex', status,
    target, resultSummary: status === 'completed' ? `result ${id}` : null, resultMessages: [],
  });
  const closedSub = question(10, 'sub problem', {
    status: 'CLOSED', closeReason: 'RESOLVED',
    hypotheses: [knowledge(summary(11, 'hypothesis', 'open claim', { targetMessageId: 10 }))],
    facts: [knowledge(summary(12, 'fact', 'env fact', { targetMessageId: 10, referencedMessageIds: [3] }), {
      verifies: [summary(13, 'verify', 'checked')],
    })],
    boundaries: [knowledge(summary(14, 'boundary', 'dead end', { targetMessageId: 10 }))],
    chains: [chain(15, 'REJECT', true), chain(16, 'VERIFIED', true)],
  });
  const overview: OverviewPayload = {
    ...baseOverview,
    questions: [closedSub, question(20, 'still open')],
    activeExploring: [
      exploring(30, summary(10, 'open_question', 'sub problem'), 'active'),
      exploring(31, summary(20, 'open_question', 'still open'), 'active'),
    ],
    completedExploring: [
      exploring(32, summary(12, 'fact', 'env fact', { targetMessageId: 10 }), 'completed'),
      exploring(33, summary(1, 'open_question', 'build the thing'), 'completed'),
    ],
  };

  it('renders a closed sub-question as its closing chain plus one-line facts and boundaries', () => {
    const text = renderMemory(overview);
    expect(text).toContain([
      '- [#10] 问题 [CLOSED/RESOLVED]：sub problem',
      '  - 收尾链路：',
      '    - [#16] chain [VERIFIED] 关闭意图：RESOLVED：chain 16 依据：#12',
      '      - 转换：CANDIDATE→VERIFIED（#116）',
      '      - verify [#116]：verify of 16',
      '  - 事实：',
      '    - [#12] fact：env fact',
      '  - 死胡同：',
      '    - [#14] boundary：dead end',
      '  - 已折叠：2 条回答、2 条 exploring，需要时用 get_detail 查看',
      '- [#20] 问题 [OPEN]：still open',
    ].join('\n'));
    expect(text).not.toContain('open claim');
    expect(text).not.toContain('chain 15');
    expect(text).not.toContain('checked');
  });

  it('removes exploring related to the closed question from both exploring groups', () => {
    const text = renderMemory(overview);
    expect(text).not.toContain('explore 30');
    expect(text).not.toContain('explore 32');
    expect(text).toContain('### 正在探索的方向\n- [#31] 占用：codex → #20：explore 31');
    expect(text).toContain('### 已结束探索\n- [#33] 占用：codex → #1：explore 33');
  });

  it('omits zero counts and the whole folded line when nothing is folded', () => {
    const onlyClosing = question(10, 'sub problem', { status: 'CLOSED', closeReason: 'RESOLVED', chains: [chain(16, 'VERIFIED', true)] });
    const text = renderMemory({ ...baseOverview, questions: [onlyClosing] });
    expect(text).not.toContain('已折叠');
    const withExploring = renderMemory({
      ...baseOverview, questions: [onlyClosing],
      completedExploring: [exploring(32, summary(10, 'open_question', 'sub problem'), 'completed')],
    });
    expect(withExploring).toContain('  - 已折叠：1 条 exploring，需要时用 get_detail 查看');
  });

  it('renders a reopened question and its exploring in full again', () => {
    const reopened = { ...closedSub, status: 'OPEN' as const, closeReason: null };
    const text = renderMemory({ ...overview, questions: [reopened] });
    expect(text).toContain('  - 假设：\n    - [#11] hypothesis：open claim');
    expect(text).toContain('chain 15');
    expect(text).toContain('explore 30');
    expect(text).toContain('explore 32');
    expect(text).not.toContain('已折叠');
  });

  it('never folds the goal even when it is closed', () => {
    const goal = { ...closedSub, question: summary(1, 'open_question', 'build the thing') };
    const text = renderMemory({ ...baseOverview, goal });
    expect(text).toContain('open claim');
    expect(text).not.toContain('已折叠');
  });
});

describe('renderOverviewText', () => {
  it('prefixes the full goal and appends the guidance around the rendered memory', () => {
    const text = renderOverviewText('build the thing, in full detail', baseOverview);
    expect(text.startsWith('任务目标：\nbuild the thing, in full detail\n\n')).toBe(true);
    expect(text).toContain(renderMemory(baseOverview));
    expect(text.endsWith(`\n\n${OVERVIEW_GUIDANCE}`)).toBe(true);
  });
});
