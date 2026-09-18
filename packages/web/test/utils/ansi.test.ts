import { describe, it, expect } from 'vitest';
import { stripAnsi, createAnsiFilter } from '../../src/utils/ansi';

describe('stripAnsi', () => {
  it('removes CSI color sequences', () => {
    expect(stripAnsi('\u001b[0m⚙ \u001b[32mtool\u001b[0m')).toBe('⚙ tool');
  });

  it('removes OSC sequences and other control characters', () => {
    expect(stripAnsi('a\u001b]0;title\u0007b\u0008c')).toBe('abc');
    expect(stripAnsi('a\u0007b')).toBe('ab');
  });

  it('normalizes carriage returns to newlines and keeps tabs/newlines', () => {
    expect(stripAnsi('a\r\nb\rc\td')).toBe('a\nb\nc\td');
  });
});

describe('createAnsiFilter', () => {
  it('buffers an escape sequence split across chunks', () => {
    const filter = createAnsiFilter();
    expect(filter('\u001b[')).toBe('');
    expect(filter('0mhello')).toBe('hello');
  });

  it('handles a complete sequence within one chunk', () => {
    const filter = createAnsiFilter();
    expect(filter('\u001b[0mhello')).toBe('hello');
  });

  it('keeps plain text intact across chunks', () => {
    const filter = createAnsiFilter();
    expect(filter('foo ')).toBe('foo ');
    expect(filter('bar\n')).toBe('bar\n');
  });
});
