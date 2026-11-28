// Inputs from the final package review (final-B-package-findings.md).
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { applyOps } from '../ops';
import { buildSnapshot } from '../snapshot';
import { renderStaticNodes } from '../static-render';
import { LiveBlockInputError, type SheetSnapshot } from '../snapshot';
import './register';
import { addSheet, createEmptyBook } from './model';
import {
  FIRST_TAB_ID,
  MAX_TAB_NAME,
  MAX_TABS_READ,
  readBook,
  seedSheet,
  setSetCellsBudgetForTests,
  sheetTabs,
} from './ydoc';

function docWith(cells: Record<string, string> = {}) {
  const book = createEmptyBook();
  book.sheets[0].id = FIRST_TAB_ID;
  for (const [key, v] of Object.entries(cells))
    book.sheets[0].cells[key] = { v };
  const doc = new Y.Doc();
  seedSheet(doc, book);
  return doc;
}
const tab = (doc: Y.Doc, id = FIRST_TAB_ID) =>
  sheetTabs(doc).get(id) as Y.Map<any>;
const ids = (doc: Y.Doc, axis: 'rows' | 'cols', id = FIRST_TAB_ID) =>
  (tab(doc, id).get(axis) as Y.Array<string>).toArray();

describe('final review: tab names (Critical 1)', () => {
  it('a tab name is capped on read, so a formula naming it cannot blow up', () => {
    const doc = docWith();
    tab(doc).set('name', 'n'.repeat(32_767) + ' x');
    const [r0, r1] = ids(doc, 'rows');
    const [c0, c1] = ids(doc, 'cols');
    const one = `{${FIRST_TAB_ID}!${c0},${r0}}`;
    tab(doc)
      .get('cells')
      .set(`${r1}:${c1}`, { v: '=' + Array(1500).fill(one).join('+') });
    const book = readBook(doc);
    expect(book.sheets[0].name.length).toBeLessThanOrEqual(MAX_TAB_NAME);
    // the decoded formula stays within the cell limit
    expect(book.sheets[0].cells['1:1'].v.length).toBeLessThanOrEqual(32_767);
    const snapshot = buildSnapshot('sheet', doc) as SheetSnapshot;
    expect(JSON.stringify(snapshot).length).toBeLessThan(1_000_000);
  });

  it('a formula whose decoded text passes the cell limit is an error value', () => {
    const doc = docWith();
    tab(doc).set('name', 'n'.repeat(MAX_TAB_NAME));
    const [r0, r1] = ids(doc, 'rows');
    const [c0, c1] = ids(doc, 'cols');
    const one = `{${FIRST_TAB_ID}!${c0},${r0}}`;
    // 1,000 references of about 105 characters each decode to over 100,000
    tab(doc)
      .get('cells')
      .set(`${r1}:${c1}`, { v: '=' + Array(1000).fill(one).join('+') });
    const cell = readBook(doc).sheets[0].cells['1:1'];
    expect(cell.v.length).toBeLessThanOrEqual(32_767);
    const snapshot = buildSnapshot('sheet', doc) as SheetSnapshot;
    expect(snapshot.display[FIRST_TAB_ID]['1:1']).toMatch(/^#/);
  });

  it('a book from outside with a tab name over the cap is refused', async () => {
    const { validateSnapshotInput } = await import('../snapshot');
    const book = createEmptyBook();
    book.sheets[0].name = 'n'.repeat(MAX_TAB_NAME + 1);
    expect(() => validateSnapshotInput('sheet', book)).toThrow(
      LiveBlockInputError,
    );
  });
});

describe('final review: number of tabs (Important 2)', () => {
  it('a document with 20,000 tabs of the same name reads at most the cap, uniquely named', () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      const order = doc.getArray<string>('order');
      const tabs = doc.getMap<Y.Map<unknown>>('sheets');
      const all: string[] = [];
      for (let i = 0; i < 20_000; i++) {
        const m = new Y.Map<unknown>();
        m.set('name', 'A');
        tabs.set(`t${i}`, m);
        all.push(`t${i}`);
      }
      order.push(all);
    });
    // a counter per name, not a scan from 2 for every tab
    let calls = 0;
    const lower = String.prototype.toLowerCase;
    String.prototype.toLowerCase = function () {
      calls++;
      return lower.call(this);
    };
    let book;
    try {
      book = readBook(doc);
    } finally {
      String.prototype.toLowerCase = lower;
    }
    expect(book.sheets).toHaveLength(MAX_TABS_READ);
    expect(new Set(book.sheets.map((s) => s.name.toLowerCase())).size).toBe(
      MAX_TABS_READ,
    );
    expect(calls).toBeLessThan(20 * MAX_TABS_READ);
    const snapshot = buildSnapshot('sheet', doc) as SheetSnapshot;
    expect(renderStaticNodes(snapshot, { title: 'x' }).length).toBeGreaterThan(
      0,
    );
  });
});

describe('final review: setCells work (Important 3)', () => {
  it('formulas pointing past the end of a full tab grow it once, reading its cells once', () => {
    // the reviewer's case (5,000 formulas into a 60 x 702 tab) took 271 s; the
    // cost was formulas x cells of the referenced tab. 500 formulas against
    // 60 x 100 cells show the same shape in a fraction of the time.
    const book = createEmptyBook();
    book.sheets[0].id = FIRST_TAB_ID;
    const data = addSheet(book, 'Data');
    data.rows = 60;
    data.cols = 100;
    for (let r = 0; r < 60; r++)
      for (let c = 0; c < 100; c++) data.cells[`${r}:${c}`] = { v: '1' };
    const doc = new Y.Doc();
    seedSheet(doc, book);
    const cells = Array.from({ length: 500 }, (_, i) => ({
      a1: `B${i + 1}`,
      value: `=Data!A${61 + i}`,
    }));
    const keys = Y.Map.prototype.keys;
    let read = 0;
    Y.Map.prototype.keys = function () {
      read += this.size;
      return keys.call(this);
    };
    try {
      applyOps('sheet', doc, [
        { type: 'sheet.setCells', sheetId: FIRST_TAB_ID, cells },
      ]);
    } finally {
      Y.Map.prototype.keys = keys;
    }
    // before the fix: 500 x 6,000 cell keys read; now at most a few passes
    expect(read).toBeLessThan(10 * 6_000);
    const out = readBook(doc);
    expect(out.sheets[1].rows).toBe(560);
    expect(out.sheets[0].cells['499:1'].v).toBe('=Data!A560');
  });

  it('a request whose formulas need more work than the budget is refused and writes nothing', () => {
    const doc = docWith();
    const before = Y.encodeStateAsUpdate(doc);
    // each formula names 3,000 distinct cells: 5,000 of them is past the budget
    const refs = Array.from({ length: 3000 }, (_, i) => `A${i + 1}`).join('+');
    const cells = Array.from({ length: 50 }, (_, i) => ({
      a1: `B${i + 1}`,
      value: '=' + refs,
    }));
    let error: unknown = null;
    const saved = setSetCellsBudgetForTests(50_000);
    try {
      applyOps('sheet', doc, [
        { type: 'sheet.setCells', sheetId: FIRST_TAB_ID, cells },
      ]);
    } catch (err) {
      error = err;
    } finally {
      setSetCellsBudgetForTests(saved);
    }
    expect(error).toBeInstanceOf(LiveBlockInputError);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });
});

describe('final review: setCells target tab (Important 4, Minor 14)', () => {
  it('writes into the tab it just created even when the name has spaces, never the first tab', () => {
    const doc = docWith({ '0:0': 'REVENUE' });
    applyOps('sheet', doc, [
      {
        type: 'sheet.setCells',
        sheetName: 'Budget ',
        createSheet: true,
        cells: [{ a1: 'A1', value: 'agent data' }],
      },
    ]);
    applyOps('sheet', doc, [
      {
        type: 'sheet.setCells',
        sheetName: 'Budget ',
        createSheet: true,
        cells: [{ a1: 'A2', value: 'again' }],
      },
    ]);
    applyOps('sheet', doc, [
      {
        type: 'sheet.setCells',
        createSheet: true,
        cells: [{ a1: "' Budget'!A3", value: 'by address' }],
      },
    ]);
    const book = readBook(doc);
    expect(book.sheets.map((s) => s.name)).toEqual(['Sheet1', 'Budget']);
    expect(book.sheets[0].cells['0:0'].v).toBe('REVENUE');
    expect(
      ['0:0', '1:0', '2:0'].map((k) => book.sheets[1].cells[k]?.v),
    ).toEqual(['agent data', 'again', 'by address']);
  });

  it('an empty document accepts the sheetId its snapshot reports', () => {
    const doc = new Y.Doc();
    const id = (buildSnapshot('sheet', doc) as SheetSnapshot).book.sheets[0].id;
    applyOps('sheet', doc, [
      {
        type: 'sheet.setCells',
        sheetId: id,
        cells: [{ a1: 'A1', value: 'x' }],
      },
    ]);
    expect(readBook(doc).sheets[0].cells['0:0'].v).toBe('x');
  });
});

describe('final review: format-only cells (Important 5)', () => {
  it('more than 10,000 empty formatted cells do not push values out of the snapshot', () => {
    const book = createEmptyBook();
    book.sheets[0].id = FIRST_TAB_ID;
    const s = book.sheets[0];
    s.rows = 300;
    for (let r = 0; r <= 100; r++)
      for (let c = 0; c < 100; c++)
        s.cells[`${r}:${c}`] = { v: '', f: { bold: true } };
    s.cells['200:0'] = { v: 'after the formats' };
    const other = addSheet(book, 'Later');
    other.cells['0:0'] = { v: 'later tab' };
    const doc = new Y.Doc();
    seedSheet(doc, book);
    const snapshot = buildSnapshot('sheet', doc) as SheetSnapshot;
    expect(snapshot.display[FIRST_TAB_ID]['200:0']).toBe('after the formats');
    expect(snapshot.book.sheets[0].cells['200:0'].v).toBe('after the formats');
    const later = snapshot.book.sheets[1].id;
    expect(snapshot.display[later]['0:0']).toBe('later tab');
  });
});

describe('refix N5: long tab names', () => {
  it('setCells refuses a tab name over 100 characters instead of cutting it', () => {
    const doc = docWith();
    const long = 'x'.repeat(101);
    for (const op of [
      {
        type: 'sheet.setCells',
        sheetName: long,
        createSheet: true,
        cells: [{ a1: 'A1', value: '1' }],
      },
      {
        type: 'sheet.setCells',
        createSheet: true,
        cells: [{ a1: `'${long}'!A1`, value: '1' }],
      },
    ]) {
      expect(() => applyOps('sheet', doc, [op as any])).toThrow(
        LiveBlockInputError,
      );
    }
    expect(readBook(doc).sheets).toHaveLength(1);
  });

  it('stored names that are the same once cut are numbered within the cap, and formulas keep their tab', () => {
    const doc = docWith();
    const base = 'n'.repeat(100);
    doc.transact(() => {
      for (const [id, tail] of [
        ['t2', 'A'],
        ['t3', 'B'],
      ]) {
        const m = new Y.Map<any>();
        m.set('name', base + tail);
        m.set('rows', Y.Array.from(['r' + id]));
        m.set('cols', Y.Array.from(['c' + id]));
        m.set('cells', new Y.Map());
        sheetTabs(doc).set(id, m);
        doc.getArray('order').push([id]);
      }
      (sheetTabs(doc).get('t3') as Y.Map<any>)
        .get('cells')
        .set('rt3:ct3', { v: 'from B' });
      tab(doc)
        .get('cells')
        .set(`${ids(doc, 'rows')[0]}:${ids(doc, 'cols')[0]}`, {
          v: '={t3!ct3,rt3}',
        });
    });
    const book = readBook(doc);
    const names = book.sheets.map((s) => s.name);
    expect(names[1]).toBe(base);
    expect(names[2].length).toBeLessThanOrEqual(100);
    expect(names[2]).not.toBe(names[1]);
    const snapshot = buildSnapshot('sheet', doc) as SheetSnapshot;
    expect(snapshot.display[FIRST_TAB_ID]['0:0']).toBe('from B');
  });
});

describe('refix N7: creating tabs from setCells', () => {
  it('a stale sheet1 entry outside the order does not break the first write', () => {
    const doc = new Y.Doc();
    doc.getMap('sheets').set(FIRST_TAB_ID, new Y.Map());
    applyOps('sheet', doc, [
      {
        type: 'sheet.setCells',
        sheetId: FIRST_TAB_ID,
        cells: [{ a1: 'A1', value: 'first' }],
      },
    ]);
    const book = readBook(doc);
    expect(book.sheets).toHaveLength(1);
    expect(book.sheets[0].cells['0:0'].v).toBe('first');
  });

  it('createSheet at the tab cap is refused with a clear message', () => {
    const book = createEmptyBook();
    for (let i = 1; i < MAX_TABS_READ; i++) addSheet(book, `T${i}`);
    const doc = new Y.Doc();
    seedSheet(doc, book);
    expect(() =>
      applyOps('sheet', doc, [
        {
          type: 'sheet.setCells',
          sheetName: 'One more',
          createSheet: true,
          cells: [{ a1: 'A1', value: 'x' }],
        },
      ]),
    ).toThrow(/at most 200 tabs/);
  });
});

describe('refix2 M1: tab cap on an empty document', () => {
  it('200 new tabs on an empty document is refused (the first tab makes 201)', () => {
    const doc = new Y.Doc();
    // one op naming 200 new tabs: with Sheet1 that would be 201
    const ops = [
      {
        type: 'sheet.setCells',
        createSheet: true,
        cells: Array.from({ length: 200 }, (_, i) => ({
          a1: `'T${i}'!A1`,
          value: 'x',
        })),
      },
    ];
    expect(() => applyOps('sheet', doc, ops as any)).toThrow(
      /at most 200 tabs/,
    );
  });
});
