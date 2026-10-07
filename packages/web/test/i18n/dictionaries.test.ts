import { describe, it, expect } from 'vitest';
import { en } from '../../src/i18n/en';
import { zh } from '../../src/i18n/zh';

describe('dictionaries', () => {
  it('have the same key set', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  });

  it('contain no Chinese in the English dictionary (except the toggle target, which names Chinese)', () => {
    const offenders = Object.entries(en)
      .filter(([key]) => key !== 'common.localeToggleTarget')
      .filter(([, text]) => /[一-鿿]/.test(text));
    expect(offenders).toEqual([]);
  });
});
