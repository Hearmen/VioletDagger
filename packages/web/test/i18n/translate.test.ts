import { describe, it, expect } from 'vitest';
import { createT, interpolate } from '../../src/i18n/translate';
import { renderText } from '../../src/i18n/types';

describe('interpolate', () => {
  it('replaces provided placeholders', () => {
    expect(interpolate('{n} min ago', { n: 3 })).toBe('3 min ago');
  });

  it('keeps placeholders that were not provided', () => {
    expect(interpolate('{current}/{max} sessions', { current: 1 })).toBe('1/{max} sessions');
  });
});

describe('createT', () => {
  it('returns the text of the requested locale', () => {
    expect(createT('zh')('format.minutesAgo', { n: 5 })).toBe('5 分钟前');
    expect(createT('en')('format.minutesAgo', { n: 5 })).toBe('5 min ago');
  });
});

describe('renderText', () => {
  it('translates keys and passes raw text through unchanged', () => {
    const t = createT('en');
    expect(renderText({ kind: 'key', key: 'common.unknownError' }, t)).toBe('unknown error');
    expect(renderText({ kind: 'raw', text: '服务端错误' }, t)).toBe('服务端错误');
  });
});
