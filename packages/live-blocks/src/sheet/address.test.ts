import { describe, expect, it } from 'vitest';
import { parseCellAddress } from './address';

describe('parseCellAddress', () => {
  it('parseCellAddress reads B3, $B$3 and Sheet2!A1; rejects A0 and 3B', () => {
    expect(parseCellAddress('B3')).toEqual({ row: 2, col: 1 });
    expect(parseCellAddress('$B$3')).toEqual({ row: 2, col: 1 });
    expect(parseCellAddress('Sheet2!A1')).toEqual({
      sheetName: 'Sheet2',
      row: 0,
      col: 0,
    });
    expect(parseCellAddress("'My ''big'' sheet'!C4")).toEqual({
      sheetName: "My 'big' sheet",
      row: 3,
      col: 2,
    });
    expect(parseCellAddress('A0')).toBeNull();
    expect(parseCellAddress('3B')).toBeNull();
    expect(parseCellAddress('!A1')).toBeNull();
    expect(parseCellAddress('')).toBeNull();
  });
});
