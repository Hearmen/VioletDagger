import { describe, it, expect } from 'vitest';
import {
  escapeHtml, formatDuration, formatMemory, formatTime, messageLabel, messageLine, splitMessage,
} from '../src/format';
import type { MemoryViewPayload, Message } from '../src/types';

function msg(overrides: Partial<Message>): Message {
  return {
    id: 1, roomId: 1, sessionSeq: null, authorId: 'human', type: null, content: 'c', summary: '',
    targetMessageId: null, targetAgentId: null, referencedMessageIds: [], questionStatus: null,
    questionCloseReason: null, chainStatus: null, closesQuestion: false, chainResolution: null,
    verifyVerdict: null, exploringStatus: null, createdAt: '2026-10-30T10:00:00.000Z',
    ...overrides,
  };
}

describe('splitMessage', () => {
  it('returns short text unchanged', () => {
    expect(splitMessage('a\nb')).toEqual(['a\nb']);
  });

  it('splits on line boundaries within the limit', () => {
    const chunks = splitMessage(['aaaa', 'bbbb', 'cccc'].join('\n'), 20);
    expect(chunks.every((c) => c.length <= 20)).toBe(true);
    expect(chunks.join('\n')).toBe('aaaa\nbbbb\ncccc');
  });

  it('closes and reopens <pre> across chunks', () => {
    const html = ['<pre>line-1', 'line-2', 'line-3', 'line-4</pre>'].join('\n');
    const chunks = splitMessage(html, 30);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(30);
      expect(c.split('<pre>').length).toBe(c.split('</pre>').length);
    }
  });

  it('hard-cuts an overlong line without splitting an entity', () => {
    const line = `${'x'.repeat(16)}&amp;${'y'.repeat(20)}`;
    const chunks = splitMessage(line, 31);
    expect(chunks.join('')).toBe(line);
    expect(chunks.some((c) => /&[a-z]*$/.test(c))).toBe(false);
  });
});

describe('labels', () => {
  it('renders the §7.3 labels', () => {
    expect(messageLabel(msg({ type: null }), null)).toBeNull();
    expect(messageLabel(msg({ id: 1, type: 'open_question', questionStatus: 'OPEN' }), 1)).toBe('open_question/OPEN 目标');
    expect(messageLabel(msg({ type: 'open_question', questionStatus: 'CLOSED', questionCloseReason: 'RESOLVED' }), null))
      .toBe('open_question/CLOSED·RESOLVED');
    expect(messageLabel(msg({ type: 'chain', chainStatus: 'VERIFIED', closesQuestion: true, chainResolution: 'UNRESOLVED' }), null))
      .toBe('chain/VERIFIED·closes→UNRESOLVED');
    expect(messageLabel(msg({ type: 'exploring', exploringStatus: 'active' }), null)).toBe('exploring/active');
    expect(messageLabel(msg({ type: 'verify', verifyVerdict: false }), null)).toBe('verify/不通过');
    expect(messageLabel(msg({ type: 'fact' }), null)).toBe('fact');
  });

  it('escapes and flattens the summary line', () => {
    const line = messageLine(msg({ id: 7, authorId: 'system', content: 'a <b>\nb' }), null);
    expect(line).toBe('<b>#7</b> 系统 a &lt;b&gt; b');
  });
});

describe('formatMemory', () => {
  it('counts groups with goal and exploring breakdown', () => {
    const view: MemoryViewPayload = {
      goalMessageId: 1,
      openQuestions: [msg({ id: 1, type: 'open_question' })],
      hypotheses: [], facts: [], boundaries: [], chains: [],
      exploring: [msg({ id: 2, type: 'exploring', exploringStatus: 'active' }), msg({ id: 3, type: 'exploring', exploringStatus: 'completed' })],
      completionProposals: [], challenges: [], verifies: [],
    };
    const text = formatMemory(view);
    expect(text).toContain('questions：1（其中目标 1）');
    expect(text).toContain('exploring：2（active 1 / completed 1）');
    expect(formatMemory(view, 'proposals')).toBe('proposals：没有条目');
  });
});

describe('misc', () => {
  it('escapes html and formats durations and times', () => {
    expect(escapeHtml('a & <b>')).toBe('a &amp; &lt;b&gt;');
    expect(formatDuration(125_400)).toBe('2m 5s');
    const now = new Date(2026, 9, 30, 12, 0);
    expect(formatTime(new Date(2026, 9, 30, 9, 5).toISOString(), now)).toBe('09:05');
    expect(formatTime(new Date(2026, 9, 29, 9, 5).toISOString(), now)).toBe('10-29 09:05');
  });
});

describe('splitMessage with an opening <pre> near the limit', () => {
  it('never exceeds the limit after closing the tag', () => {
    const html = ['a'.repeat(10), '<pre>bbbbbbbbbb', 'cccccccccc</pre>'].join('\n');
    for (const limit of [20, 25, 30, 33]) {
      for (const c of splitMessage(html, limit)) expect(c.length).toBeLessThanOrEqual(limit);
    }
  });
});
