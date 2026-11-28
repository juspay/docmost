import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Engine } from './engine';
import { addSheet, createEmptyBook, parseA1, setCellRaw } from './model';
import { deleteCols, deleteRows, readBook, seedSheet } from './ydoc';

function doc(
  cells: Record<string, string>,
  other: Record<string, string> = {},
) {
  const book = createEmptyBook();
  for (const [a1, v] of Object.entries(cells)) {
    const p = parseA1(a1)!;
    setCellRaw(book.sheets[0], p.row, p.col, v);
  }
  const data = addSheet(book, 'Data');
  for (const [a1, v] of Object.entries(other)) {
    const p = parseA1(a1)!;
    setCellRaw(data, p.row, p.col, v);
  }
  const d = new Y.Doc();
  seedSheet(d, book);
  return d;
}
const raw = (d: Y.Doc, a1: string, tab = 0) => {
  const p = parseA1(a1)!;
  return readBook(d).sheets[tab].cells[`${p.row}:${p.col}`]?.v;
};
const shown = (d: Y.Doc, a1: string, tab = 0) => {
  const book = readBook(d);
  const p = parseA1(a1)!;
  return new Engine(book).display(book.sheets[tab].id, p.row, p.col);
};
const tabId = (d: Y.Doc, tab = 0) => readBook(d).sheets[tab].id;
const five = { A1: '1', A2: '2', A3: '3', A4: '4', A5: '5' };

describe('deleting an end of a range (final review, Important 7)', () => {
  it('the last row: =SUM(A1:A5) minus row 5 is =SUM(A1:A4)', () => {
    const d = doc({ ...five, A7: '=SUM(A1:A5)' });
    deleteRows(d, tabId(d), 4, 1);
    expect(raw(d, 'A6')).toBe('=SUM(A1:A4)');
    expect(shown(d, 'A6')).toBe('10');
  });

  it('the first row shrinks the range from the top', () => {
    const d = doc({ ...five, A7: '=SUM(A1:A5)' });
    deleteRows(d, tabId(d), 0, 1);
    expect(raw(d, 'A6')).toBe('=SUM(A1:A4)');
    expect(shown(d, 'A6')).toBe('14');
  });

  it('first and last columns, absolute references kept absolute', () => {
    const d = doc({
      A1: '1',
      B1: '2',
      C1: '3',
      D1: '4',
      F3: '=SUM($A$1:$D$1)',
    });
    deleteCols(d, tabId(d), 3, 1);
    expect(raw(d, 'E3')).toBe('=SUM($A$1:$C$1)');
    deleteCols(d, tabId(d), 0, 1);
    expect(raw(d, 'D3')).toBe('=SUM($A$1:$B$1)');
    expect(shown(d, 'D3')).toBe('5');
  });

  it('a reference from another tab shrinks too', () => {
    const d = doc(
      { A1: '=SUM(Data!B2:B6)' },
      { B2: '1', B3: '1', B4: '1', B5: '1', B6: '1' },
    );
    deleteRows(d, tabId(d, 1), 5, 1);
    expect(raw(d, 'A1')).toBe('=SUM(Data!B2:B5)');
    deleteRows(d, tabId(d, 1), 1, 1);
    expect(raw(d, 'A1')).toBe('=SUM(Data!B2:B4)');
    expect(shown(d, 'A1')).toBe('3');
  });

  it('deleting the whole range is #REF!, an error and not a parse error', () => {
    const d = doc({ ...five, C1: '=SUM(A2:A3)' });
    deleteRows(d, tabId(d), 1, 2);
    expect(raw(d, 'C1')).toBe('=SUM(#REF!)');
    expect(shown(d, 'C1')).toBe('#REF!');
  });

  it('a single reference to a deleted cell shows #REF!', () => {
    const d = doc({ ...five, C1: '=A5*2' });
    deleteRows(d, tabId(d), 4, 1);
    expect(raw(d, 'C1')).toBe('=#REF!*2');
    expect(shown(d, 'C1')).toBe('#REF!');
  });
});
