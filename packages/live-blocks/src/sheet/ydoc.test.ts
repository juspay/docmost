import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { connect, docWithClientId } from '../testing/sync';
import { Engine } from './engine';
import {
  addSheet,
  createEmptyBook,
  mergeCells,
  newSheet,
  parseA1,
  renameSheet,
  setCellRaw,
  setColWidth,
  updateCellFormat,
  type Sheet,
  type SheetBook,
} from './model';
import {
  deleteCols,
  deleteRows,
  insertCols,
  insertRows,
  readBook,
  seedSheet,
  setCell,
  SHEET_LIMITS,
  writeBookChange,
  writeSheetChange,
} from './ydoc';

const LOCAL = Symbol('local');

function bookOf(
  cells: Record<string, string>,
  size: { rows?: number; cols?: number } = {},
): SheetBook {
  const book = createEmptyBook();
  const sheet = book.sheets[0];
  sheet.rows = size.rows ?? 20;
  sheet.cols = size.cols ?? 5;
  for (const [a1, v] of Object.entries(cells)) {
    const ref = parseA1(a1)!;
    setCellRaw(sheet, ref.row, ref.col, v);
  }
  return book;
}

function first(doc: Y.Doc): Sheet {
  return readBook(doc).sheets[0];
}

function raw(doc: Y.Doc, a1: string, tab = 0): string {
  const ref = parseA1(a1)!;
  return readBook(doc).sheets[tab].cells[`${ref.row}:${ref.col}`]?.v ?? '';
}

function column(doc: Y.Doc, col = 0): string[] {
  const sheet = first(doc);
  return Array.from(
    { length: sheet.rows },
    (_, r) => sheet.cells[`${r}:${col}`]?.v ?? '',
  );
}

function pair(book: SheetBook) {
  const a = docWithClientId(1);
  const b = docWithClientId(2);
  seedSheet(a, book);
  const link = connect(a, b);
  const sheetId = readBook(a).sheets[0].id;
  return { a, b, link, sheetId };
}

const tenValues = () => {
  const cells: Record<string, string> = {};
  for (let i = 1; i <= 10; i++) cells[`A${i}`] = `v${i}`;
  return bookOf(cells, { rows: 10, cols: 2 });
};

describe('sheet sync model', () => {
  it('seedSheet then readBook returns the same book', () => {
    const book = bookOf({ A1: '2', A2: '3', A3: '=SUM(A1:A2)', B1: 'x' });
    const sheet = book.sheets[0];
    updateCellFormat(sheet, 0, 1, { bold: true, numFmt: 'percent' });
    mergeCells(sheet, 4, 0, 5, 1);
    setColWidth(sheet, 2, 180);
    sheet.rowHeights['3'] = 40;
    sheet.frozenRows = 1;
    sheet.frozenCols = 1;
    const data = addSheet(book, 'Data');
    setCellRaw(data, 0, 0, '=Sheet1!A3*2');
    book.activeSheetId = sheet.id;

    const doc = new Y.Doc();
    seedSheet(doc, book);
    expect(readBook(doc)).toEqual(book);
    const engine = new Engine(readBook(doc));
    expect(engine.getValue(data.id, 0, 0)).toBe(10);
  });

  it('two people editing different cells both keep their values', () => {
    const { a, b, link, sheetId } = pair(bookOf({}));
    link.disconnect();
    setCell(a, sheetId, 0, 0, { v: 'from a' });
    setCell(b, sheetId, 1, 1, { v: 'from b' });
    link.reconnect();
    expect(readBook(a)).toEqual(readBook(b));
    for (const doc of [a, b]) {
      expect(raw(doc, 'A1')).toBe('from a');
      expect(raw(doc, 'B2')).toBe('from b');
    }
  });

  it('two people editing the same cell: one value wins on both sides', () => {
    const { a, b, link, sheetId } = pair(bookOf({}));
    link.disconnect();
    setCell(a, sheetId, 0, 0, { v: 'a' });
    setCell(b, sheetId, 0, 0, { v: 'b' });
    link.reconnect();
    expect(readBook(a)).toEqual(readBook(b));
    expect(['a', 'b']).toContain(raw(a, 'A1'));
    expect(raw(b, 'A1')).toBe(raw(a, 'A1'));
  });

  it('two concurrent row inserts give two rows', () => {
    const { a, b, link, sheetId } = pair(tenValues());
    link.disconnect();
    insertRows(a, sheetId, 2, 1);
    insertRows(b, sheetId, 5, 1);
    link.reconnect();
    expect(readBook(a)).toEqual(readBook(b));
    const expected = [
      'v1',
      'v2',
      '',
      'v3',
      'v4',
      'v5',
      '',
      'v6',
      'v7',
      'v8',
      'v9',
      'v10',
    ];
    for (const doc of [a, b]) {
      expect(first(doc).rows).toBe(12);
      expect(column(doc)).toEqual(expected);
    }
  });

  it('two concurrent row deletes remove both rows', () => {
    const { a, b, link, sheetId } = pair(tenValues());
    link.disconnect();
    deleteRows(a, sheetId, 2, 1);
    deleteRows(b, sheetId, 6, 1);
    link.reconnect();
    expect(readBook(a)).toEqual(readBook(b));
    const expected = ['v1', 'v2', 'v4', 'v5', 'v6', 'v8', 'v9', 'v10'];
    for (const doc of [a, b]) expect(column(doc)).toEqual(expected);
  });

  it('two concurrent column inserts and deletes both happen', () => {
    const { a, b, link, sheetId } = pair(
      bookOf({ A1: 'a', B1: 'b', C1: 'c', D1: 'd' }, { cols: 4 }),
    );
    link.disconnect();
    insertCols(a, sheetId, 1, 1);
    deleteCols(b, sheetId, 2, 1);
    link.reconnect();
    expect(readBook(a)).toEqual(readBook(b));
    for (const doc of [a, b]) {
      const sheet = first(doc);
      expect(sheet.cols).toBe(4);
      expect([0, 1, 2, 3].map((c) => sheet.cells[`0:${c}`]?.v ?? '')).toEqual([
        'a',
        '',
        'b',
        'd',
      ]);
    }
  });

  it('a cell edit concurrent with a row insert keeps every value', () => {
    const { a, b, link, sheetId } = pair(
      bookOf({ A5: 'a5', A6: 'a6', A7: 'a7' }),
    );
    link.disconnect();
    insertRows(a, sheetId, 5, 1); // above row 6
    setCell(b, sheetId, 6, 0, { v: 'x' }); // replaces a7
    link.reconnect();
    expect(readBook(a)).toEqual(readBook(b));
    for (const doc of [a, b]) {
      const values = column(doc);
      expect(values).toContain('a5');
      expect(values).toContain('a6');
      expect(values).not.toContain('a7');
      expect(values.filter((v) => v === 'x')).toHaveLength(1);
      expect(raw(doc, 'A8')).toBe('x'); // the row where a7 was
    }
  });

  it('a formula follows its cells through a concurrent insert', () => {
    const { a, b, link, sheetId } = pair(bookOf({ B1: '=SUM(A1:A3)' }));
    link.disconnect();
    insertRows(a, sheetId, 1, 1); // above row 2
    setCell(b, sheetId, 0, 1, { v: '=SUM(A1:A3)*2' });
    link.reconnect();
    expect(readBook(a)).toEqual(readBook(b));
    for (const doc of [a, b]) expect(raw(doc, 'B1')).toBe('=SUM(A1:A4)*2');
  });

  it('deleting a referenced row turns the reference into #REF!', () => {
    const doc = new Y.Doc();
    seedSheet(doc, bookOf({ A3: '5', B1: '=A3*2', B2: '=A4' }));
    const sheetId = first(doc).id;
    deleteRows(doc, sheetId, 2, 1);
    expect(raw(doc, 'B1')).toBe('=#REF!*2');
    expect(raw(doc, 'B2')).toBe('=A3');
  });

  it('undoing a row delete brings the row back with its cells', () => {
    const doc = new Y.Doc();
    seedSheet(doc, bookOf({ A3: '5', B1: '=A3*2' }));
    const sheetId = first(doc).id;
    const undo = new Y.UndoManager(
      [doc.getArray('order'), doc.getMap('sheets')],
      { trackedOrigins: new Set([LOCAL]) },
    );
    deleteRows(doc, sheetId, 2, 1, LOCAL);
    expect(raw(doc, 'A3')).toBe('');
    expect(first(doc).rows).toBe(19);
    undo.undo();
    expect(first(doc).rows).toBe(20);
    expect(raw(doc, 'A3')).toBe('5');
    expect(raw(doc, 'B1')).toBe('=A3*2');
  });

  it('a cross-tab reference survives renaming the tab', () => {
    const book = bookOf({ A1: '=Data!A1+1' });
    const data = addSheet(book, 'Data');
    setCellRaw(data, 0, 0, '41');
    book.activeSheetId = book.sheets[0].id;
    const doc = new Y.Doc();
    seedSheet(doc, book);
    const prev = readBook(doc);
    const next = structuredClone(prev);
    renameSheet(next, data.id, 'Facts');
    writeBookChange(doc, prev, next);
    const after = readBook(doc);
    expect(after.sheets[1].name).toBe('Facts');
    expect(raw(doc, 'A1')).toBe('=Facts!A1+1');
    expect(new Engine(after).getValue(after.sheets[0].id, 0, 0)).toBe(42);
  });

  it('growing past the limits throws; inserting past them throws', () => {
    const doc = new Y.Doc();
    seedSheet(doc, bookOf({}));
    const sheetId = first(doc).id;
    expect(SHEET_LIMITS).toEqual({ rows: 5000, cols: 702 });
    expect(() => setCell(doc, sheetId, 5000, 0, { v: 'x' })).toThrow();
    expect(() => setCell(doc, sheetId, 0, 702, { v: 'x' })).toThrow();
    setCell(doc, sheetId, 4999, 701, { v: 'corner' });
    expect(first(doc).rows).toBe(5000);
    expect(first(doc).cols).toBe(702);
    expect(() => insertRows(doc, sheetId, 0, 1)).toThrow();
    expect(() => insertCols(doc, sheetId, 0, 1)).toThrow();
    expect(first(doc).rows).toBe(5000);
  });

  it('a duplicated row id is read once', () => {
    const doc = new Y.Doc();
    seedSheet(doc, tenValues());
    const tab = doc.getMap<Y.Map<any>>('sheets').get(first(doc).id)!;
    const rows = tab.get('rows') as Y.Array<string>;
    rows.push([rows.get(2)]);
    rows.insert(0, [rows.get(4)]);
    expect(first(doc).rows).toBe(10);
    // the first occurrence counts: v5 moved to the top
    expect(column(doc)).toEqual([
      'v5',
      'v1',
      'v2',
      'v3',
      'v4',
      'v6',
      'v7',
      'v8',
      'v9',
      'v10',
    ]);
    // positional writes resolve through the same rule
    setCell(doc, first(doc).id, 0, 1, { v: 'next to v5' });
    expect(raw(doc, 'B1')).toBe('next to v5');
  });

  it('edits made while disconnected merge on reconnect', () => {
    const { a, b, link, sheetId } = pair(tenValues());
    link.disconnect();
    setCell(a, sheetId, 0, 1, { v: 'offline a' });
    insertRows(a, sheetId, 0, 2);
    setCell(b, sheetId, 9, 1, { v: 'offline b' });
    deleteRows(b, sheetId, 4, 1);
    link.reconnect();
    expect(readBook(a)).toEqual(readBook(b));
    for (const doc of [a, b]) {
      expect(first(doc).rows).toBe(11);
      expect(raw(doc, 'B3')).toBe('offline a');
      expect(raw(doc, 'B11')).toBe('offline b');
      expect(column(doc)).not.toContain('v5');
    }
    expect(readBook(a)).toEqual(readBook(b));
  });

  it('adding a tab and renaming another concurrently keeps both', () => {
    const { a, b, link } = pair(bookOf({}));
    link.disconnect();
    const prevA = readBook(a);
    const nextA = structuredClone(prevA);
    addSheet(nextA, 'Added');
    writeBookChange(a, prevA, nextA);
    const prevB = readBook(b);
    const nextB = structuredClone(prevB);
    renameSheet(nextB, prevB.sheets[0].id, 'Renamed');
    writeBookChange(b, prevB, nextB);
    link.reconnect();
    expect(readBook(a)).toEqual(readBook(b));
    for (const doc of [a, b]) {
      expect(readBook(doc).sheets.map((s) => s.name)).toEqual([
        'Renamed',
        'Added',
      ]);
    }
  });

  it('deleting a tab hides it and its references become #REF!', () => {
    const book = bookOf({ A1: '=Data!A1' });
    addSheet(book, 'Data');
    book.activeSheetId = book.sheets[0].id;
    const doc = new Y.Doc();
    seedSheet(doc, book);
    const prev = readBook(doc);
    const next = structuredClone(prev);
    next.sheets.splice(1, 1);
    writeBookChange(doc, prev, next);
    expect(readBook(doc).sheets).toHaveLength(1);
    expect(raw(doc, 'A1')).toBe('=#REF!');
  });

  it('reordering tabs keeps a tab added concurrently', () => {
    const book = bookOf({});
    addSheet(book, 'Two');
    addSheet(book, 'Three');
    const { a, b, link } = pair(book);
    link.disconnect();
    const prevA = readBook(a);
    const nextA = structuredClone(prevA);
    nextA.sheets.reverse();
    writeBookChange(a, prevA, nextA);
    const prevB = readBook(b);
    const nextB = structuredClone(prevB);
    addSheet(nextB, 'Four');
    writeBookChange(b, prevB, nextB);
    link.reconnect();
    expect(readBook(a)).toEqual(readBook(b));
    for (const doc of [a, b]) {
      const names = readBook(doc).sheets.map((s) => s.name);
      expect(names.slice(0, 3)).toEqual(['Three', 'Two', 'Sheet1']);
      expect(names).toContain('Four');
      expect(names).toHaveLength(4);
    }
  });

  it('writeSheetChange after a mutating function on a clone writes exactly the changed cells', () => {
    const doc = new Y.Doc();
    seedSheet(doc, bookOf({ A1: '1', A2: '2', B5: '=A1+A2', C3: 'keep' }));
    const tab = doc.getMap<Y.Map<any>>('sheets').get(first(doc).id)!;
    const cells = tab.get('cells') as Y.Map<unknown>;
    const changed: string[] = [];
    cells.observe((e) => changed.push(...e.keysChanged));

    const current = first(doc);
    const next = structuredClone(current);
    updateCellFormat(next, 0, 0, { bold: true });
    setCellRaw(next, 3, 3, '=B5*2');
    setCellRaw(next, 1, 0, '');
    writeSheetChange(doc, current, next);

    expect(changed).toHaveLength(3);
    const after = first(doc);
    expect(after.cells['0:0']).toEqual({ v: '1', f: { bold: true } });
    expect(after.cells['3:3']).toEqual({ v: '=B5*2' });
    expect(after.cells['1:0']).toBeUndefined();
    expect(after.cells['2:2']).toEqual({ v: 'keep' });
  });

  it('writeSheetChange writes merges, sizes and frozen counts by id', () => {
    const doc = new Y.Doc();
    seedSheet(doc, bookOf({ A1: 'top' }));
    const current = first(doc);
    const next = structuredClone(current);
    mergeCells(next, 0, 0, 1, 1);
    setColWidth(next, 1, 200);
    next.rowHeights['2'] = 50;
    next.frozenRows = 2;
    writeSheetChange(doc, current, next);
    insertRows(doc, current.id, 0, 1);
    insertCols(doc, current.id, 0, 1);
    const after = first(doc);
    expect(after.merges).toEqual([{ r1: 1, c1: 1, r2: 2, c2: 2 }]);
    expect(after.colWidths).toEqual({ '2': 200 });
    expect(after.rowHeights).toEqual({ '3': 50 });
    expect(after.frozenRows).toBe(3);

    const unmerged = structuredClone(after);
    unmerged.merges = [];
    writeSheetChange(doc, after, unmerged);
    expect(first(doc).merges).toEqual([]);
  });

  it('writeSheetChange refuses a change in row count', () => {
    const doc = new Y.Doc();
    seedSheet(doc, bookOf({}));
    const current = first(doc);
    const next = structuredClone(current);
    next.rows += 1;
    expect(() => writeSheetChange(doc, current, next)).toThrow();
    const wider = structuredClone(current);
    wider.cols -= 1;
    expect(() => writeSheetChange(doc, current, wider)).toThrow();
  });

  it('a formula past the end grows the tab and anchors there', () => {
    const doc = new Y.Doc();
    seedSheet(doc, bookOf({}, { rows: 5, cols: 2 }));
    const sheetId = first(doc).id;
    setCell(doc, sheetId, 0, 0, { v: '=SUM(D1:D9)' });
    expect(first(doc).rows).toBe(9);
    expect(first(doc).cols).toBe(4);
    insertRows(doc, sheetId, 0, 1);
    expect(raw(doc, 'A2')).toBe('=SUM(D2:D10)');
  });

  it('a merge whose corner row is deleted shrinks to the rows left', () => {
    const book = bookOf({ A1: 'x' });
    mergeCells(book.sheets[0], 0, 0, 2, 1);
    const doc = new Y.Doc();
    seedSheet(doc, book);
    deleteRows(doc, first(doc).id, 2, 1);
    expect(first(doc).merges).toEqual([{ r1: 0, c1: 0, r2: 1, c2: 1 }]);
    deleteRows(doc, first(doc).id, 0, 1);
    expect(first(doc).merges).toEqual([{ r1: 0, c1: 0, r2: 0, c2: 1 }]);
    // one cell left: no longer a merge
    deleteCols(doc, first(doc).id, 0, 1);
    expect(first(doc).merges).toEqual([]);
  });

  it('a new tab written through writeBookChange keeps its seeded content', () => {
    const doc = new Y.Doc();
    seedSheet(doc, bookOf({}));
    const prev = readBook(doc);
    const next = structuredClone(prev);
    const added = newSheet('Extra', 3, 3);
    setCellRaw(added, 2, 2, '=A1');
    next.sheets.push(added);
    writeBookChange(doc, prev, next);
    const after = readBook(doc);
    expect(after.sheets[1].rows).toBe(3);
    expect(after.sheets[1].cells['2:2']).toEqual({ v: '=A1' });
  });

  describe('concurrency (every case asserts both sides converge)', () => {
    const same = (x: Y.Doc, y: Y.Doc) =>
      expect(readBook(x)).toEqual(readBook(y));

    it('a cell edit concurrent with the delete of its row: the row is gone on both sides', () => {
      const { a, b, link, sheetId } = pair(tenValues());
      link.disconnect();
      setCell(a, sheetId, 4, 0, { v: 'edited v5' });
      deleteRows(b, sheetId, 4, 1);
      link.reconnect();
      same(a, b);
      expect(column(a)).not.toContain('edited v5');
      expect(column(a)).not.toContain('v5');
      expect(first(a).rows).toBe(9);
    });

    it('a formula written concurrently with the delete of the row it names shows #REF! on both sides', () => {
      const { a, b, link, sheetId } = pair(tenValues());
      link.disconnect();
      setCell(a, sheetId, 0, 1, { v: '=A5*2' });
      deleteRows(b, sheetId, 4, 1);
      link.reconnect();
      same(a, b);
      expect(raw(a, 'B1')).toBe('=#REF!*2');
    });

    it('a cell edit concurrent with a column insert and with a column delete', () => {
      const book = bookOf({ A1: 'a', B1: 'b', C1: 'c' }, { cols: 3 });
      const { a, b, link, sheetId } = pair(book);
      link.disconnect();
      setCell(a, sheetId, 1, 2, { v: 'under c' });
      insertCols(b, sheetId, 0, 1);
      link.reconnect();
      same(a, b);
      expect(raw(a, 'D2')).toBe('under c');
      link.disconnect();
      setCell(a, sheetId, 2, 1, { v: 'under a' });
      deleteCols(b, sheetId, 1, 1);
      link.reconnect();
      same(a, b);
      expect(first(a).cells['2:0']).toBeUndefined();
      expect(raw(a, 'C2')).toBe('under c');
    });

    it('two peers inserting at the same index get two rows in the same order', () => {
      const { a, b, link, sheetId } = pair(tenValues());
      link.disconnect();
      insertRows(a, sheetId, 3, 1);
      setCell(a, sheetId, 3, 0, { v: 'from a' });
      insertRows(b, sheetId, 3, 1);
      setCell(b, sheetId, 3, 0, { v: 'from b' });
      link.reconnect();
      same(a, b);
      const values = column(a);
      expect(values).toHaveLength(12);
      expect(values.slice(0, 3)).toEqual(['v1', 'v2', 'v3']);
      expect(values.slice(3, 5).sort()).toEqual(['from a', 'from b']);
      expect(values.slice(5)).toEqual([
        'v4',
        'v5',
        'v6',
        'v7',
        'v8',
        'v9',
        'v10',
      ]);
    });

    it('two peers deleting the same row remove one row', () => {
      const { a, b, link, sheetId } = pair(tenValues());
      link.disconnect();
      deleteRows(a, sheetId, 2, 1);
      deleteRows(b, sheetId, 2, 1);
      link.reconnect();
      same(a, b);
      expect(column(a)).toEqual([
        'v1',
        'v2',
        'v4',
        'v5',
        'v6',
        'v7',
        'v8',
        'v9',
        'v10',
      ]);
    });

    it('three peers inserting, deleting and typing at once converge', () => {
      const a = docWithClientId(1);
      const b = docWithClientId(2);
      const c = docWithClientId(3);
      seedSheet(a, tenValues());
      const ab = connect(a, b);
      const bc = connect(b, c);
      const sheetId = readBook(a).sheets[0].id;
      ab.disconnect();
      bc.disconnect();
      insertRows(a, sheetId, 0, 1);
      deleteRows(b, sheetId, 9, 1);
      setCell(c, sheetId, 5, 1, { v: 'beside v6' });
      ab.reconnect();
      bc.reconnect();
      ab.reconnect();
      same(a, b);
      same(b, c);
      expect(column(a)).toEqual([
        '',
        'v1',
        'v2',
        'v3',
        'v4',
        'v5',
        'v6',
        'v7',
        'v8',
        'v9',
      ]);
      expect(raw(c, 'B7')).toBe('beside v6');
    });

    it('undoing a row delete while another peer edits a cell of that row keeps the edit', () => {
      const { a, b, link, sheetId } = pair(tenValues());
      const undo = new Y.UndoManager(
        [a.getArray('order'), a.getMap('sheets')],
        {
          trackedOrigins: new Set([LOCAL]),
        },
      );
      // b edits v5's row while it is still there, then a deletes and restores it
      setCell(b, sheetId, 4, 1, { v: 'note on v5' });
      deleteRows(a, sheetId, 4, 1, LOCAL);
      undo.undo();
      same(a, b);
      expect(raw(a, 'A5')).toBe('v5');
      expect(raw(a, 'B5')).toBe('note on v5');
    });

    it('growing a tab concurrently keeps every value where it was written', () => {
      const { a, b, link, sheetId } = pair(bookOf({}, { rows: 5, cols: 2 }));
      link.disconnect();
      setCell(a, sheetId, 9, 0, { v: 'a at row 10' });
      setCell(b, sheetId, 7, 1, { v: 'b at row 8' });
      setCell(b, sheetId, 11, 0, { v: 'b at row 12' });
      link.reconnect();
      same(a, b);
      expect(raw(a, 'A10')).toBe('a at row 10');
      expect(raw(a, 'B8')).toBe('b at row 8');
      expect(raw(a, 'A12')).toBe('b at row 12');
      expect(first(a).rows).toBe(12);
    });

    it('concurrent growth to the limit stays within it', () => {
      const { a, b, link, sheetId } = pair(bookOf({}, { rows: 10, cols: 2 }));
      link.disconnect();
      setCell(a, sheetId, 4999, 0, { v: 'a' });
      insertRows(b, sheetId, 0, 3);
      link.reconnect();
      same(a, b);
      expect(first(a).rows).toBe(SHEET_LIMITS.rows);
    });

    it('moving a tab concurrently with deleting another does not bring the deleted one back', () => {
      const book = bookOf({});
      addSheet(book, 'Two');
      addSheet(book, 'Three');
      const { a, b, link } = pair(book);
      link.disconnect();
      const prevA = readBook(a);
      const nextA = structuredClone(prevA);
      const [moved] = nextA.sheets.splice(2, 1);
      nextA.sheets.unshift(moved);
      writeBookChange(a, prevA, nextA);
      const prevB = readBook(b);
      const nextB = structuredClone(prevB);
      nextB.sheets.splice(1, 1);
      writeBookChange(b, prevB, nextB);
      link.reconnect();
      same(a, b);
      expect(readBook(a).sheets.map((s) => s.name)).toEqual([
        'Three',
        'Sheet1',
      ]);
    });

    it('frozen rows follow their rows through a concurrent insert above them', () => {
      const { a, b, link, sheetId } = pair(tenValues());
      link.disconnect();
      // b freezes the first two rows (v1, v2) while a inserts a row above them
      const prev = first(b);
      const next = structuredClone(prev);
      next.frozenRows = 2;
      writeSheetChange(b, prev, next);
      insertRows(a, sheetId, 0, 1);
      link.reconnect();
      same(a, b);
      // v1 and v2 are rows 2 and 3 now: everything above v3 stays frozen
      expect(first(a).frozenRows).toBe(3);
    });
  });

  it('a tab whose rows all went in concurrent deletes reads as one row', () => {
    const { a, b, link, sheetId } = pair(
      bookOf({ A1: 'x' }, { rows: 2, cols: 1 }),
    );
    link.disconnect();
    deleteRows(a, sheetId, 0, 1);
    deleteRows(b, sheetId, 1, 1);
    link.reconnect();
    expect(readBook(a)).toEqual(readBook(b));
    expect(first(a).rows).toBe(1);
    const prev = first(a);
    const next = structuredClone(prev);
    setCellRaw(next, 0, 0, 'again');
    writeSheetChange(a, prev, next);
    expect(raw(a, 'A1')).toBe('again');
  });

  it('tabs with the same name read with distinct names, and formulas use them', () => {
    const { a, b, link } = pair(bookOf({}));
    link.disconnect();
    for (const doc of [a, b]) {
      const prev = readBook(doc);
      const next = structuredClone(prev);
      addSheet(next, 'Data');
      writeBookChange(doc, prev, next);
    }
    link.reconnect();
    expect(readBook(a)).toEqual(readBook(b));
    const names = readBook(a).sheets.map((s) => s.name);
    expect(names).toEqual(['Sheet1', 'Data', 'Data (2)']);
    const second = readBook(a).sheets[2].id;
    setCell(a, second, 0, 0, { v: '9' });
    setCell(a, readBook(a).sheets[0].id, 0, 0, {
      v: '="Data (2)"&\'Data (2)\'!A1',
    });
    expect(raw(a, 'A1')).toBe('="Data (2)"&\'Data (2)\'!A1');
  });

  it('a format written by another client is normalised on read', () => {
    const doc = new Y.Doc();
    seedSheet(doc, bookOf({ A1: 'x' }));
    const sheetId = first(doc).id;
    const tab = doc.getMap<Y.Map<any>>('sheets').get(sheetId)!;
    const cells = tab.get('cells') as Y.Map<any>;
    const [key] = [...cells.keys()];
    const evil = 'left;position:fixed;inset:0;background:url(https://evil/x)';
    cells.set(key, {
      v: 'x',
      f: {
        align: evil,
        valign: evil,
        color: evil,
        bg: evil,
        font: evil,
        extra: evil,
        bold: true,
      },
    });
    const f = first(doc).cells['0:0'].f;
    expect(f).toEqual({ bold: true });
    expect(JSON.stringify(readBook(doc))).not.toContain('evil');
  });

  it('cell values are capped at 32,767 characters and tab names at 100', () => {
    const doc = new Y.Doc();
    seedSheet(doc, bookOf({}));
    const sheetId = first(doc).id;
    setCell(doc, sheetId, 0, 0, { v: 'x'.repeat(40_000) });
    expect(raw(doc, 'A1')).toHaveLength(32_767);
    const prev = readBook(doc);
    const next = structuredClone(prev);
    addSheet(next, 'n'.repeat(40_000));
    writeBookChange(doc, prev, next);
    expect(readBook(doc).sheets[1].name).toHaveLength(100);
  });
});
