import { describe, expect, it, vi } from 'vitest';
import { decodeFormula, type RefContext } from './refs';

const ctx: RefContext = {
  sheetId: 's1',
  rowId: () => null,
  colId: () => null,
  rowIndex: (_t, id) => (id === 'r0' ? 0 : id === 'r1' ? 1 : null),
  colIndex: (_t, id) => (id === 'c0' ? 0 : null),
  sheetIdByName: () => null,
  sheetName: (id) => (id === 's1' ? 'Sheet1' : id === 's2' ? 'My Data' : null),
};

describe('decode: a range whose second end is gone (refix N1)', () => {
  it('collapses to one #REF!, keeping what came before the range', () => {
    expect(decodeFormula('=SUM({c0,r0}:{c0,gone})', ctx)).toBe('=SUM(#REF!)');
    expect(decodeFormula('=SUM({s2!$c0,$r0}:{s2!c0,gone})+1', ctx)).toBe(
      '=SUM(#REF!)+1',
    );
    expect(decodeFormula('="AB1"&{c0,r1}:{c0,gone}', ctx)).toBe('="AB1"&#REF!');
  });

  it('does linear work: no backward search over the decoded text', () => {
    // a 20,000-letter literal before three such ranges took over 20 s with
    // the backward regex; now the regex work does not grow with the text
    const one = 'SUM({c0,r0}:{c0,gone})';
    const calls = (letters: number) => {
      const stored =
        '="' + 'A'.repeat(letters) + '"&' + [one, one, one].join('&');
      const replace = vi.spyOn(String.prototype, 'replace');
      const exec = vi.spyOn(RegExp.prototype, 'exec');
      try {
        const out = decodeFormula(stored, ctx);
        expect(out.endsWith('SUM(#REF!)&SUM(#REF!)&SUM(#REF!)')).toBe(true);
        expect(replace).not.toHaveBeenCalled();
        return exec.mock.calls.length;
      } finally {
        replace.mockRestore();
        exec.mockRestore();
      }
    };
    expect(calls(20_000)).toBe(calls(20));
  });

  it('copies each range once: work grows with the formula, not with ranges x output (refix2 I1)', () => {
    const copied = (stored: string) => {
      const slice = vi.spyOn(String.prototype, 'slice');
      try {
        decodeFormula(stored, ctx);
        // characters taken out of strings while decoding
        return slice.mock.results.reduce(
          (n, r) => n + String(r.value).length,
          0,
        );
      } finally {
        slice.mockRestore();
      }
    };
    for (const one of ['{c0,r0}:{c0,gone}', '{c0,r0}:{c0,r1}']) {
      const stored = '=' + Array(3000).fill(one).join('+');
      // one copy of the body, plus each part once
      expect(copied(stored)).toBeLessThan(3 * stored.length);
    }
  });

  it('a chain whose first end is gone collapses whole (refix3 m1)', () => {
    expect(decodeFormula('=SUM({c0,gone}:{c0,r0}:{c0,r1})', ctx)).toBe(
      '=SUM(#REF!)',
    );
  });
});
