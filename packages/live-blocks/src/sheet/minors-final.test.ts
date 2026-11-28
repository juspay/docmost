// Minor findings from the final package review that are wrong results or unbounded work.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { applyOps } from '../ops';
import {
  buildSnapshot,
  LiveBlockInputError,
  type SheetSnapshot,
  validateSnapshotInput,
} from '../snapshot';
import { renderStaticNodes } from '../static-render';
import './register';
import { Engine } from './engine';
import { createEmptyBook, MAX_COL_WIDTH, MIN_COL_WIDTH } from './model';
import { FIRST_TAB_ID, readBook, seedSheet, sheetTabs } from './ydoc';

function docOf(
  cells: Record<string, { v: string; f?: any }>,
  rows = 60,
  cols = 26,
) {
  const book = createEmptyBook();
  book.sheets[0].id = FIRST_TAB_ID;
  Object.assign(book.sheets[0], { rows, cols, cells });
  const doc = new Y.Doc();
  seedSheet(doc, book);
  return doc;
}
const tab = (doc: Y.Doc) => sheetTabs(doc).get(FIRST_TAB_ID) as Y.Map<any>;
const ids = (doc: Y.Doc, axis: 'rows' | 'cols') =>
  (tab(doc).get(axis) as Y.Array<string>).toArray();

describe('final review minors', () => {
  it('16: MIN and MAX over 150,000 numbers', () => {
    const cells: Record<string, { v: string }> = {};
    for (let r = 0; r < 5000; r++)
      for (let c = 0; c < 30; c++)
        cells[`${r}:${c}`] = { v: String(r * 30 + c) };
    const book = createEmptyBook();
    Object.assign(book.sheets[0], { rows: 5000, cols: 40, cells });
    book.sheets[0].cells['0:35'] = { v: '=MAX(A1:AD5000)' };
    book.sheets[0].cells['1:35'] = { v: '=MIN(A1:AD5000)' };
    const e = new Engine(book);
    expect(e.getValue(book.sheets[0].id, 0, 35)).toBe(149_999);
    expect(e.getValue(book.sheets[0].id, 1, 35)).toBe(0);
  }, 30_000);

  it('17: overflow and invalid dates show #NUM!, never Infinity or NaN', () => {
    const book = createEmptyBook();
    const s = book.sheets[0];
    s.cells['0:0'] = { v: '=1e308*10', f: { numFmt: 'number' } };
    s.cells['1:0'] = { v: '=1e308*10-1e308*10' };
    s.cells['2:0'] = { v: '1e300', f: { numFmt: 'date' } };
    s.cells['3:0'] = { v: '=ROUND(1.5,400)', f: { numFmt: 'currency' } };
    const e = new Engine(book);
    const shown = [0, 1, 2, 3].map((r) => e.display(s.id, r, 0));
    expect(shown).toEqual(['#NUM!', '#NUM!', '#NUM!', shown[3]]);
    expect(shown[3]).not.toMatch(/NaN|Infinity/);
  });

  it('18: overlapping merges from two people keep every cell in the export', () => {
    const doc = docOf({
      '0:0': { v: 'a' },
      '0:1': { v: 'b' },
      '0:2': { v: 'c' },
      '1:2': { v: 'c2' },
    });
    const [r0, r1] = ids(doc, 'rows');
    const [c0, c1, c2] = ids(doc, 'cols');
    const merges = tab(doc).get('merges') as Y.Map<any>;
    merges.set('m1', { r1: r0, c1: c0, r2: r1, c2: c1 });
    merges.set('m2', { r1: r0, c1: c1, r2: r1, c2: c2 });
    expect(readBook(doc).sheets[0].merges).toHaveLength(1);
    const snapshot = buildSnapshot('sheet', doc) as SheetSnapshot;
    const text = JSON.stringify(renderStaticNodes(snapshot, { title: 'x' }));
    expect(text).toContain('"c2"');
  });

  it('19: sizes read from a document are clamped', () => {
    const doc = docOf({});
    const [c0, c1] = ids(doc, 'cols');
    const [r0] = ids(doc, 'rows');
    (tab(doc).get('colWidths') as Y.Map<number>).set(c0, -500);
    (tab(doc).get('colWidths') as Y.Map<number>).set(c1, 1e9);
    (tab(doc).get('rowHeights') as Y.Map<number>).set(r0, 1e9);
    const s = readBook(doc).sheets[0];
    expect(s.colWidths['0']).toBe(MIN_COL_WIDTH);
    expect(s.colWidths['1']).toBe(MAX_COL_WIDTH);
    expect(s.rowHeights['0']).toBeLessThanOrEqual(400);
  });

  it('20, 21: a book with an invalid tab id or a repeated name is refused', () => {
    for (const sheets of [
      [{ id: '__proto__', name: 'A' }],
      [{ id: 'my tab', name: 'A' }],
      [
        { id: 'a', name: 'Same' },
        { id: 'b', name: 'same ' },
      ],
    ]) {
      expect(
        () => validateSnapshotInput('sheet', { sheets }),
        JSON.stringify(sheets),
      ).toThrow(LiveBlockInputError);
    }
  });

  it('22: a book with more than 10,000 merges is refused', () => {
    const merges = Array.from({ length: 10_001 }, (_, i) => ({
      r1: i % 5000,
      c1: 2 * Math.floor(i / 5000),
      r2: i % 5000,
      c2: 2 * Math.floor(i / 5000) + 1,
    }));
    expect(() =>
      validateSnapshotInput('sheet', {
        sheets: [{ id: 's', name: 'S', rows: 5000, cols: 26, merges }],
      }),
    ).toThrow(LiveBlockInputError);
  });

  it('24: a tab without rows or columns can be written and is not a TypeError', () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      doc.getMap('sheets').set(FIRST_TAB_ID, new Y.Map());
      doc.getArray('order').push([FIRST_TAB_ID]);
    });
    applyOps('sheet', doc, [
      {
        type: 'sheet.setCells',
        sheetId: FIRST_TAB_ID,
        cells: [{ a1: 'B2', value: 'x' }],
      },
    ]);
    expect(readBook(doc).sheets[0].cells['1:1'].v).toBe('x');
  });

  it('N2: many merges are read up to the cap, comparing each with few others', () => {
    const doc = docOf({}, 5000, 702);
    const rows = ids(doc, 'rows');
    const cols = ids(doc, 'cols');
    const merges = tab(doc).get('merges') as Y.Map<any>;
    // 30,000 side-by-side 1x2 merges (none overlap), written by a peer
    doc.transact(() => {
      for (let i = 0; i < 30_000; i++) {
        const r = i % 5000;
        const c = 2 * Math.floor(i / 5000);
        merges.set(`m${String(i).padStart(6, '0')}`, {
          r1: rows[r],
          c1: cols[c],
          r2: rows[r],
          c2: cols[c + 1],
        });
      }
    });
    let compares = 0;
    const some = Array.prototype.some;
    Array.prototype.some = function (this: unknown[], fn: any) {
      compares += this.length;
      return some.call(this, fn);
    };
    let read;
    try {
      read = readBook(doc).sheets[0].merges;
    } finally {
      Array.prototype.some = some;
    }
    expect(read).toHaveLength(10_000);
    // all against all would be 10,000 x 10,000 / 2
    expect(compares).toBeLessThan(5_000_000);
  });

  it('B20: a tab with the id __proto__ written by a peer is not read', () => {
    const doc = docOf({ '0:0': { v: 'kept' } });
    doc.transact(() => {
      const m = new Y.Map<any>();
      m.set('name', 'Evil');
      sheetTabs(doc).set('__proto__', m);
      doc.getArray('order').push(['__proto__']);
    });
    const book = readBook(doc);
    expect(book.sheets.map((s) => s.id)).toEqual([FIRST_TAB_ID]);
    const snapshot = buildSnapshot('sheet', doc) as SheetSnapshot;
    expect(Object.keys(snapshot.display)).toEqual([FIRST_TAB_ID]);
    expect(snapshot.display[FIRST_TAB_ID]['0:0']).toBe('kept');
  });

  it('B21: names with spaces or empty names give the same snapshot as the seeded document', () => {
    const input = {
      sheets: [
        { id: 'a', name: ' A ', cells: { '0:0': { v: '5' } } },
        { id: 'b', name: '', cells: { '0:0': { v: '=A!A1*2' } } },
        { id: 'c', name: 'Sheet1' },
      ],
    };
    const snapshot = validateSnapshotInput('sheet', input) as SheetSnapshot;
    const doc = new Y.Doc();
    seedSheet(doc, snapshot.book);
    const seeded = readBook(doc);
    expect(snapshot.book.sheets.map((s) => s.name)).toEqual(
      seeded.sheets.map((s) => s.name),
    );
    expect(snapshot.display.b['0:0']).toBe('10');
  });

  it('B24/N4: a formula pointing into another tab without rows or columns is not a TypeError', () => {
    const doc = docOf({});
    doc.transact(() => {
      const m = new Y.Map<any>();
      m.set('name', 'Other');
      sheetTabs(doc).set('other', m);
      doc.getArray('order').push(['other']);
    });
    applyOps('sheet', doc, [
      {
        type: 'sheet.setCells',
        sheetId: FIRST_TAB_ID,
        cells: [{ a1: 'A1', value: '=Other!B9' }],
      },
    ]);
    expect(readBook(doc).sheets[0].cells['0:0'].v).toBe('=Other!B9');
  });

  it('B17: time and duration formats show #NUM! for numbers they cannot show', () => {
    const book = createEmptyBook();
    const s = book.sheets[0];
    s.cells['0:0'] = { v: '1e300', f: { numFmt: 'time' } };
    s.cells['1:0'] = { v: '1e304', f: { numFmt: 'duration' } };
    s.cells['2:0'] = { v: '0.5', f: { numFmt: 'time' } };
    const e = new Engine(book);
    expect([0, 1, 2].map((r) => e.display(s.id, r, 0))).toEqual([
      '#NUM!',
      '#NUM!',
      '12:00:00',
    ]);
  });

  it('I2: 10,000 merges in one band of rows cost work bounded by their cells', () => {
    const doc = docOf({}, 60, 702);
    const rows = ids(doc, 'rows');
    const cols = ids(doc, 'cols');
    const merges = tab(doc).get('merges') as Y.Map<any>;
    // 1x2 merges packed into rows 0-49: all in one band of rows
    doc.transact(() => {
      for (let i = 0; i < 10_000; i++) {
        const r = i % 50;
        const c = 2 * Math.floor(i / 50);
        merges.set(`m${String(i).padStart(6, '0')}`, {
          r1: rows[r],
          c1: cols[c],
          r2: rows[r],
          c2: cols[c + 1],
        });
      }
    });
    // count every overlap test: a Set lookup or an array element compared
    let work = 0;
    const has = Set.prototype.has;
    const some = Array.prototype.some;
    Set.prototype.has = function (v: unknown) {
      work++;
      return has.call(this, v);
    };
    Array.prototype.some = function (this: unknown[], fn: any) {
      work += this.length;
      return some.call(this, fn);
    };
    let read;
    try {
      read = readBook(doc).sheets[0].merges;
    } finally {
      Set.prototype.has = has;
      Array.prototype.some = some;
    }
    expect(read).toHaveLength(10_000);
    // all against all would be 5 x 10^7 comparisons
    expect(work).toBeLessThan(200_000);
  });

  it('M3: a book with more than 1,000,000 cells is refused before it is seeded', () => {
    const cells: Record<string, { v: string }> = {};
    for (let i = 0; i <= 1_000_000; i++)
      cells[`${i % 5000}:${Math.floor(i / 5000)}`] = { v: '1' };
    expect(() =>
      validateSnapshotInput('sheet', {
        sheets: [{ id: 's', name: 'S', rows: 5000, cols: 702, cells }],
      }),
    ).toThrow(/more than 1000000 cells/);
  });
});
