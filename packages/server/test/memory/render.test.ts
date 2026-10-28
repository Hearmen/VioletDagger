import { describe, it, expect } from 'vitest';
import { renderMemory, renderOverviewText, OVERVIEW_GUIDANCE, MEMORY_HINT } from '../../src/memory';
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

  it('starts with the get_detail hint', () => {
    expect(renderMemory(baseOverview).startsWith(`${MEMORY_HINT}\n\n### 任务目标（goal）`)).toBe(true);
  });

  it('flattens newlines in summaries and clips long exploring result summaries', () => {
    const overview: OverviewPayload = {
      ...baseOverview,
      recentRawMessages: [summary(10, 'verify', 'first line\n\n  ① second line')],
      completedExploring: [{
        message: summary(8, 'exploring', 'tried\nX'), agentId: 'codex', status: 'completed',
        target: summary(1, 'open_question', 'q'), resultSummary: `${'结'.repeat(80)}\n多出来的部分`, resultMessages: [],
      }],
    };
    const text = renderMemory(overview);
    expect(text).toContain('- [#10] verify：first line ① second line');
    expect(text).toContain(`- [#8] 占用：codex → #1：tried X\n  结束：${'结'.repeat(80)}…；结果引用：（无）`);
  });

  it('keeps a short exploring result summary as is', () => {
    const overview: OverviewPayload = {
      ...baseOverview,
      completedExploring: [{
        message: summary(8, 'exploring', 'x'), agentId: 'codex', status: 'completed',
        target: summary(1, 'open_question', 'q'), resultSummary: '结'.repeat(80), resultMessages: [],
      }],
    };
    expect(renderMemory(overview)).toContain(`结束：${'结'.repeat(80)}；`);
  });

  it('omits a chain transition line implied by its status and a listed verify', () => {
    const transition = (from: 'CANDIDATE' | 'VERIFIED' | 'CHALLENGED', to: 'VERIFIED' | 'CHALLENGED', trigger: number) => ({
      fromType: null, toType: null, fromStatus: from, toStatus: to, triggerMessageId: trigger, createdAt: 'x', reason: null,
    });
    const chainOf = (id: number, transitions: ReturnType<typeof transition>[], verifies: MessageSummary[]) => ({
      current: summary(id, 'chain', `plan ${id}`), status: 'VERIFIED' as const, closesQuestion: false, chainResolution: null,
      evidence: [], verifies, challenges: [], transitions,
    });
    const overview: OverviewPayload = {
      ...baseOverview,
      goal: question(1, 'build the thing', {
        chains: [
          chainOf(5, [transition('CANDIDATE', 'VERIFIED', 6)], [summary(6, 'verify', 'ok')]),
          chainOf(7, [transition('CANDIDATE', 'VERIFIED', 8)], []),
          chainOf(9, [transition('CANDIDATE', 'VERIFIED', 10), transition('VERIFIED', 'CHALLENGED', 11), transition('CHALLENGED', 'VERIFIED', 12)],
            [summary(10, 'verify', 'ok'), summary(12, 'verify', 'ok again')]),
        ],
      }),
    };
    const text = renderMemory(overview);
    expect(text).toContain('    - [#5] chain [VERIFIED]：plan 5\n      - verify [#6]：ok');
    expect(text).toContain('    - [#7] chain [VERIFIED]：plan 7\n      - 转换：CANDIDATE→VERIFIED（#8）');
    expect(text).toContain('      - 转换：CANDIDATE→VERIFIED（#10） VERIFIED→CHALLENGED（#11） CHALLENGED→VERIFIED（#12）');
  });

  it('skips recent messages already rendered as entries, but not ones only referenced', () => {
    const overview: OverviewPayload = {
      ...baseOverview,
      goal: question(1, 'build the thing', {
        facts: [knowledge(summary(3, 'fact', 'a fact', { referencedMessageIds: [9] }), { verifies: [summary(4, 'verify', 'checked')] })],
      }),
      recentRawMessages: [
        summary(2, 'exploring', 'looking at schema'),
        summary(3, 'fact', 'a fact'),
        summary(4, 'verify', 'checked'),
        summary(9, null, 'only referenced'),
      ],
    };
    const text = renderMemory(overview);
    expect(text).toContain('### 最近消息\n- [#9] 聊天：only referenced');
    expect(text.match(/\[#4\]/g)).toHaveLength(1);
  });

  it('shows "（无）" when every recent message was already rendered', () => {
    expect(renderMemory(baseOverview)).toContain('### 最近消息\n（无）');
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

  it('renders a closed sub-question as one root line with its closing chain, plus one-line facts and boundaries', () => {
    const text = renderMemory(overview);
    expect(text).toContain([
      '- [#10] 问题 [CLOSED/RESOLVED]：sub problem → 收尾 #16：chain 16',
      '  - 事实：',
      '    - [#12] fact：env fact',
      '  - 死胡同：',
      '    - [#14] boundary：dead end',
      '- [#20] 问题 [OPEN]：still open',
    ].join('\n'));
    expect(text).not.toContain('open claim');
    expect(text).not.toContain('chain 15');
    expect(text).not.toContain('verify of 16');
    expect(text).not.toContain('checked');
    expect(text).not.toContain('已折叠');
  });

  it('removes exploring related to the closed question from both exploring groups', () => {
    const text = renderMemory(overview);
    expect(text).not.toContain('explore 30');
    expect(text).not.toContain('explore 32');
    expect(text).toContain('### 正在探索的方向\n- [#31] 占用：codex → #20：explore 31');
    expect(text).toContain('### 已结束探索\n- [#33] 占用：codex → #1：explore 33');
  });

  it('lists several closing chains in id order and omits the segment when there is none', () => {
    const several = question(10, 'sub problem', {
      status: 'CLOSED', closeReason: 'RESOLVED', chains: [chain(16, 'VERIFIED', true), chain(17, 'VERIFIED', true), chain(18, 'VERIFIED', false)],
    });
    expect(renderMemory({ ...baseOverview, questions: [several] }))
      .toContain('- [#10] 问题 [CLOSED/RESOLVED]：sub problem → 收尾 #16：chain 16 → 收尾 #17：chain 17\n');
    const none = question(10, 'sub problem', { status: 'CLOSED', closeReason: 'UNRESOLVED' });
    expect(renderMemory({ ...baseOverview, questions: [none] })).toContain('- [#10] 问题 [CLOSED/UNRESOLVED]：sub problem\n\n### 未挂在问题下的知识');
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
